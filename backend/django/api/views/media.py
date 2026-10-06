"""Stateless image helpers: auto-orientation detection and HEIC-to-JPEG conversion."""
import os
import logging
from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import extend_schema, OpenApiResponse, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from ..permissions import IsAuthenticatedWithAPIKey

logger = logging.getLogger(__name__)


class OrientationDetectView(APIView):
    """
    POST /api/orientation/detect  — synchronous server-side auto-orientation.

    Frontend sends each uploaded file's bytes (multipart) while building
    canvases; backend runs MediaPipe Pose Landmarker inline and returns
    the suggested rotation immediately. No DB writes, no Celery
    round-trip, no temp files persisted — the file bytes are decoded,
    inferenced, and discarded.

    Why inline (not Celery): the rotation must be applied to the
    in-editor preview before the customer interacts with the canvas, so
    by the time the chunked upload at submit-time happens it's too late.
    The customer's experience is "drop file → see correctly-oriented
    preview". Inference is fast enough (~30–150 ms on CPU) that holding
    a gunicorn thread is acceptable.

    Why not Celery: a separate ml-worker container would force frontend
    polling, which we'd have to wait out before drawing the canvas.
    Worse UX, no measurable benefit at this scale.

    Returns 503 when AUTO_ORIENTATION_MODE=off so the frontend short-
    circuits and uses its aspect-ratio heuristic. Returns 204 when the
    model couldn't find a confident pose (food, landscape, occluded
    subject) so the caller falls back to the same heuristic.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]
    # Default DRF parsers (incl. MultiPartParser) are enough — frontend
    # sends a single 'file' field as multipart/form-data.

    @extend_schema(
        tags=["upload"],
        summary="Detect rotation for a single photo",
        description=(
            "Runs pose detection on one photo and returns the cardinal rotation "
            "needed to stand its subject upright. **Stateless — nothing is "
            "persisted.**\n\n"
            "This catches photos whose subject is sideways *in the bytes* — camera "
            "held wrong, scanned prints, messaging apps that strip EXIF — which no "
            "aspect-ratio heuristic can detect.\n\n"
            "**When no pose is found** (food, landscape, an occluded subject) the "
            "response is **204 with no body** — not a rotation of 0. Callers must "
            "branch on the status code and fall back to their own heuristic; "
            "parsing the body unconditionally will fail here.\n\n"
            "Returns **503** when `AUTO_ORIENTATION_MODE=off`. Clients should read "
            "`/api/config` first and skip the upload entirely in that case; a 503 "
            "here produces the same outcome either way."
        ),
        request={"multipart/form-data": inline_serializer(
            name="OrientationDetect",
            fields={"file": drf_serializers.FileField(help_text="The image to analyse.")},
        )},
        responses={
            200: inline_serializer(
                name="OrientationResult",
                fields={
                    "rotation": drf_serializers.ChoiceField(choices=[0, 90, 180, 270],
                                                            help_text="Degrees to rotate for an upright subject."),
                    "confidence": drf_serializers.FloatField(),
                    "source": drf_serializers.CharField(help_text="Which detector produced the answer."),
                },
            ),
            204: OpenApiResponse(description="No pose detected — no body. Apply your own heuristic."),
            400: OpenApiResponse(description="No `file` field, or the image could not be read."),
            503: OpenApiResponse(description="Auto-orientation is switched off for this deployment."),
        },
    )
    def post(self, request):
        if getattr(settings, "AUTO_ORIENTATION_MODE", "mediapipe") == "off":
            return Response(
                {'detail': 'Auto-orientation disabled'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        upload_file = request.FILES.get('file')
        if not upload_file:
            return Response(
                {'detail': "Missing 'file' multipart field"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Write to a tempfile so the orientation service can mmap-read it.
        # NamedTemporaryFile + delete=False because we want to control
        # cleanup explicitly in the finally block.
        import tempfile
        suffix = os.path.splitext(upload_file.name or '')[1] or '.jpg'
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                for chunk in upload_file.chunks():
                    tmp.write(chunk)
                tmp_path = tmp.name
        except Exception:
            logger.exception("orientation/detect: failed to write tempfile")
            return Response(
                {'detail': 'Server error writing temp file'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        try:
            from services.orientation import detect_rotation
            suggestion = detect_rotation(tmp_path, label=(upload_file.name or 'unnamed'))
        except ImportError:
            logger.warning(
                "orientation/detect: services.orientation unavailable "
                "(mediapipe not installed) — returning 503"
            )
            return Response(
                {'detail': 'Orientation service not available on this worker'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception:
            logger.exception("orientation/detect: inference failed")
            return Response(
                {'detail': 'Inference failed'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

        if suggestion is None:
            # No usable pose — frontend falls back to aspect heuristic.
            return Response(status=status.HTTP_204_NO_CONTENT)

        return Response({
            'rotation': suggestion.rotation,
            'confidence': suggestion.confidence,
            'source': suggestion.source,
        })


class HeicConvertView(APIView):
    """
    POST /api/heic/convert  — decode an iPhone HEIC/HEIF photo to JPEG.

    The editor converts HEIC in the browser (``lib/heic-convert.ts``) and only
    calls this when that fails. It fails routinely: ``heic2any`` bundles a 2021
    libheif that cannot read the ``tmap`` gain-map HDR structure current
    iPhones write, and Chrome/Firefox have no HEIC codec to fall back on. See
    ``services/heic.py`` for the full description of the format.

    Stateless and inline, deliberately mirroring ``OrientationDetectView``:
    nothing is persisted, no Celery round-trip. The customer is waiting on a
    canvas preview, so a queued job would either stall the preview or force a
    second render pass. Decoding a 24 MP HEIC costs roughly a second of CPU.

    Returns the raw JPEG (``image/jpeg``) rather than JSON+base64 — base64
    would inflate a 2.4 MB photo by a third for no benefit, since the caller
    wraps the bytes in a File either way.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["upload"],
        summary="Convert a HEIC/HEIF photo to JPEG",
        description=(
            "Accepts a single `file` multipart field containing HEIC/HEIF bytes "
            "and returns the decoded image as `image/jpeg`. Used as the fallback "
            "when in-browser HEIC conversion fails."
        ),
        request={"multipart/form-data": inline_serializer(
            name="HeicConvert",
            fields={"file": drf_serializers.FileField(help_text="HEIC/HEIF bytes, up to the normal upload size limit.")},
        )},
        responses={
            200: OpenApiResponse(response=OpenApiTypes.BINARY, description="The decoded photo as image/jpeg."),
            400: OpenApiResponse(description="No `file` field, over the size limit, or not decodable as HEIC."),
            503: OpenApiResponse(description="No HEIC decoder available in this build."),
        },
    )
    def post(self, request):
        from django.http import HttpResponse
        from services.heic import (
            decode_heic_to_jpeg, HeicDecodeError, HeicUnavailableError,
        )

        upload_file = request.FILES.get('file')
        if not upload_file:
            return Response(
                {'detail': "Missing 'file' multipart field"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Same ceiling as a normal upload. Checked before read() so an oversize
        # payload never lands in memory — this endpoint holds the whole file,
        # unlike the chunked upload path.
        max_bytes = settings.MAX_UPLOAD_FILE_SIZE
        if upload_file.size and upload_file.size > max_bytes:
            return Response(
                {'detail': f'File exceeds {settings.MAX_UPLOAD_FILE_SIZE_MB} MB limit'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        data = upload_file.read()
        if len(data) > max_bytes:
            return Response(
                {'detail': f'File exceeds {settings.MAX_UPLOAD_FILE_SIZE_MB} MB limit'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            jpeg_bytes, width, height = decode_heic_to_jpeg(data)
        except HeicUnavailableError:
            logger.warning("heic/convert: pillow-heif not installed — returning 503")
            return Response(
                {'detail': 'HEIC conversion is not available on this server'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except HeicDecodeError as exc:
            # Genuinely undecodable input is the caller's problem, not a server
            # fault — 400 so the editor shows "re-export as JPEG" rather than
            # retrying a request that will always fail the same way.
            logger.info(
                "heic/convert: undecodable input (%s bytes): %s", len(data), exc,
            )
            return Response(
                {'detail': 'This file could not be read as a HEIC photo'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception:
            logger.exception("heic/convert: unexpected failure")
            return Response(
                {'detail': 'Conversion failed'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        logger.info(
            "heic/convert: %s (%d bytes) → JPEG %dx%d (%d bytes)",
            upload_file.name or 'unnamed', len(data), width, height, len(jpeg_bytes),
        )
        response = HttpResponse(jpeg_bytes, content_type='image/jpeg')
        response['Content-Length'] = len(jpeg_bytes)
        response['X-Image-Width'] = str(width)
        response['X-Image-Height'] = str(height)
        return response
