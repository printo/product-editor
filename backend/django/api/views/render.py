"""Render submission and status: the direct-partner generate API, the editor render endpoint, render-job status."""
import os
import json
import logging
from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from django.utils.crypto import get_random_string
from django.core.exceptions import ValidationError
from drf_spectacular.utils import extend_schema, OpenApiExample, OpenApiResponse, inline_serializer
from rest_framework import serializers as drf_serializers
from services.storage import get_storage
from services.order_qty import count_placed_photos, qty_summary, qty_violation
from ..permissions import IsAuthenticatedWithAPIKey, CanGenerateLayouts
from ..authentication import APIKeyUser
from ..validators import validate_image_files
from ..models import UploadedFile, EmbedSession
from .layouts import _read_layout_def
from ._common import is_safe_layout_name

logger = logging.getLogger(__name__)


class GenerateLayoutView(APIView):
    """Generate layout from images - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["generate"],
        summary="Generate canvas from images",
        description=(
            "Upload images and a layout definition to produce a rendered canvas.\n\n"
            "**Request format:** `multipart/form-data`\n\n"
            "| Field | Type | Default | Description |\n"
            "|-------|------|---------|-------------|\n"
            "| `layout` | string | — | Layout name (e.g. `retro_polaroid_4.2x3.5`) |\n"
            "| `images` | file[] | — | One or more image files |\n"
            "| `fit_mode` | string | `cover` | `contain` or `cover` |\n"
            "| `export_format` | string | `png` | `png` or `pdf` (one file per canvas) |\n\n"
            "Returns one rendered file per canvas in the requested format.\n\n"
            "Note: the legacy `soft_proof` and `tiff_cmyk` options were removed; "
            "all output is now PNG or PDF at 300 DPI."
        ),
        request=inline_serializer(
            name="GenerateLayoutRequest",
            fields={
                "layout": drf_serializers.CharField(help_text="Layout name or JSON"),
                "images": drf_serializers.ListField(
                    child=drf_serializers.ImageField(),
                    help_text="Image files",
                ),
                "fit_mode": drf_serializers.ChoiceField(choices=["contain", "cover"], required=False, default="cover"),
                "export_format": drf_serializers.ChoiceField(choices=["png", "pdf"], required=False, default="png"),
            },
        ),
        responses={
            # 202, never 200: post() unconditionally delegates to _handle_async.
            # The synchronous helper this endpoint once had is unreachable, and
            # documenting its response body sent partners looking for `canvases`
            # in a payload that only ever carries a job id.
            202: inline_serializer(
                name="GenerateLayoutAccepted",
                fields={
                    "job_id": drf_serializers.UUIDField(),
                    "status_url": drf_serializers.CharField(
                        help_text="Poll until status is completed or failed, then fetch the archive.",
                    ),
                    "queue": drf_serializers.CharField(),
                    "estimated_wait_seconds": drf_serializers.IntegerField(required=False),
                },
            ),
            500: OpenApiResponse(description="The render job could not be enqueued."),
            400: OpenApiResponse(description="Invalid request — missing images or bad layout"),
            408: OpenApiResponse(description="Timeout — generation exceeded 5 minutes"),
        },
    )
    def post(self, request):
        """
        Always async — order_id is mandatory.

        Webhook callbacks are configured per embed-session (see
        `EmbedSession.callback_url` in `POST /api/embed/session`). Non-embed
        direct callers should poll `/api/render-status/<job_id>/`.
        """
        order_id = request.data.get('order_id')
        if not order_id:
            return Response(
                {
                    "detail": (
                        "order_id is required.  "
                        "The direct UI auto-generates one; embed callers must supply it."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        logger.info("Async generate: order_id=%s", order_id)
        return self._handle_async(request)

    def _handle_async(self, request):
        """Handle async generation request - enqueue job and return immediately."""
        from api.models import CanvasData, RenderJob
        from django.db import transaction
        from datetime import timedelta
        from django.utils import timezone
        
        try:
            # Parse request
            layout_data = request.data.get("layout")
            if isinstance(layout_data, str) and (layout_data.startswith('{') or layout_data.startswith('[')):
                try:
                    layout_data = json.loads(layout_data)
                except Exception:
                    pass

            layout_name = layout_data.get('name') if isinstance(layout_data, dict) else layout_data
            files = request.FILES.getlist("images")

            fit_mode = request.data.get("fit_mode", "cover")
            if fit_mode not in ("contain", "cover"):
                fit_mode = "cover"

            export_format = request.data.get("export_format", "png")
            if export_format not in ("png", "pdf"):
                export_format = "png"

            order_id = request.data.get("order_id")

            # Validate required fields
            if not order_id:
                return Response(
                    {"detail": "order_id required for async mode"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if not layout_name or not files:
                return Response(
                    {"detail": "layout and images are required"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if not self._is_valid_layout_name(layout_name):
                return Response(
                    {"detail": f"Invalid layout name: {layout_name}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                validate_image_files(files)
            except ValidationError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

            api_key = None
            if isinstance(request.user, APIKeyUser):
                api_key = request.user.api_key

            # Save uploaded files (organized by layout for better S3 structure)
            storage = get_storage()
            upload_paths = []
            for f in files:
                fname = get_random_string(8) + "_" + f.name
                # Per-order directory so erasure can find these by path.
                # Optional layout_name organizes uploads: uploads/{layout_name}/{order_id}/{filename}
                path = storage.save_upload(fname, f.file, order_id=order_id or '', layout_name=layout_name or '')
                upload_paths.append(path)
                if api_key:
                    UploadedFile.objects.create(
                        api_key=api_key,
                        file_path=path,
                        original_filename=f.name,
                        file_size_bytes=f.size,
                        file_type='image',
                        # Record the owning order so DPDP erasure can find this
                        # file without depending on CanvasData.image_paths.
                        order_id=order_id or '',
                    )

            # Use shared render submission service for job creation + dispatch
            from api.render_submission import RenderSubmissionService, RenderSubmissionError

            service = RenderSubmissionService(api_key, order_id)
            try:
                # Direct API does NOT support books — use simple image_paths contract.
                # render_state must be None so engine uses image_paths directly.
                result = service.submit(
                    layout_name=layout_name,
                    image_paths=upload_paths,
                    export_format=export_format,
                    fit_mode=fit_mode,
                    render_state=None,  # Direct API uses image_paths, not render_state
                    callback_url=None,  # Direct API doesn't support webhooks
                    queue_name='standard',
                )
                return Response(result, status=status.HTTP_202_ACCEPTED)
            except RenderSubmissionError as exc:
                logger.error("Render submission failed for order_id=%s: %s", order_id, exc)
                return Response(
                    {"detail": f"Failed to enqueue job: {exc}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )
            
        except Exception as exc:
            logger.error("Error in async generate: %s", exc)
            return Response(
                {"detail": f"Failed to enqueue job: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

    @staticmethod
    def _layout_exists(name: str) -> bool:
        """Does a layout with this name exist in LayoutCatalogue (directly, or via a rename alias)?"""
        from api.models import LayoutCatalogue
        try:
            LayoutCatalogue.resolve_active(name)
            return True
        except LayoutCatalogue.DoesNotExist:
            return False
        except Exception:
            return False

    @staticmethod
    def _is_valid_layout_name(name: str) -> bool:
        """
        Safe name AND present in storage.

        Kept for callers (render submission) where a missing layout genuinely
        is a bad request: they are naming the layout to render, not addressing
        a resource. Read endpoints should use is_safe_layout_name +
        _layout_exists so "not found" reports as 404.
        """
        return is_safe_layout_name(name) and \
            GenerateLayoutView._layout_exists(name)


class RenderStatusView(APIView):
    """Query status of async render job."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    @extend_schema(
        tags=["generate"],
        summary="Poll an async render job",
        description=(
            "Returns the current state of a render job. Poll this after "
            "`POST /api/editor/render` or `POST /api/layout/generate` until "
            "`status` is `completed` or `failed`, then fetch the archive from "
            "`GET /api/jobs/{job_id}/download/`.\n\n"
            "**Which fields are present depends on `status`:**\n\n"
            "| status | extra fields |\n"
            "|---|---|\n"
            "| `queued` | `estimated_wait_seconds` |\n"
            "| `processing` | `started_at` |\n"
            "| `completed` | `completed_at`, `generation_time_ms`, `output_files[]` |\n"
            "| `failed` | `error`, `retry_count` |\n\n"
            "Responses are cached briefly per status, so a tight polling loop is "
            "cheap. A 4-second interval with backoff is what the editor uses.\n\n"
            "**Ownership:** an API key may only read its own jobs. Someone else's "
            "job id returns **404, not 403** — deliberately, so the endpoint can't "
            "be used to probe which job ids exist. Internal dashboard users "
            "(PIA session) are exempt and may read any job."
        ),
        responses={
            200: inline_serializer(
                name="RenderJobStatus",
                fields={
                    "job_id": drf_serializers.UUIDField(),
                    "status": drf_serializers.ChoiceField(
                        choices=["queued", "processing", "completed", "failed"],
                    ),
                    "queue": drf_serializers.CharField(help_text="Celery queue the job was routed to."),
                    "created_at": drf_serializers.DateTimeField(),
                    "estimated_wait_seconds": drf_serializers.IntegerField(
                        required=False, help_text="`queued` only — accounts for worker concurrency.",
                    ),
                    "started_at": drf_serializers.DateTimeField(required=False, allow_null=True),
                    "completed_at": drf_serializers.DateTimeField(required=False, allow_null=True),
                    "generation_time_ms": drf_serializers.IntegerField(required=False, allow_null=True),
                    "output_files": drf_serializers.ListField(
                        required=False, child=drf_serializers.CharField(),
                        help_text="Paths relative to the exports root. Fetch via the download endpoint, not directly.",
                    ),
                    "error": drf_serializers.CharField(required=False, help_text="`failed` only."),
                    "retry_count": drf_serializers.IntegerField(required=False, help_text="`failed` only."),
                },
            ),
            404: OpenApiResponse(description="No such job, or the job belongs to a different API key."),
        },
        examples=[
            OpenApiExample(
                "Still queued",
                value={"job_id": "6f1c…", "status": "queued", "queue": "standard",
                       "created_at": "2026-09-03T10:00:00Z", "estimated_wait_seconds": 45},
                response_only=True, status_codes=["200"],
            ),
            OpenApiExample(
                "Completed",
                value={"job_id": "6f1c…", "status": "completed", "queue": "standard",
                       "created_at": "2026-09-03T10:00:00Z", "completed_at": "2026-09-03T10:01:12Z",
                       "generation_time_ms": 8420,
                       "output_files": ["6f1c…/print/January 2026.png"]},
                response_only=True, status_codes=["200"],
            ),
        ],
    )
    def get(self, request, job_id):
        """Get render job status by job_id."""
        from api.models import RenderJob
        from api.tasks import WORKER_CONCURRENCY
        from django.core.cache import cache

        # Check cache first (50ms response target)
        cache_key = f'render_job_status:{job_id}'
        cached = cache.get(cache_key)
        if cached:
            # Still enforce ownership on cached responses — the cache entry was
            # built by whoever first fetched the job, and a different API key
            # must not be allowed to read it.
            if isinstance(request.user, APIKeyUser):
                try:
                    job_check = RenderJob.objects.select_related('canvas_data').get(id=job_id)
                    if job_check.canvas_data.api_key != request.user.api_key:
                        return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)
                except RenderJob.DoesNotExist:
                    return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)
            return Response(cached)

        try:
            job = RenderJob.objects.select_related('canvas_data').get(id=job_id)
        except RenderJob.DoesNotExist:
            return Response(
                {'detail': 'Job not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        # Ownership check: APIKeyUsers may only view their own jobs.
        # PIAUsers are internal and may view any job.
        if isinstance(request.user, APIKeyUser):
            if job.canvas_data.api_key != request.user.api_key:
                # Return 404 rather than 403 to avoid leaking job existence
                # to callers who don't own it.
                return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)

        response_data = {
            'job_id': str(job.id),
            'status': job.status,
            'queue': job.queue_name,
            'created_at': job.created_at.isoformat(),
        }

        if job.status == 'queued':
            # Estimate wait time accounting for worker concurrency so the
            # estimate matches the logic in GenerateLayoutView._estimate_wait_time().
            queued_count = RenderJob.objects.filter(
                queue_name=job.queue_name,
                status='queued',
                created_at__lt=job.created_at
            ).count()
            avg_time_per_job = 30 if job.queue_name == 'priority' else 60
            concurrency = max(1, WORKER_CONCURRENCY)
            response_data['estimated_wait_seconds'] = max(
                0, int((queued_count / concurrency) * avg_time_per_job)
            )
        
        elif job.status == 'processing':
            response_data['started_at'] = job.started_at.isoformat() if job.started_at else None
        
        elif job.status == 'completed':
            response_data['completed_at'] = job.completed_at.isoformat() if job.completed_at else None
            response_data['generation_time_ms'] = job.generation_time_ms
            if job.output_paths:
                response_data['output_files'] = [
                    os.path.relpath(p, settings.EXPORTS_DIR) 
                    for p in job.output_paths
                ]
        
        elif job.status == 'failed':
            response_data['error'] = job.error_message
            response_data['retry_count'] = job.retry_count
        
        # Dynamic TTL based on job status for optimal caching
        # Configuration can be tuned via environment variables
        cache_ttl = settings.RENDER_JOB_STATUS_CACHE_TTL.get(
            job.status,
            settings.RENDER_JOB_STATUS_CACHE_TTL['default']
        )
        
        cache.set(cache_key, response_data, timeout=cache_ttl)
        
        return Response(response_data)


class EditorRenderView(APIView):
    """
    POST /api/editor/render

    Submit a server-side render job from files already uploaded via the chunked
    upload API.  Used by the embed editor for batches > 20 canvases so the
    browser doesn't have to do any heavy rendering.

    The order_id is resolved in priority order:
      1. X-Order-ID header (injected by the embed proxy from EmbedSession.order_id)
      2. 'order_id' field in the JSON body (direct / dashboard callers)

    Webhook callback URL is sourced ONLY from the embed session (via
    `X-Callback-URL` header injected by the embed proxy). Direct callers do
    not get a webhook — they must poll `/api/render-status/<job_id>/`.

    The ordered quantity comes from the embed session too — resolved directly
    from `EmbedSession.qty` by `(order_id, api_key)`, not from a header, so it
    is enforced the same way whether the request came through the embed proxy
    or was POSTed here directly — and a submission placing more photos than
    that is rejected with 400. Fewer is accepted on purpose — see
    services/order_qty.py.

    Request body (JSON):
    {
      "layout_name": "circle_48mm",
      "order_id": "EXT-JOB-123",          // required if not via embed proxy
      "export_format": "png",              // "png" (default) | "pdf"
      "canvases": [
        {
          "frames": [
            {
              "upload_id": "<uuid from /api/upload/init>",
              "offset_x": -12.5,           // canvas-space pan (pixels at layout scale)
              "offset_y": 3.0,
              "scale": 1.2,                // multiplier on top of cover/contain base
              "rotation": 0,               // degrees
              "fit_mode": "cover"          // "cover" | "contain"
            }
          ],
          "bg_color": "#ffffff"
        }
      ]
    }

    Response 202:
    {
      "job_id": "<uuid>",
      "order_id": "EXT-JOB-123",
      "status_url": "/api/render-status/<uuid>/",
      "queue": "standard"
    }
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["editor"],
        summary="Submit a composed design for rendering",
        description=(
            "The render entry point for both the embed iframe and the dashboard "
            "editor. Photos must already be uploaded via the chunked upload API; "
            "this call references them by `upload_id` and carries only the "
            "per-frame transforms. Returns **202** immediately with a job to poll — "
            "rendering happens on a Celery worker.\n\n"
            "**`order_id` resolution order:** the `X-Order-ID` header (injected by "
            "the embed proxy from the session, never trusted from the browser) "
            "wins over a body `order_id`.\n\n"
            "**Send the real `surface_key`.** For a single-surface product it is "
            "still that surface's own key — a literal `\"canvas\"` matches no "
            "surface and prints blank. Multi-surface products rely on this to give "
            "each physical side its own photos; get it wrong and one side prints "
            "the other side's picture.\n\n"
            "Book products must be submitted here rather than via "
            "`/api/layout/generate`, which cannot assign photos per page.\n\n"
            "There is **no duplicate-submit guard**: the same `order_id` posted "
            "twice creates a second job.\n\n"
            "**Ordered quantity.** When the embed session was created with a `qty`, "
            "it is looked up directly from that session (by `order_id` + your api_key) "
            "and a submission placing more photos than that is rejected with 400 — "
            "enforced the same way whether this is called via the embed proxy or "
            "posted here directly with your own key. Fewer is accepted — the "
            "asymmetry is deliberate, so a wrong `qty` cannot strand an order. "
            "Single-surface products only; calendars, books and multi-surface "
            "products are not quantity-checked.\n\n"
            "A short submission is recorded in the job's `qty_summary` and forwarded "
            "on the completion webhook. The photo counts there are recomputed by the "
            "server; only `qty_shortfall_acknowledged` comes from this body."
        ),
        request=inline_serializer(
            name="EditorRender",
            fields={
                "layout_name": drf_serializers.CharField(help_text="Layout identifier — the filename stem."),
                "order_id": drf_serializers.CharField(
                    required=False,
                    help_text="Ignored when the `X-Order-ID` header is present. `^[A-Za-z0-9_.\\-]{1,64}$`.",
                ),
                "export_format": drf_serializers.ChoiceField(
                    choices=["png", "pdf"], required=False, default="png",
                ),
                "canvases": drf_serializers.ListField(
                    help_text=(
                        "One entry per printed canvas: `{canvas_index, surface_key, "
                        "bg_color?, frames[]}`. Each frame is `{frame_index, "
                        "upload_id, offset_x, offset_y, scale, rotation, fit_mode}` "
                        "— offsets in canvas-space pixels at layout scale, `scale` a "
                        "multiplier on top of the cover/contain base, `fit_mode` "
                        "`cover` or `contain`."
                    ),
                    child=drf_serializers.DictField(),
                ),
                "qty_shortfall_acknowledged": drf_serializers.BooleanField(
                    required=False, default=False,
                    help_text=(
                        "`true` when the customer was shown the under-quantity notice "
                        "and chose to submit anyway. Forwarded as "
                        "`qty_summary.customer_acknowledged_shortfall` on the completion "
                        "webhook, and only when the server-counted photos really are "
                        "fewer than the session's `qty`. Anything but a literal `true` "
                        "reads as not acknowledged."
                    ),
                ),
            },
        ),
        responses={
            202: inline_serializer(
                name="EditorRenderAccepted",
                fields={
                    "job_id": drf_serializers.UUIDField(),
                    "order_id": drf_serializers.CharField(),
                    "status_url": drf_serializers.CharField(help_text="Poll this until status is completed or failed."),
                    "queue": drf_serializers.CharField(),
                },
            ),
            400: OpenApiResponse(description="Missing order_id, unknown layout, empty canvases, an upload_id that resolves to no stored file, or more photos than the embed session's `qty`."),
            403: OpenApiResponse(description="This API key may not generate layouts."),
            507: OpenApiResponse(description="Insufficient disk space to accept the job."),
        },
        examples=[
            OpenApiExample(
                "Single 4x6 print",
                value={
                    "layout_name": "classic_4x6", "order_id": "EXT-JOB-123", "export_format": "png",
                    "canvases": [{
                        "canvas_index": 0, "surface_key": "front",
                        "frames": [{"frame_index": 0, "upload_id": "a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                                    "offset_x": -12.5, "offset_y": 3.0, "scale": 1.2,
                                    "rotation": 0, "fit_mode": "cover"}],
                    }],
                },
                request_only=True,
            ),
        ],
    )
    def post(self, request):
        from datetime import timedelta
        from django.db import transaction as db_transaction
        from api.models import CanvasData, RenderJob
        from api.tasks import render_canvas_task

        # ── Resolve order_id ────────────────────────────────────────────────
        order_id = (
            request.headers.get('X-Order-ID', '').strip()
            or str(request.data.get('order_id', '') or '').strip()
        )
        if not order_id:
            return Response(
                {'detail': 'order_id is required (send in body or via embed session).'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        layout_name = str(request.data.get('layout_name', '') or '').strip()
        if not layout_name:
            return Response({'detail': 'layout_name is required.'}, status=status.HTTP_400_BAD_REQUEST)

        canvases_payload = request.data.get('canvases', [])
        if not canvases_payload:
            return Response({'detail': 'canvases list is required and must not be empty.'}, status=status.HTTP_400_BAD_REQUEST)

        export_format = str(request.data.get('export_format', 'png') or 'png').strip()
        if export_format not in ('png', 'pdf'):
            return Response(
                {'detail': "export_format must be 'png' or 'pdf'."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Callback URL is sourced from the embed proxy's injected header only —
        # it originally came from EmbedSession.callback_url at session creation.
        # Body-level callback_url is no longer accepted (single source of truth).
        callback_url = (request.headers.get('X-Callback-URL') or '').strip() or None
        # Embed proxy injects X-Include-Uploads from EmbedSession.include_uploads.
        # Absent (direct / dashboard callers) → True; they don't use the webhook
        # (the dashboard controls its own download via the URL query param).
        include_uploads = str(
            request.headers.get('X-Include-Uploads', 'true')
        ).strip().lower() not in ('0', 'false', 'no', 'off')
        api_key = request.user.api_key

        # ── Ordered-quantity cap ────────────────────────────────────────────
        # Resolved directly from EmbedSession.qty (order_id + api_key) — NOT
        # trusted from the X-Order-Qty header the embed proxy injects. That
        # header is genuine for iframe traffic, but nothing stops a caller who
        # holds the real api_key (which they necessarily do, to create embed
        # sessions in the first place) from POSTing straight here with no
        # proxy in the path, in which case the header simply never arrives.
        # Verified directly: a session created with qty=5, 7 files uploaded,
        # then POSTed here with the real key and no proxy — accepted with
        # HTTP 202 and no cap, even though the session's own qty said 5. The
        # doc claim ("rejects an over-count submission even if the editor is
        # bypassed") was therefore only true for callers who happened to go
        # through the proxy, not for the actual trust boundary. Looking the
        # value up ourselves from the row that is the real source of truth
        # closes that regardless of which path the request took.
        #
        # A caller can hold more than one session for the same order_id (e.g.
        # re-opening the flow), so take the most recent statement of intent:
        # order by -created_at and use the first with a qty actually set.
        # No matching row (dashboard, direct-partner GenerateLayoutView, or a
        # session created without a quantity) → no check, exactly as before.
        #
        # Going UNDER stays allowed here, as it is in the browser — see
        # services/order_qty.py on why that asymmetry is load-bearing.
        order_qty = (
            EmbedSession.objects
            .filter(order_id=order_id, api_key=api_key, qty__isnull=False)
            .order_by('-created_at')
            .values_list('qty', flat=True)
            .first()
        )
        order_qty_summary = None
        if order_qty is not None:
            placed = count_placed_photos(canvases_payload)
            layout_def = _read_layout_def(layout_name)
            over = qty_violation(placed, order_qty, layout_def)
            if over:
                logger.warning(
                    "EditorRenderView: rejected over-quantity submission for "
                    "order_id=%s layout=%s (qty=%s)", order_id, layout_name, order_qty,
                )
                return Response({'detail': over}, status=status.HTTP_400_BAD_REQUEST)
            # Under-quantity is accepted; record it so the webhook can tell the
            # caller the customer knowingly submitted fewer photos.
            order_qty_summary = qty_summary(
                placed, order_qty, layout_def,
                request.data.get('qty_shortfall_acknowledged'),
            )

        # ── Collect + validate all upload_ids ───────────────────────────────
        all_upload_ids = []
        for canvas in canvases_payload:
            for frame in canvas.get('frames', []):
                uid = str(frame.get('upload_id', '') or '').strip()
                if uid:
                    all_upload_ids.append(uid)

        if not all_upload_ids:
            return Response({'detail': 'No upload_id values found in canvases[].frames.'}, status=status.HTTP_400_BAD_REQUEST)

        uploaded_qs = UploadedFile.objects.filter(
            upload_session_id__in=all_upload_ids,
            api_key=api_key,
            is_deleted=False,
        )
        upload_id_to_path = {f.upload_session_id: f.file_path for f in uploaded_qs}

        missing = [uid for uid in all_upload_ids if uid not in upload_id_to_path]
        if missing:
            return Response(
                {'detail': f'upload_id(s) not found or not owned by this key: {missing[:3]}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Build position-explicit image_paths (canvas0_frame0, canvas0_frame1, …) ─
        # One entry per frame, in canvas/frame order, so this list indexes
        # IDENTICALLY to the per-frame transforms the engine reads back from
        # editor_state (_extract_frame_transforms walks the same nested order).
        # A frame whose photo is missing (null upload_id — the file was lost
        # client-side) gets an empty-string slot instead of being dropped.
        # Dropping it collapsed the list and shifted every later photo one
        # frame to the left, so photos printed in the wrong windows with no
        # error — the silent wrong-print bug. The engine renders an empty slot
        # as a blank frame (layout_engine.engine._composite_canvas). Present-
        # but-unresolved upload_ids were already rejected with 400 above, so
        # the only '' entries here are genuinely-missing photos.
        image_paths = []
        for canvas in canvases_payload:
            for frame in canvas.get('frames', []):
                uid = str(frame.get('upload_id', '') or '').strip()
                image_paths.append(upload_id_to_path.get(uid, ''))

        # ── Snapshot the render contract ──────────────────────────────────────
        # Snapshot the render contract into its own field. editor_state stays
        # untouched: it is the frontend's autosaved design, and overwriting it
        # here is what used to blank the editor after every submit. Embedding
        # image_paths in the snapshot also means a post-submit autosave (which
        # resets CanvasData.image_paths to []) cannot starve a queued job.
        render_state = {
            'canvases': canvases_payload,
            'image_paths': image_paths,
            'format_version': 1,
            'include_uploads': include_uploads,
            'qty_summary': order_qty_summary,
        }

        # ── Submit via shared render submission service ──────────────────────
        from api.render_submission import RenderSubmissionService, RenderSubmissionError

        service = RenderSubmissionService(api_key, order_id)
        try:
            result = service.submit(
                layout_name=layout_name,
                image_paths=image_paths,
                export_format=export_format,
                fit_mode='cover',
                render_state=render_state,
                callback_url=callback_url,
                queue_name='standard',
            )
            return Response(result, status=status.HTTP_202_ACCEPTED)
        except RenderSubmissionError as exc:
            logger.error("EditorRenderView: failed to create render job for order_id=%s: %s", order_id, exc)
            return Response({'detail': 'Failed to submit render job.'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
