"""Chunked uploads: init, chunk PUT, and complete (assembly + validation)."""
import os
import re
import json
import logging
from django.conf import settings
from rest_framework.views import APIView
from rest_framework.parsers import BaseParser
from rest_framework.response import Response
from rest_framework import status
from django.utils.crypto import get_random_string
from django.core.exceptions import ValidationError
from drf_spectacular.utils import (
    extend_schema,
    OpenApiParameter,
    OpenApiResponse,
    inline_serializer,
)
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from ..permissions import IsAuthenticatedWithAPIKey
from ..authentication import APIKeyUser
from ..models import UploadedFile

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
#  Chunked / Resumable Upload
# ═══════════════════════════════════════════════════════════════════════════════

# Shared by the chunk/complete schema descriptions. Both endpoints build a
# filesystem path out of a request-supplied id, so the guard is worth stating
# on each of them rather than once somewhere a reader may not reach.
UUID_GUARD = (
    "`upload_id` is matched against a canonical UUID v4 pattern before any path "
    "is built from it, so a traversal value is rejected outright rather than "
    "reaching the filesystem."
)


class ChunkedUploadInitView(APIView):
    """
    POST /api/upload/init  — start a resumable upload session.

    Accepts: { filename, file_size, total_chunks, content_type? }
    Returns: { upload_id, chunk_size }

    The upload_id is used by the client to push individual chunks via
    ChunkedUploadChunkView.  Once all chunks land, ChunkedUploadCompleteView
    assembles and validates the file.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    CHUNK_SIZE = 2 * 1024 * 1024  # 2 MB recommended chunk size

    @extend_schema(
        tags=["upload"],
        summary="Initialise a chunked upload session",
        description=(
            "Step 1 of 3. Reserves an `upload_id` and returns the chunk size to "
            "cut the file into. Follow with one `PUT .../chunk?index=N` per chunk "
            "(the editor runs four files in parallel), then `POST .../complete`.\n\n"
            "Chunk uploads are idempotent — re-sending an index overwrites it — so "
            "a failed submit can resume by re-sending only the chunks that were "
            "never acknowledged.\n\n"
            "Per-file ceiling is `MAX_UPLOAD_FILE_SIZE_MB` (default 50 MB). Disk "
            "headroom is checked here, so a full volume fails at init with **507** "
            "rather than part-way through a long upload."
        ),
        request=inline_serializer(
            name="ChunkedUploadInit",
            fields={
                "filename": drf_serializers.CharField(),
                "file_size": drf_serializers.IntegerField(help_text="Total bytes."),
                "total_chunks": drf_serializers.IntegerField(help_text="Bounded server-side."),
            },
        ),
        responses={
            201: inline_serializer(
                name="ChunkedUploadSession",
                fields={
                    "upload_id": drf_serializers.UUIDField(help_text="Use in the chunk and complete calls, and as the frame's upload_id at render."),
                    "chunk_size": drf_serializers.IntegerField(help_text="Bytes per chunk. Cut the file to exactly this."),
                },
            ),
            400: OpenApiResponse(description="Missing field, file over the size limit, or an implausible total_chunks."),
            507: OpenApiResponse(description="Not enough disk space to accept this upload."),
        },
    )
    def post(self, request):
        import uuid as _uuid

        filename = request.data.get('filename')
        file_size = request.data.get('file_size')
        total_chunks = request.data.get('total_chunks')

        if not filename or not file_size or not total_chunks:
            return Response(
                {'detail': 'filename, file_size, and total_chunks are required'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            file_size = int(file_size)
            total_chunks = int(total_chunks)
        except (TypeError, ValueError):
            return Response({'detail': 'file_size and total_chunks must be integers'}, status=status.HTTP_400_BAD_REQUEST)

        if file_size <= 0:
            return Response({'detail': 'file_size must be positive'}, status=status.HTTP_400_BAD_REQUEST)

        if file_size > settings.MAX_UPLOAD_FILE_SIZE:
            return Response(
                {'detail': f'File exceeds {settings.MAX_UPLOAD_FILE_SIZE_MB} MB limit'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Bound total_chunks (Phase 4): an unbounded/huge value made the
        # complete step materialise set(range(total_chunks)) and OOM the
        # worker in one request. Cap to what the file size allows (+1 slack)
        # and cross-check it against ceil(file_size / CHUNK_SIZE).
        expected_chunks = -(-file_size // self.CHUNK_SIZE)  # ceil division
        max_chunks = expected_chunks + 1
        if total_chunks < 1 or total_chunks > max_chunks:
            return Response(
                {'detail': f'total_chunks must be between 1 and {max_chunks} for this file size'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Disk-full pre-flight: refuse the upload up front rather than staging
        # chunks into a wall (need room for staged chunks + the assembled file).
        import shutil
        try:
            free = shutil.disk_usage(settings.UPLOADS_DIR).free
            if free < file_size * 2 + 500 * 1024 * 1024:
                return Response(
                    {'detail': 'Server storage is full — please try again later.'},
                    status=507,
                )
        except OSError:
            pass  # can't stat — don't block on it

        upload_id = str(_uuid.uuid4())

        # Create a staging directory for this upload's chunks.
        staging_dir = os.path.join(settings.UPLOADS_DIR, '.chunks', upload_id)
        os.makedirs(staging_dir, exist_ok=True)

        # Persist metadata alongside chunks so complete-step can validate.
        meta = {
            'filename': filename,
            'file_size': file_size,
            'total_chunks': total_chunks,
            'received_chunks': [],
        }
        with open(os.path.join(staging_dir, '_meta.json'), 'w') as f:
            json.dump(meta, f)

        return Response({
            'upload_id': upload_id,
            'chunk_size': self.CHUNK_SIZE,
            'total_chunks': total_chunks,
        }, status=status.HTTP_201_CREATED)


class _AnyContentTypeParser(BaseParser):
    """
    DRF parser that matches any Content-Type without consuming the body.

    Returning the request stream untouched lets the view fall back to
    ``request.body`` (via Django's HttpRequest) for raw-bytes uploads.
    Crucially we do NOT read ``stream`` here — DRF's ``Request.body``
    raises RawPostDataException if the parser drained it first.
    """
    media_type = '*/*'

    def parse(self, stream, media_type=None, parser_context=None):
        return None


class ChunkedUploadChunkView(APIView):
    """
    PUT /api/upload/<upload_id>/chunk?index=N  — push a single chunk.

    The chunk is written to a staging directory as `<index>.part`.

    Accepts two body shapes:
      • Raw bytes — Content-Type can be anything (browser auto-sets it to
        the original File's MIME, e.g. image/png, when calling
        ``fetch(url, { body: blob })``). Read via ``request.body``.
      • multipart/form-data with a "chunk" file field. Read via
        ``request.FILES.get('chunk')``.

    Why a custom parser instead of ``parser_classes = []``: DRF performs
    content negotiation in ``Request.__init__`` and raises
    ``UnsupportedMediaType (415)`` if no parser matches the request's
    Content-Type. An empty parser list therefore rejects every body with
    a non-empty Content-Type before the view even runs. The
    ``_AnyContentTypeParser`` above declares ``media_type = '*/*'`` so
    negotiation passes and we keep the raw stream available for
    ``request.body``. Django's MultiPartParser is still invoked lazily
    by ``request.FILES`` so the multipart fallback path is unaffected.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]
    parser_classes = [_AnyContentTypeParser]

    @extend_schema(
        tags=["upload"],
        summary="Upload a single chunk",
        description=(
            "Step 2 of 3. Body is the **raw chunk bytes** — not multipart, not "
            "JSON. The zero-based `index` goes in the query string.\n\n"
            "Idempotent: re-sending an index overwrites that chunk, which is what "
            "makes resume possible. Each body is capped at twice the negotiated "
            "chunk size.\n\n" + UUID_GUARD + "\n\n"
            "Deliberately excluded from the API audit trail — a single large job "
            "would otherwise write thousands of rows. The `complete` call that "
            "finalises the stored file *is* recorded."
        ),
        parameters=[
            OpenApiParameter("index", OpenApiTypes.INT, OpenApiParameter.QUERY, required=True,
                             description="Zero-based chunk index."),
        ],
        request={"application/octet-stream": OpenApiTypes.BINARY},
        responses={
            200: inline_serializer(
                name="ChunkAck",
                fields={
                    "chunk_index": drf_serializers.IntegerField(),
                    "received": drf_serializers.IntegerField(help_text="Chunks stored so far."),
                    "total": drf_serializers.IntegerField(),
                },
            ),
            400: OpenApiResponse(description="Malformed upload_id, or a missing/invalid index."),
            404: OpenApiResponse(description="Unknown or already-reclaimed upload session."),
            413: OpenApiResponse(description="Chunk body exceeds twice the negotiated chunk size."),
        },
    )
    def put(self, request, upload_id: str):
        # Reject anything that isn't a canonical UUID v4 string to prevent
        # path traversal attacks (e.g. upload_id='../../etc/passwd').
        if not re.match(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            upload_id,
            re.IGNORECASE,
        ):
            return Response({'detail': 'Invalid upload session'}, status=status.HTTP_400_BAD_REQUEST)

        chunk_index = request.query_params.get('index')
        if chunk_index is None:
            return Response({'detail': 'index query param required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            chunk_index = int(chunk_index)
        except ValueError:
            return Response({'detail': 'index must be an integer'}, status=status.HTTP_400_BAD_REQUEST)

        staging_dir = os.path.join(settings.UPLOADS_DIR, '.chunks', upload_id)
        meta_path = os.path.join(staging_dir, '_meta.json')

        if not os.path.isdir(staging_dir) or not os.path.isfile(meta_path):
            return Response({'detail': 'Upload session not found'}, status=status.HTTP_404_NOT_FOUND)

        with open(meta_path, 'r') as f:
            meta = json.load(f)

        if chunk_index < 0 or chunk_index >= meta['total_chunks']:
            return Response({'detail': 'chunk index out of range'}, status=status.HTTP_400_BAD_REQUEST)

        # Write chunk to staging — accept raw body or multipart "chunk" field.
        chunk_data = request.FILES.get('chunk')
        if chunk_data:
            chunk_bytes = chunk_data.read()
        else:
            chunk_bytes = request.body

        if not chunk_bytes:
            return Response({'detail': 'No chunk data received'}, status=status.HTTP_400_BAD_REQUEST)

        # Per-chunk size cap (Phase 4): closes the multipart hole regardless of
        # nginx's client_max_body_size — a chunk is at most one CHUNK_SIZE, so
        # 2× is generous slack for boundary framing.
        if len(chunk_bytes) > 2 * ChunkedUploadInitView.CHUNK_SIZE:
            return Response({'detail': 'Chunk exceeds the maximum size'}, status=413)

        chunk_path = os.path.join(staging_dir, f'{chunk_index}.part')
        with open(chunk_path, 'wb') as out:
            out.write(chunk_bytes)

        # Track received chunks.
        if chunk_index not in meta['received_chunks']:
            meta['received_chunks'].append(chunk_index)
            meta['received_chunks'].sort()
            with open(meta_path, 'w') as f:
                json.dump(meta, f)

        return Response({
            'chunk_index': chunk_index,
            'received': len(meta['received_chunks']),
            'total': meta['total_chunks'],
        })


class ChunkedUploadCompleteView(APIView):
    """
    POST /api/upload/<upload_id>/complete  — assemble chunks → final file.

    Validates:
      1. All chunks present
      2. Assembled file size matches declared size
      3. PIL image integrity check (same as regular uploads)

    Returns the file path usable in subsequent canvas-state saves or
    generate requests.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["upload"],
        summary="Assemble chunks and finalise upload",
        description=(
            "Step 3 of 3. Concatenates the staged chunks in index order, verifies "
            "the assembled size and that the result actually decodes as an image, "
            "then records it and removes the staging directory.\n\n"
            "An upload that never reaches this call leaves its staging directory "
            "behind — there is no database row to sweep from — so a separate "
            "garbage-collector pass reclaims abandoned staging after "
            "`CHUNK_STAGING_MAX_AGE_HOURS` (default 24). A slow client still "
            "uploading is never a candidate.\n\n"
            "The stored file is linked to an order here, which is what makes a "
            "later DPDP erasure able to find it. The `X-Order-ID` header (injected "
            "by the embed proxy) wins over a body `order_id`.\n\n" + UUID_GUARD
        ),
        request=inline_serializer(
            name="ChunkedUploadCompleteRequest",
            fields={
                "order_id": drf_serializers.CharField(
                    required=False,
                    help_text="Ignored when the `X-Order-ID` header is present. Records order linkage for erasure.",
                ),
            },
        ),
        responses={
            201: inline_serializer(
                name="ChunkedUploadComplete",
                fields={
                    "file_path": drf_serializers.CharField(help_text="Server-side path. Reference the upload by upload_id, not this."),
                    "filename": drf_serializers.CharField(),
                    "file_size": drf_serializers.IntegerField(),
                    "upload_id": drf_serializers.UUIDField(help_text="Echoed back — this is what a render payload references."),
                },
            ),
            400: OpenApiResponse(description="Malformed upload_id, missing chunks, size mismatch, or the assembled bytes are not a decodable image."),
            404: OpenApiResponse(description="Unknown or already-reclaimed upload session."),
        },
    )
    def post(self, request, upload_id: str):
        import shutil

        # Reject anything that isn't a canonical UUID v4 string to prevent
        # path traversal attacks (e.g. upload_id='../../etc/passwd').
        if not re.match(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            upload_id,
            re.IGNORECASE,
        ):
            return Response({'detail': 'Invalid upload session'}, status=status.HTTP_400_BAD_REQUEST)

        staging_dir = os.path.join(settings.UPLOADS_DIR, '.chunks', upload_id)
        meta_path = os.path.join(staging_dir, '_meta.json')

        if not os.path.isdir(staging_dir) or not os.path.isfile(meta_path):
            return Response({'detail': 'Upload session not found'}, status=status.HTTP_404_NOT_FOUND)

        with open(meta_path, 'r') as f:
            meta = json.load(f)

        expected = set(range(meta['total_chunks']))
        received = set(meta['received_chunks'])
        missing = expected - received
        if missing:
            return Response(
                {'detail': f'Missing chunks: {sorted(missing)}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Resolve the owning order BEFORE choosing where to write, so the file
        # lands in that order's directory. Same precedence EditorRenderView
        # uses: X-Order-ID (injected by the embed proxy from
        # EmbedSession.order_id) first, then an explicit field.
        #
        # Storing per-order is what lets DPDP erasure discover a customer's
        # files from the path alone, rather than depending on database rows to
        # enumerate them — see docs/DPDP_ERASURE_GAP_PRD.md.
        order_id = (
            (request.headers.get('X-Order-ID') or '').strip()
            or str(request.data.get('order_id') or '').strip()
        )

        # Assemble chunks in order into the order's upload directory.
        from services.storage import order_upload_dir
        final_name = get_random_string(8) + '_' + meta['filename']
        target_dir = order_upload_dir(order_id)
        os.makedirs(target_dir, exist_ok=True)
        final_path = os.path.join(target_dir, final_name)
        assembled_size = 0

        try:
            with open(final_path, 'wb') as out:
                for idx in range(meta['total_chunks']):
                    chunk_path = os.path.join(staging_dir, f'{idx}.part')
                    with open(chunk_path, 'rb') as cp:
                        data = cp.read()
                        assembled_size += len(data)
                        out.write(data)
        except Exception as exc:
            # Clean up partial file.
            if os.path.exists(final_path):
                os.remove(final_path)
            logger.error("Chunk assembly failed for %s: %s", upload_id, exc)
            return Response({'detail': 'Chunk assembly failed'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        # Validate size.
        if assembled_size != meta['file_size']:
            os.remove(final_path)
            return Response(
                {'detail': f"Size mismatch: expected {meta['file_size']}, got {assembled_size}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate image integrity with PIL (same check as regular uploads).
        try:
            from api.validators import validate_image_file
            from django.core.files.uploadedfile import SimpleUploadedFile
            with open(final_path, 'rb') as f:
                temp = SimpleUploadedFile(meta['filename'], f.read())
            validate_image_file(temp)
        except ValidationError as e:
            os.remove(final_path)
            return Response({'detail': str(e)}, status=status.HTTP_400_BAD_REQUEST)

        # Clean up staging directory.
        shutil.rmtree(staging_dir, ignore_errors=True)

        # Record in database.
        api_key = None
        if isinstance(request.user, APIKeyUser):
            api_key = request.user.api_key

        if api_key:
            # order_id was resolved above, before the file was written, so the
            # row and the directory it lives in always agree.
            UploadedFile.objects.create(
                api_key=api_key,
                file_path=final_path,
                original_filename=meta['filename'],
                file_size_bytes=assembled_size,
                file_type='image',
                upload_session_id=upload_id,
                order_id=order_id,
            )

        logger.info("Chunked upload completed: %s (%d bytes) → %s", meta['filename'], assembled_size, final_path)

        return Response({
            'file_path': final_path,
            'filename': meta['filename'],
            'file_size': assembled_size,
            'upload_id': upload_id,
        }, status=status.HTTP_201_CREATED)


# ═══════════════════════════════════════════════════════════════════════════════
#  Upload by link  (a restored design's photos, fetched from the caller's storage)
# ═══════════════════════════════════════════════════════════════════════════════

_ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')


class UploadFromUrlView(APIView):
    """
    POST /api/upload/from-url  — fetch one photo from a link and store it as an
    ordinary upload.

    For a design brought back from an embedding company's own copy: its photos
    arrive as links to that company's storage, and at submit each unchanged
    photo is fetched here so the customer's device does not download and
    re-upload it. The result is the same `UploadedFile` row a chunked upload
    makes, so the render payload, the quantity check, the GC, the purge and the
    uploads ZIP all treat it as any other upload.

    Off for an API key until `allowed_photo_hosts` names a host. See
    services/photo_fetch.py for why and for the limits.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["upload"],
        summary="Fetch a photo from a link and store it as an upload",
        description=(
            "Fetches one photo from an https link and stores it exactly as a "
            "chunked upload would, returning an `upload_id` to use in "
            "`POST /api/editor/render`.\n\n"
            "**Off by default.** The API key must list the link's host in "
            "`allowed_photo_hosts` (Django admin, exact host names). Without a "
            "list every call answers **403**.\n\n"
            "The link must be plain `https` on the standard port with no user "
            "name or password, resolve to a public address, and answer **200** "
            "directly: redirects are not followed. The file is limited to "
            "`MAX_UPLOAD_FILE_SIZE_MB` while it is read, whatever the host "
            "declares, must decode as an image, and the whole fetch has a "
            "60-second deadline.\n\n"
            "Requires an order (the `X-Order-ID` header the embed proxy injects, "
            "or `order_id`). Per order: at most `PHOTO_FETCH_MAX_FILES_PER_ORDER` "
            "stored files and `PHOTO_FETCH_MAX_ORDER_MB` in total, and "
            "`PHOTO_FETCH_PER_MINUTE` fetches a minute.\n\n"
            "**Asking again for a photo already fetched for the same order returns the "
            "copy held (200) without downloading it**, matched on the link's host and "
            "path. Reopening or refreshing a restored design is therefore cheap, and a "
            "dropped connection resumes where it stopped."
        ),
        request=inline_serializer(
            name="UploadFromUrl",
            fields={
                "url": drf_serializers.CharField(help_text="The photo's https link, on a host listed for this API key."),
                "filename": drf_serializers.CharField(
                    required=False,
                    help_text="The name to store it under, with its image extension. Defaults to the link's own file name.",
                ),
                "order_id": drf_serializers.CharField(
                    required=False,
                    help_text="Ignored when the `X-Order-ID` header is present.",
                ),
            },
        ),
        responses={
            201: inline_serializer(
                name="UploadFromUrlDone",
                fields={
                    "upload_id": drf_serializers.UUIDField(help_text="Reference this in the render payload, like any upload."),
                    "filename": drf_serializers.CharField(),
                    "file_size": drf_serializers.IntegerField(),
                    "width": drf_serializers.IntegerField(allow_null=True, help_text="Pixels, as a browser shows the photo (EXIF orientation applied)."),
                    "height": drf_serializers.IntegerField(allow_null=True),
                },
            ),
            200: OpenApiResponse(description="This photo was already fetched for this order: the same body, for the copy already held. Nothing was downloaded."),
            400: OpenApiResponse(description="Missing or malformed url or order id, or the fetched bytes are not a usable image."),
            403: OpenApiResponse(description="Fetching by link is not switched on for this API key, or the link's host is not on its list or is not a public address."),
            413: OpenApiResponse(description="The photo is larger than the upload limit."),
            429: OpenApiResponse(description="Too many fetches for this order in the last minute, or the order already holds the most files or bytes it may."),
            502: OpenApiResponse(description="The host could not be reached, redirected, or did not answer 200."),
            504: OpenApiResponse(description="The host took too long to send the photo."),
            507: OpenApiResponse(description="Not enough disk space to accept this photo."),
        },
    )
    def post(self, request):
        import shutil
        import uuid as _uuid
        from urllib.parse import urlparse
        from django.core.cache import cache
        from django.db.models import Count, Sum
        from services.image_loader import displayed_size
        from services.photo_fetch import PhotoFetchError, check_photo_url, fetch_photo, name_from_url, source_key_for
        from services.restore_manifest import safe_entry_name
        from services.storage import order_upload_dir

        api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
        if not api_key:
            return Response({'detail': 'API key required'}, status=status.HTTP_403_FORBIDDEN)

        hosts = api_key.photo_hosts()
        if not hosts:
            return Response(
                {'detail': 'Fetching photos by link is not switched on for this API key.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        order_id = (
            (request.headers.get('X-Order-ID') or '').strip()
            or str(request.data.get('order_id') or '').strip()
        )
        if not _ORDER_ID_RE.match(order_id):
            return Response({'detail': 'order_id is required.'}, status=status.HTTP_400_BAD_REQUEST)

        url = str(request.data.get('url') or '').strip()
        if not url:
            return Response({'detail': 'url is required.'}, status=status.HTTP_400_BAD_REQUEST)

        def answer(row, code):
            # The size as a browser shows the photo, so the editor can judge the
            # print resolution without holding the original.
            try:
                width, height = displayed_size(row.file_path)
            except Exception:
                width = height = None
            return Response({
                'upload_id': row.upload_session_id, 'filename': row.original_filename,
                'file_size': row.file_size_bytes, 'width': width, 'height': height,
            }, status=code)

        # ── A photo already fetched for this order is returned, not fetched
        # again. A restored design asks for every photo each time it is opened,
        # so without this a refresh would download the whole order again and a
        # few of them would fill the order's allowance. Checked before the
        # limits, which exist to bound downloads, not look-ups. ──────────────
        try:
            check_photo_url(url, hosts)
        except PhotoFetchError as exc:
            return Response({'detail': exc.detail}, status=exc.status)
        source_key = source_key_for(url)
        held_copy = (
            UploadedFile.objects
            .filter(api_key=api_key, order_id=order_id, source_key=source_key, is_deleted=False)
            .order_by('-created_at')
            .first()
        )
        if held_copy and os.path.isfile(held_copy.file_path):
            return answer(held_copy, status.HTTP_200_OK)

        # ── Limits on what one order can make this server download ───────────
        # /api/upload/ is exempt from the per-IP rate limit (chunk traffic is
        # heavy by nature), so this endpoint keeps its own count. Fails open
        # when the cache is unavailable, like the daily request cap.
        try:
            window = f'photo_fetch:{api_key.id}:{order_id}'
            cache.add(window, 0, 60)
            if cache.incr(window) > settings.PHOTO_FETCH_PER_MINUTE:
                response = Response(
                    {'detail': 'Too many photos fetched for this order in the last minute. Try again shortly.'},
                    status=status.HTTP_429_TOO_MANY_REQUESTS,
                )
                response['Retry-After'] = '60'
                return response
        except Exception:
            pass

        held = UploadedFile.objects.filter(api_key=api_key, order_id=order_id, is_deleted=False).aggregate(
            files=Count('id'), size=Sum('file_size_bytes'),
        )
        if (held['files'] or 0) >= settings.PHOTO_FETCH_MAX_FILES_PER_ORDER or \
                (held['size'] or 0) >= settings.PHOTO_FETCH_MAX_ORDER_MB * 1024 * 1024:
            return Response(
                {'detail': 'This order already holds as many photos as it may.'},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        try:
            free = shutil.disk_usage(settings.UPLOADS_DIR).free
            if free < settings.MAX_UPLOAD_FILE_SIZE * 2 + 500 * 1024 * 1024:
                return Response({'detail': 'Server storage is full — please try again later.'}, status=507)
        except OSError:
            pass  # can't stat — don't block on it

        # ── Fetch into chunk staging, so an interrupted fetch is reclaimed by
        # the same sweep that reclaims an abandoned chunked upload ───────────
        upload_id = str(_uuid.uuid4())
        staging_dir = os.path.join(settings.UPLOADS_DIR, '.chunks', upload_id)
        os.makedirs(staging_dir, exist_ok=True)
        staged = os.path.join(staging_dir, 'fetched.part')
        # Never log the query string: a link may carry a signature there.
        where = urlparse(url)
        shown = f'{where.hostname}{where.path}'

        try:
            size = fetch_photo(
                url, allowed_hosts=hosts, dest_path=staged, max_bytes=settings.MAX_UPLOAD_FILE_SIZE,
            )
        except PhotoFetchError as exc:
            shutil.rmtree(staging_dir, ignore_errors=True)
            logger.warning("Photo fetch refused for order %s (%s): %s", order_id, shown, exc.detail)
            return Response({'detail': exc.detail}, status=exc.status)

        filename = safe_entry_name(request.data.get('filename') or name_from_url(url))

        # The same integrity check a chunked upload gets.
        try:
            from api.validators import validate_image_file
            from django.core.files.uploadedfile import SimpleUploadedFile
            with open(staged, 'rb') as f:
                temp = SimpleUploadedFile(filename, f.read())
            validate_image_file(temp)
        except ValidationError as e:
            shutil.rmtree(staging_dir, ignore_errors=True)
            detail = e.messages[0] if getattr(e, 'messages', None) else str(e)
            logger.warning("Fetched photo rejected for order %s (%s): %s", order_id, shown, detail)
            return Response({'detail': detail}, status=status.HTTP_400_BAD_REQUEST)

        target_dir = order_upload_dir(order_id)
        os.makedirs(target_dir, exist_ok=True)
        final_path = os.path.join(target_dir, get_random_string(8) + '_' + filename)
        os.replace(staged, final_path)
        shutil.rmtree(staging_dir, ignore_errors=True)

        row = UploadedFile.objects.create(
            api_key=api_key,
            file_path=final_path,
            original_filename=filename,
            file_size_bytes=size,
            file_type='image',
            upload_session_id=upload_id,
            order_id=order_id,
            source_key=source_key,
        )
        logger.info("Photo fetched by link: %s (%d bytes) for order %s", shown, size, order_id)

        return answer(row, status.HTTP_201_CREATED)


_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.IGNORECASE)


class PhotoPreviewView(APIView):
    """
    GET /api/photos/<upload_id>/preview  — a stored photo, for the editor.

    A restored design's photos are held here, not on the customer's device
    (see UploadFromUrlView). The editor draws each card from a small preview
    made by this endpoint; when the customer opens a card it asks for
    `size=full`, the original, and edits that. The print always uses the
    original.

    An embed session is served only its own order's photos, like its saved
    design: every customer of one company presents that company's key.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["upload"],
        summary="A stored photo, scaled for the screen or in full",
        description=(
            "Returns a photo this API key holds, scaled so its longer side is at most "
            "`size` pixels (default `PHOTO_PREVIEW_PX`, 1600), as a browser would show "
            "the original: EXIF orientation applied, colours converted to sRGB. JPEG, "
            "or WebP when the photo has transparency. A photo already within `size` is "
            "returned as it is. `size=full` returns the original bytes.\n\n"
            "**In an embed session only the session's own order's photos are served** "
            "(the `X-Order-ID` header the embed proxy injects); any other answers 404. "
            "Limited to `PHOTO_PREVIEW_PER_MINUTE` calls a minute per key and order.\n\n" + UUID_GUARD
        ),
        parameters=[
            OpenApiParameter(
                "size", OpenApiTypes.STR, OpenApiParameter.QUERY,
                description="Longest side in pixels, 256 to 4096, or `full` for the original. Default 1600.",
            ),
        ],
        responses={
            200: OpenApiResponse(description="The image bytes (image/jpeg, image/webp, or the original's own type)."),
            400: OpenApiResponse(description="Malformed upload_id or size."),
            404: OpenApiResponse(description="No such photo for this key, or it belongs to another order than the embed session's."),
            422: OpenApiResponse(description="The stored file cannot be turned into a preview."),
            429: OpenApiResponse(description="Too many photos requested for this order in the last minute."),
        },
    )
    def get(self, request, upload_id: str):
        import io
        from django.core.cache import cache
        from django.http import FileResponse, HttpResponse
        from services.image_loader import displayed_size, open_source_preview, srgb_profile_bytes
        from services.restore_manifest import content_type_for

        if not _UUID_RE.match(upload_id or ''):
            return Response({'detail': 'Invalid upload id'}, status=status.HTTP_400_BAD_REQUEST)
        api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
        if not api_key:
            return Response({'detail': 'API key required'}, status=status.HTTP_403_FORBIDDEN)

        raw_size = str(request.query_params.get('size') or '').strip().lower()
        want_full = raw_size == 'full'
        size = settings.PHOTO_PREVIEW_PX
        if raw_size and not want_full:
            if not raw_size.isdigit():
                return Response({'detail': 'size must be a number of pixels or "full".'}, status=status.HTTP_400_BAD_REQUEST)
            size = max(256, min(4096, int(raw_size)))

        not_found = Response({'detail': 'Photo not found'}, status=status.HTTP_404_NOT_FOUND)
        row = (
            UploadedFile.objects
            .filter(api_key=api_key, upload_session_id=upload_id, is_deleted=False)
            .first()
        )
        if row is None:
            return not_found
        # The id comes from the customer's browser. In the embed, serve it only
        # when it belongs to the session's own order (see CanvasStateView.get).
        session_order_id = (request.headers.get('X-Order-ID') or '').strip()
        if session_order_id and row.order_id != session_order_id:
            logger.warning("Photo read refused: session order %s asked for a photo of another order", session_order_id)
            return not_found

        uploads_root = os.path.realpath(settings.UPLOADS_DIR)
        path = os.path.realpath(row.file_path)
        if not path.startswith(uploads_root + os.sep) or not os.path.isfile(path):
            return not_found

        # /api/photos/ is exempt from the per-IP limit (a large order asks for
        # every photo within a minute), so it keeps its own count.
        try:
            window = f'photo_preview:{api_key.id}:{row.order_id or "-"}'
            cache.add(window, 0, 60)
            if cache.incr(window) > settings.PHOTO_PREVIEW_PER_MINUTE:
                response = Response(
                    {'detail': 'Too many photos requested for this order in the last minute. Try again shortly.'},
                    status=status.HTTP_429_TOO_MANY_REQUESTS,
                )
                response['Retry-After'] = '60'
                return response
        except Exception:
            pass

        def original():
            response = FileResponse(open(path, 'rb'), content_type=content_type_for(row.original_filename))
            response['Cache-Control'] = 'private, max-age=3600'
            return response

        try:
            if want_full or max(displayed_size(path)) <= size:
                return original()
            preview = open_source_preview(path, size)
        except (OSError, ValueError) as exc:
            logger.warning("Photo preview failed for upload %s: %s", upload_id, exc)
            return Response({'detail': 'This photo cannot be previewed.'}, status=422)

        out = io.BytesIO()
        try:
            if preview.mode == 'RGBA':
                preview.save(out, format='WEBP', quality=85, icc_profile=srgb_profile_bytes())
                content_type = 'image/webp'
            else:
                preview.save(out, format='JPEG', quality=85, icc_profile=srgb_profile_bytes())
                content_type = 'image/jpeg'
        finally:
            preview.close()
        response = HttpResponse(out.getvalue(), content_type=content_type)
        response['Cache-Control'] = 'private, max-age=3600'
        return response
