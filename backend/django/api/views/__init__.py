import os
import re
import json
import logging
from typing import List
from django.conf import settings
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.parsers import BaseParser
from rest_framework.response import Response
from rest_framework import status
from django.utils.crypto import get_random_string
from django.core.exceptions import ValidationError
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiExample, OpenApiResponse, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from layout_engine.engine import LayoutEngine
from services.storage import get_storage
from services.order_qty import (
    InvalidOrderQty,
    MAX_ORDER_QTY,
    count_placed_photos,
    parse_order_qty,
    qty_summary,
    qty_violation,
)
from ..permissions import (
    IsAuthenticatedWithAPIKey,
    CanGenerateLayouts,
    CanListLayouts,
    CanAccessExports,
)
from ..authentication import APIKeyUser
from ..validators import validate_image_files
from ..models import UploadedFile, ExportedResult, EmbedSession

# Re-exports: views moved into submodules stay importable as api.views.<Name>
# (urls.py, tests and management commands import them from here). See
# docs/LARGE_FILE_SPLIT_PLAN.md for what lives where.
from .system import HealthView, ConfigView, CSPReportView  # noqa: F401
from .ops import (  # noqa: F401
    CeleryMonitoringView,
    OrderDataPurgeView,
    _jobs_per_day_status,
    _disk_status,
)
from .media import OrientationDetectView, HeicConvertView  # noqa: F401
from .layouts import (  # noqa: F401
    ListLayoutsView,
    GetLayoutView,
    ExternalLayoutDetailView,
    MaskDownloadView,
    _read_layout_def,
    _summarize_layout,
)
from .layout_admin import (  # noqa: F401
    LayoutManagementView,
    invalidate_layout_caches,
    LAYOUT_ID_NOTE,
)
from .calendar_assets import (  # noqa: F401
    FontsView,
    CalendarStylesView,
    HolidaysView,
    DEFAULT_FONTS,
    OPS_WRITE_AUTH,
    _FONTS_CACHE_KEY,
    _STORAGE_CACHE_TTL,
    _ASSET_UNAVAILABLE_503,
    _OPS_GATE_RESPONSES,
    _CALENDAR_STYLES_CACHE_KEY,
    _CALENDAR_STYLE_CACHE_KEY,
    _HOLIDAYS_CACHE_KEY,
    _read_fonts,
    _write_fonts,
    _asset_unavailable_response,
    _list_calendar_styles,
    _read_calendar_style,
    _write_calendar_style,
    _safe_locale_year,
    _read_holidays,
    _write_holidays,
)

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
    def _is_safe_layout_name(name: str) -> bool:
        """
        Is this name structurally safe to build a path from?

        Purely a path-traversal guard — it says nothing about whether the
        layout exists. Callers that need existence must check separately so a
        missing layout can answer 404 rather than 400.
        """
        if not name:
            return False
        return not (
            '/' in name or '\\' in name or '..' in name or name.startswith('.')
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
        a resource. Read endpoints should use _is_safe_layout_name +
        _layout_exists so "not found" reports as 404.
        """
        return GenerateLayoutView._is_safe_layout_name(name) and \
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


class SecureExportDownloadView(APIView):
    """
    Secure file serving endpoint for exports.
    Requires authentication and checks file path to prevent traversal attacks.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanAccessExports]

    @extend_schema(
        tags=["exports"],
        summary="Download exported file",
        description=(
            "Stream a generated export file (HQ PNG, imposition sheet, etc.) "
            "back to the authenticated caller. Path traversal is prevented server-side."
        ),
        parameters=[
            OpenApiParameter("file_path", OpenApiTypes.STR, OpenApiParameter.PATH, description="Relative path to the export file"),
        ],
        responses={
            200: OpenApiResponse(description="Binary file stream"),
            403: OpenApiResponse(description="Path traversal attempt detected"),
            404: OpenApiResponse(description="Export file not found"),
        },
    )
    def get(self, request, file_path: str):
        """Download a generated export file securely."""
        try:
            # Validate file path - prevent traversal attacks
            if not self._is_path_safe(file_path):
                logger.warning(f"Attempted traversal attack: {file_path}")
                return Response(
                    {"detail": "Access denied"},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            # Construct full path — export files live under EXPORTS_DIR.
            # MEDIA_ROOT does not exist in this project's settings; using it
            # caused every download to resolve against a nonexistent directory.
            base_dir = settings.EXPORTS_DIR
            full_path = os.path.join(base_dir, file_path)
            
            # Double-check path safety (defense in depth)
            if not self._is_full_path_safe(full_path):
                logger.warning(f"Path safety check failed: {full_path}")
                return Response(
                    {"detail": "Access denied"},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            # Check if file exists
            if not os.path.exists(full_path) or not os.path.isfile(full_path):
                return Response(
                    {"detail": "File not found"},
                    status=status.HTTP_404_NOT_FOUND
                )
            
            # Serve file with proper headers
            with open(full_path, 'rb') as f:
                file_content = f.read()
            
            import mimetypes
            content_type, _ = mimetypes.guess_type(full_path)
            response = Response(file_content)
            response['Content-Type'] = content_type or 'application/octet-stream'
            response['Content-Length'] = len(file_content)
            response['Content-Disposition'] = f'attachment; filename="{os.path.basename(full_path)}"'
            
            # Log download
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            if api_key:
                logger.info(f"Export downloaded: {file_path} by {api_key.name}")
            
            return response
        
        except Exception as e:
            logger.error(f"Error downloading export: {str(e)}")
            return Response(
                {"detail": "Failed to download file"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    @staticmethod
    def _is_path_safe(file_path: str) -> bool:
        """
        Check if file path is safe (no traversal attempts).
        """
        # Reject paths with traversal patterns
        if '..' in file_path or file_path.startswith('/') or file_path.startswith('\\'):
            return False
        
        # Reject paths with special characters
        if any(c in file_path for c in ['\\', ':', '\x00']):
            return False
        
        return True
    
    @staticmethod
    def _is_full_path_safe(full_path: str) -> bool:
        """
        Verify full path is within allowed directory.
        Defense in depth against traversal.
        """
        try:
            real_path = os.path.realpath(full_path)
            real_exports_dir = os.path.realpath(settings.EXPORTS_DIR)
            
            # Ensure path is within EXPORTS_DIR
            return real_path.startswith(real_exports_dir) and os.path.isfile(real_path)
        except:
            return False


class EmbedSessionView(APIView):
    """
    Exchange a real API key for a short-lived embed token (2 hours).
    The token is safe to place in an iframe URL — the real key never reaches the browser.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    # order_id charset — caller-controlled identifier that flows into Django
    # logs, the X-Order-ID header, and CanvasData.order_id. Allow the
    # conservative set used by typical OMS systems: alphanumerics + _ . -
    # up to 64 chars. Anything else is rejected with 400.
    ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')

    @extend_schema(
        tags=["embed"],
        summary="Create embed session token",
        description=(
            "Exchange your API key for a **short-lived UUID token** (TTL: 2 hours) "
            "that is safe to embed in an iframe URL.\n\n"
            "### How it works\n\n"
            "```\n"
            "Your server  →  POST /api/embed/session\n"
            "                (optionally include callback_url for the completion webhook)\n"
            "             ←  { token: '<uuid>' }\n\n"
            "Your page    →  <iframe src=\"https://product-editor.printo.in/editor/layout/<name>?token=<uuid>\" />\n\n"
            "Customer edits canvas and clicks Save & Continue\n\n"
            "Your page    ←  window.postMessage({ type: 'pe:render_job', jobId, orderID })\n"
            "                (UX ping only — the rendered ZIP is delivered out-of-band\n"
            "                 via a signed webhook to your callback_url; see\n"
            "                 docs/INTEGRATION.md for the full contract)\n\n"
            "Customer taps the editor's Back button (optional)\n\n"
            "Your page    ←  window.postMessage({ type: 'pe:back', orderID })\n"
            "                (deliberately not browser-history navigation — an iframe\n"
            "                 shares its tab's back/forward stack with the parent page,\n"
            "                 so calling history.back() from inside it could navigate\n"
            "                 YOUR page, or even carry the customer off your site\n"
            "                 entirely. This message hands you the signal instead; it's\n"
            "                 a no-op until you add a listener — see docs/INTEGRATION.md)\n"
            "```\n\n"
            "### Ordered quantity (`qty`)\n\n"
            "Send `qty` in this body and it is stored on the session, injected "
            "upstream as `X-Order-Qty`, and **enforced at render submission** — the "
            "customer's browser never sees a number it could edit. It caps how many "
            "photos the customer can submit:\n\n"
            "- **More than `qty`** — blocked. The editor offers *Keep first N* or "
            "*Choose again*, and `POST /api/editor/render` rejects an over-count "
            "submission with 400 even if the editor is bypassed.\n"
            "- **Fewer than `qty`** — allowed, with an auto-fill prompt and a "
            "pre-submit warning. Deliberate, and true on the server too: a wrong "
            "`qty` must not strand a real order at checkout. The completion webhook "
            "carries `qty_summary` — `{ordered_qty, placed_photos, shortfall, "
            "customer_acknowledged_shortfall, summary}`, counted by the server — so you can "
            "record when a customer knowingly submitted fewer photos than ordered. "
            "It is `null` when no `qty` was set or the product is multi-surface, "
            "calendar or book.\n"
            "- Applies to **single-surface products only**. Two-sided products, "
            "calendars and books have a surface count fixed by the layout.\n\n"
            "The legacy `?qty=N` URL parameter still works as a fallback for callers "
            "that have not moved the value into this body, but it is browser-editable "
            "and not enforced server-side. Prefer this field.\n\n"
            "### Security guarantees\n\n"
            "- Token is a disposable UUID — never the real API key\n"
            "- All subsequent calls from the embed page go through the Next.js server-side proxy "
            "which resolves the token to the real key without exposing it to the browser\n"
            "- Token expires after 2 hours; generate a fresh one per customer session\n\n"
            "**Auth:** `Authorization: Bearer <real-api-key>` (server-to-server only)"
        ),
        request=inline_serializer(
            name="EmbedSession",
            fields={
                "order_id": drf_serializers.CharField(
                    required=False,
                    help_text=(
                        "Your job/order identifier. 1-64 chars, `A-Z a-z 0-9 _ . -` only. "
                        "Stored server-side and injected as the `X-Order-ID` header on every "
                        "upstream call — it never appears in the iframe URL."
                    ),
                ),
                "callback_url": drf_serializers.CharField(
                    required=False,
                    help_text=(
                        "HTTPS URL to POST the signed completion webhook to (max 2000 chars). "
                        "Omit it and no webhook fires — poll `/api/render-status/<job_id>/` instead. "
                        "See docs/INTEGRATION.md for the payload and HMAC verification."
                    ),
                ),
                "include_uploads": drf_serializers.BooleanField(
                    required=False,
                    default=True,
                    help_text=(
                        "Include the customer's original photos (`1_customer_uploads/`) in the "
                        "delivered ZIP. Set false for a smaller, faster download of just the "
                        "mock + print files; `uploads_download_url` is then null."
                    ),
                ),
                "qty": drf_serializers.IntegerField(
                    required=False,
                    min_value=1,
                    max_value=MAX_ORDER_QTY,
                    help_text=(
                        "Number of items the customer ordered. Stored on the session and "
                        "injected as the `X-Order-Qty` header, so the editor's cap cannot be "
                        "raised from the browser. Omit it and no quantity is enforced."
                    ),
                ),
            },
        ),
        responses={
            201: inline_serializer(
                name="EmbedSessionResponse",
                fields={
                    "token": drf_serializers.UUIDField(help_text="Short-lived embed token — safe to put in iframe URL"),
                    "expires_at": drf_serializers.DateTimeField(help_text="ISO 8601 expiry timestamp (2 hours from now)"),
                    "embed_url_template": drf_serializers.CharField(
                        help_text="URL template — replace `{layout_name}` with your layout, e.g. `retro_polaroid_4.2x3.5`"
                    ),
                },
            ),
            400: OpenApiResponse(
                description=(
                    "`order_id` outside `^[A-Za-z0-9_.\\-]{1,64}$`, `callback_url` over "
                    "2000 chars, `callback_url` failing the https-only + "
                    "public-address SSRF check, or `qty` that is not a whole number "
                    "between 1 and 10000."
                ),
            ),
            401: OpenApiResponse(description="Invalid or missing API key"),
        },
        examples=[
            OpenApiExample(
                "Successful token creation",
                value={
                    "token": "a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                    "expires_at": "2024-01-15T14:30:00+05:30",
                    "embed_url_template": "/embed/editor/{layout_name}?token=a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                },
                response_only=True,
                status_codes=["201"],
            ),
        ],
    )
    def post(self, request):
        from datetime import timedelta
        api_key = request.user.api_key
        expires_at = timezone.now() + timedelta(hours=2)
        # Caller's job/order identifier — stored server-side so the proxy can
        # inject it as X-Order-ID without putting it in the iframe URL.
        order_id = str(request.data.get('order_id', '') or '').strip()
        if order_id and not self.ORDER_ID_RE.match(order_id):
            return Response(
                {'detail': 'order_id must be 1-64 chars; allowed: A-Z a-z 0-9 _ . -'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Optional webhook URL the caller wants notified when render completes.
        # No domain allowlist — auth is enforced by the api_key the caller
        # already holds, and the HMAC signature (sent on the callback) lets
        # them verify the request actually came from us. We do require https
        # to avoid leaking download_url + signature over plaintext.
        callback_url = str(request.data.get('callback_url', '') or '').strip()
        if callback_url:
            if len(callback_url) > 2000:
                return Response(
                    {'detail': 'callback_url exceeds 2000-char limit.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # SSRF guard (Phase 4): https-only + the host must resolve to a
            # publicly-routable address (no internal services, cloud metadata,
            # loopback, RFC1918). Re-checked at webhook send time too.
            from services.url_safety import validate_public_https_url
            try:
                validate_public_https_url(callback_url)
            except ValidationError as exc:
                return Response(
                    {'detail': exc.messages[0] if exc.messages else 'callback_url is not allowed.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Whether the completion webhook's ZIP should include the customer's
        # original uploads (1_customer_uploads/). Defaults True so existing
        # integrations are unchanged; pass include_uploads=false for a smaller,
        # faster download that ships only the mock + print files.
        include_uploads = str(
            request.data.get('include_uploads', True)
        ).strip().lower() not in ('0', 'false', 'no', 'off')

        # Ordered quantity. Absent means "the caller did not say" and nothing
        # is enforced — distinct from a zero, which is rejected. Stored here
        # rather than read off the iframe URL so the cap the editor applies
        # can't be raised by editing that URL; EditorRenderView re-checks it at
        # submit from the header the proxy injects.
        try:
            qty = parse_order_qty(request.data.get('qty'))
        except InvalidOrderQty as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        session = EmbedSession.objects.create(
            api_key=api_key,
            expires_at=expires_at,
            order_id=order_id,
            callback_url=callback_url,
            include_uploads=include_uploads,
            qty=qty,
        )
        return Response({
            'token': str(session.token),
            'expires_at': session.expires_at.isoformat(),
            # The real iframe entry route (next.config.mjs frame-ancestors +
            # editor/layout/[name]/page.tsx). The old /embed/editor/... path
            # never existed. Advisory field — the caller substitutes the
            # layout name.
            'embed_url_template': '/editor/layout/{layout_name}?token=' + str(session.token),
            'order_id': order_id or None,
            'callback_url': callback_url or None,
            'include_uploads': include_uploads,
            'qty': qty,
        }, status=status.HTTP_201_CREATED)


class EmbedSessionValidateView(APIView):
    """
    Internal endpoint called only by the Next.js server-side proxy to resolve a token → real API key.
    Not intended for direct use by external clients.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["embed"],
        summary="Validate embed token (internal proxy use only)",
        description=(
            "**⚠️ Internal use only** — called exclusively by the Next.js server-side proxy "
            "(`/api/embed/proxy/[...path]`). Do not call this from browser JavaScript.\n\n"
            "Validates the embed token and returns the underlying API key so the proxy can "
            "forward the request to Django with a real `Authorization: Bearer` header — "
            "without ever exposing the key to the browser.\n\n"
            "### Protection\n\n"
            "Protected by a shared `X-Internal-Secret` header that is set only in the server "
            "environment and never accessible to browsers. If `EMBED_INTERNAL_SECRET` env var "
            "is set, requests missing or providing a wrong secret receive `403 Forbidden`."
        ),
        parameters=[
            OpenApiParameter(
                "token",
                OpenApiTypes.UUID,
                OpenApiParameter.QUERY,
                required=True,
                description="The embed session UUID from the iframe URL",
            ),
        ],
        responses={
            200: inline_serializer(
                name="EmbedValidateResponse",
                fields={"api_key": drf_serializers.CharField(help_text="The real API key backing this embed session")},
            ),
            400: OpenApiResponse(description="`token` query param is missing"),
            401: OpenApiResponse(description="Token not found or expired"),
            403: OpenApiResponse(description="Missing or invalid `X-Internal-Secret` header"),
            503: OpenApiResponse(
                description="`EMBED_INTERNAL_SECRET` is not configured. Fails closed in production rather than serving an api_key unprotected.",
            ),
        },
        # Uses none of the three normal schemes — the gate is the shared header
        # declared in SPECTACULAR_SETTINGS["APPEND_COMPONENTS"].
        auth=[{"InternalSecret": []}],
    )
    def get(self, request):
        import os
        import hmac as _hmac
        # This endpoint returns the partner's REAL api_key, so it must only be
        # reachable by the trusted embed proxy — never by an arbitrary embed
        # token holder (a token rides in the iframe URL and is not itself a
        # secret). Access is gated by a shared X-Internal-Secret that only the
        # proxy knows; frontend + backend both read EMBED_INTERNAL_SECRET from
        # .env via env_file.
        expected_secret = os.getenv('EMBED_INTERNAL_SECRET', '')
        provided = request.headers.get('X-Internal-Secret', '')
        if expected_secret:
            # Constant-time compare so a wrong guess can't be timing-probed.
            if not _hmac.compare_digest(provided, expected_secret):
                return Response({'detail': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)
        elif not settings.DEBUG:
            # Fail closed in production: an unset secret would hand the partner
            # api_key to any token holder. Refuse rather than leak. Dev (DEBUG)
            # keeps working on localhost without the secret for convenience.
            logger.error(
                "EMBED_INTERNAL_SECRET is not set — refusing to serve api_key "
                "for an embed token in production. Set it in .env (read by both "
                "the backend and frontend containers via env_file)."
            )
            return Response(
                {'detail': 'Embed validation is not configured.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        token = request.query_params.get('token', '').strip()
        if not token:
            return Response({'detail': 'token param required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            session = EmbedSession.objects.select_related('api_key').get(token=token)
        except (EmbedSession.DoesNotExist, Exception):
            return Response({'detail': 'Invalid token'}, status=status.HTTP_401_UNAUTHORIZED)

        if not session.is_valid():
            return Response({'detail': 'Token expired or revoked'}, status=status.HTTP_401_UNAUTHORIZED)

        # Sliding TTL — keep long-lived editing sessions alive without a hard
        # cutoff at the original 2-hour mark. Only extend when the session is
        # already in its second half so we don't write on every request when
        # the proxy cache (110-min TTL) is hammering us at the start.
        from datetime import timedelta
        now = timezone.now()
        # original lifetime is 2h; extend by 1h when remaining < 30 min
        if (session.expires_at - now) < timedelta(minutes=30):
            session.expires_at = now + timedelta(hours=1)
            session.save(update_fields=['expires_at'])

        return Response({
            'api_key': session.api_key.key,
            'order_id': session.order_id or None,
            'callback_url': session.callback_url or None,
            'include_uploads': session.include_uploads,
            'qty': session.qty,
            'expires_at': session.expires_at.isoformat(),
        })


# ─── Editor init (batched fetch of cacheable mount data) ─────────────────────

class EditorInitView(APIView):
    """
    GET /api/editor/init?layout=<name>[&surfaces=<csv>]

    Returns the static, cacheable bits the editor needs on mount in one round
    trip: `{ layout, fonts }`. Replaces two parallel fetches (`/layouts/<name>`
    + `/fonts`) with a single TLS-friendly request — meaningful on cold-start
    embed iframes where the connection isn't warm yet.

    Per-order live data (canvas-state) is intentionally NOT included so this
    response stays cacheable. Frontend keeps `/canvas-state/<order_id>/` as a
    separate request (no cache, tenant-scoped to the api_key+order_id pair).

    Permission and surface filtering match `GetLayoutView` exactly so the
    embed proxy and ops admin paths behave identically.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["editor"],
        summary="Batched editor mount payload",
        description=(
            "Returns the static, cacheable bits the editor needs on mount: "
            "`{ layout, fonts, order_id, qty }`. This is what an embed iframe's "
            "URL hits on load. `layout.name` is immutable once a layout is "
            "created (2026-09-16) — safe to hardcode in your iframe URL "
            "indefinitely. A handful of layouts renamed before that date still "
            "resolve under their pre-rename identifier; the response's "
            "`layout.name` then reflects the current one, which may differ from "
            "the `layout` query param you sent. `layout.displayName` is the "
            "ops-curated customer-facing name, independent of `layout.name`."
        ),
        parameters=[
            OpenApiParameter("layout", OpenApiTypes.STR, OpenApiParameter.QUERY, required=True),
            OpenApiParameter("surfaces", OpenApiTypes.STR, OpenApiParameter.QUERY, required=False),
        ],
        responses={
            200: inline_serializer(
                name="EditorInitResponse",
                fields={
                    "layout": drf_serializers.DictField(),
                    "fonts": drf_serializers.ListField(child=drf_serializers.CharField()),
                    "order_id": drf_serializers.CharField(
                        allow_null=True,
                        help_text="Echo of the embed session's order_id; null for dashboard requests.",
                    ),
                    "qty": drf_serializers.IntegerField(
                        allow_null=True,
                        help_text=(
                            "Echo of the embed session's ordered quantity; null when the "
                            "session carries none or the caller is the dashboard."
                        ),
                    ),
                },
            ),
            400: OpenApiResponse(description="Missing or invalid `layout` query param"),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request):
        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue, default_display_name_for

        name = (request.query_params.get('layout') or '').strip()
        if not name:
            return Response({'detail': '`layout` query param required'}, status=status.HTTP_400_BAD_REQUEST)
        # 400 for a malformed name, 404 for one that simply isn't there — the
        # editor needs to tell "bad request" apart from "this layout is gone".
        if not GetLayoutView._is_safe_layout_name(name):
            return Response({'detail': 'Invalid layout name'}, status=status.HTTP_400_BAD_REQUEST)

        surfaces_param = request.query_params.get('surfaces', '')
        # Reuse the GetLayoutView cache key so a request to either endpoint
        # warms both. Cache TTL matches GetLayoutView (2 min).
        cache_key = f"layout_detail:{name}:{surfaces_param}"
        layout_data = django_cache.get(cache_key)

        if layout_data is None:
            # Query LayoutCatalogue from Postgres — resolve_active follows a
            # rename alias so a stale name (e.g. a partner's hardcoded embed
            # URL, or an iframe already open when a rename lands) still
            # resolves instead of 404ing the customer mid-order.
            try:
                layout = LayoutCatalogue.resolve_active(name, require_public=True)
            except LayoutCatalogue.DoesNotExist:
                return Response(
                    {'detail': f"Layout '{name}' not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Fetch definition from database
            layout_data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            layout_data['name'] = layout.name
            layout_data['displayName'] = layout.display_name or default_display_name_for(layout.name)

            if surfaces_param and 'surfaces' in layout_data and isinstance(layout_data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                layout_data['surfaces'] = [
                    s for s in layout_data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]
            django_cache.set(cache_key, layout_data, 120)

        # _read_fonts has its own Redis-backed 5 min cache (see _FONTS_CACHE_KEY).
        # order_id echoes the proxy-injected X-Order-ID (EmbedSession.order_id)
        # so the embed iframe can adopt the SESSION id for autosave/restore
        # keying instead of a throwaway client-generated one (Phase 3 — an
        # iframe reload used to orphan the autosave). Only the trusted proxies
        # can set this header (both build forward headers from scratch);
        # dashboard requests carry none → null.
        #
        # qty echoes X-Order-Qty the same way, so the editor caps against the
        # quantity the CALLER set rather than the browser-editable ?qty=N. Null
        # for a dashboard request or a session created without one, and the
        # editor then falls back to that URL param.
        try:
            init_qty = parse_order_qty(request.headers.get('X-Order-Qty'))
        except InvalidOrderQty:
            # A header only the trusted proxy can set, sourced from a validated
            # column — if it is somehow unusable, drop it rather than fail the
            # editor's mount request over it.
            init_qty = None
        response = Response({
            'layout': layout_data,
            'fonts': _read_fonts(),
            'order_id': (request.headers.get('X-Order-ID') or '').strip() or None,
            'qty': init_qty,
        })
        # Cacheable on the proxy edge for short-lived shared cache; private so a
        # tenant's surfaces= filter doesn't bleed across tenants.
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response


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


class RenderJobDownloadView(APIView):
    """
    Stream the output files of a completed render job as a ZIP archive.

    This replaces the client-side ZIP assembly (JSZip + canvas re-render) with a
    lightweight server-side stream, eliminating the CPU/RAM spike on low-end devices.

    GET /api/jobs/<job_id>/download/[?content=all|print|mock|uploads]

    ``content`` selects WHICH part of the job is packaged, so a caller that
    stores mock and print artefacts in separate fields (printo.in does) can
    fetch each one directly instead of receiving one archive and splitting it:

      all      (default) — the original three-folder archive:
                           1_customer_uploads/, 2_mock/, 3_print/
      print    — the 300 DPI print files only, at the archive root
      mock     — the small web preview JPEGs only, at the archive root
      uploads  — the customer's original photos only, at the archive root

    ``all`` is the default and its layout is unchanged, so existing callers
    reading ``download_url`` keep working byte-for-byte.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanAccessExports]

    #: Valid ?content= values. 'all' must stay the default for back-compat.
    CONTENT_CHOICES = ('all', 'print', 'mock', 'uploads')

    @extend_schema(
        tags=["exports"],
        summary="Download completed job output as ZIP",
        description=(
            "Streams output files for a completed render job as a ZIP archive. "
            "Use `content` to fetch one part on its own (print / mock / uploads) "
            "instead of the combined archive. Returns 409 if the job has not yet "
            "completed."
        ),
        parameters=[
            OpenApiParameter(
                "content", OpenApiTypes.STR, OpenApiParameter.QUERY,
                enum=list(CONTENT_CHOICES),
                description=(
                    "Which part to package. `all` (default) returns the combined "
                    "1_customer_uploads/ + 2_mock/ + 3_print/ archive; the others "
                    "return just that part, flat at the archive root."
                ),
            ),
            OpenApiParameter(
                "include_uploads", OpenApiTypes.BOOL, OpenApiParameter.QUERY,
                description=(
                    "Include the customer's original photos. Defaults to true. "
                    "Ignored when `content` is `print` or `mock`."
                ),
            ),
        ],
        responses={
            200: OpenApiResponse(description="application/zip binary stream"),
            400: OpenApiResponse(description="Invalid content parameter"),
            404: OpenApiResponse(description="Job not found or no matching files"),
            409: OpenApiResponse(description="Job not yet completed"),
        },
    )
    def get(self, request, job_id):
        import io
        import zipfile
        import tempfile
        from django.http import FileResponse
        from PIL import Image
        from api.models import RenderJob, UploadedFile

        try:
            job = RenderJob.objects.select_related('canvas_data').get(id=job_id)
        except RenderJob.DoesNotExist:
            return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)

        # Ownership check: APIKeyUsers may only download their own jobs.
        if isinstance(request.user, APIKeyUser):
            if job.canvas_data.api_key != request.user.api_key:
                return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)

        if job.status != 'completed':
            return Response(
                {'detail': f'Job is not completed yet (status: {job.status})'},
                status=status.HTTP_409_CONFLICT,
            )

        if not job.output_paths:
            return Response(
                {'detail': 'No output files available for this job'},
                status=status.HTTP_404_NOT_FOUND,
            )

        content = str(request.query_params.get('content', 'all')).strip().lower() or 'all'
        if content not in self.CONTENT_CHOICES:
            return Response(
                {'detail': f"content must be one of: {', '.join(self.CONTENT_CHOICES)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        want_print = content in ('all', 'print')
        want_mock = content in ('all', 'mock')

        # ── 3_print/ — high-res 300 DPI render output ──────────────────────
        # Path-traversal guard: every path must resolve inside EXPORTS_DIR.
        exports_root = os.path.realpath(settings.EXPORTS_DIR)
        safe_print_paths = []
        for raw_path in job.output_paths:
            resolved = os.path.realpath(raw_path)
            if resolved.startswith(exports_root + os.sep) and os.path.isfile(resolved):
                safe_print_paths.append(resolved)
            else:
                logger.warning("RenderJobDownloadView: blocked print path %s for job %s", raw_path, job_id)

        # Only fatal when the caller actually wants render output — a
        # ?content=uploads fetch is still serviceable without it.
        if not safe_print_paths and (want_print or want_mock):
            return Response(
                {'detail': 'No accessible output files found on disk'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # ── 1_customer_uploads/ — original images the customer uploaded ────
        # `CanvasData.image_paths` is the JSON list of file paths recorded at
        # submission time (UploadedFile.file_path entries). Restore the
        # human-readable filename from UploadedFile.original_filename when
        # available — file_path uses a sanitised hash-prefixed name on disk.
        # Included only when the caller opts in (?include_uploads=1). The
        # dashboard "Ready to download" modal leaves this OFF by default: the
        # raw originals are the biggest, slowest part of the archive and ops
        # rarely needs them, so excluding them makes the download much faster.
        # An ABSENT param defaults to true, so the embed webhook consumer keeps
        # its existing contract (it fetches download_url with no query string).
        canvas = job.canvas_data
        include_uploads = str(
            request.query_params.get('include_uploads', 'true')
        ).strip().lower() not in ('0', 'false', 'no', 'off')
        want_uploads = include_uploads and content in ('all', 'uploads')
        safe_upload_entries: list[tuple[str, str]] = []  # (resolved_path, arcname_basename)
        if want_uploads:
            uploads_root = os.path.realpath(settings.UPLOADS_DIR)
            upload_records = {
                uf.file_path: uf.original_filename
                for uf in UploadedFile.objects.filter(
                    file_path__in=(canvas.image_paths or []),
                    is_deleted=False,
                )
            }
            for raw_path in (canvas.image_paths or []):
                resolved = os.path.realpath(raw_path)
                if not resolved.startswith(uploads_root + os.sep):
                    logger.warning("RenderJobDownloadView: blocked upload path %s for job %s", raw_path, job_id)
                    continue
                if not os.path.isfile(resolved):
                    # File may have been GC'd or deleted; skip gracefully.
                    logger.info("Upload missing on disk for job %s: %s", job_id, raw_path)
                    continue
                arcname_basename = upload_records.get(raw_path) or os.path.basename(resolved)
                safe_upload_entries.append((resolved, arcname_basename))

        # ── 2_mock/ — downscaled web-friendly previews of the print files ──
        # Mocks are pre-generated at render time as a JPEG sibling next to
        # each print file (see `_write_output_atomic` in layout_engine).
        # We just bundle them here — no CPU work at download time. The
        # on-the-fly fallback below covers older jobs rendered before the
        # render-time mock generation landed; can be removed once those
        # have aged out via GC.
        # Settings mirror engine.py — keep in sync.
        MOCK_LONG_EDGE = 600
        MOCK_QUALITY = 70

        def _build_mock_jpeg_bytes(print_path: str) -> bytes | None:
            """Fallback for older jobs that don't have a mock sibling on disk."""
            try:
                with Image.open(print_path) as im:
                    im.load()
                    if im.format not in ('PNG', 'JPEG', 'JPG', 'TIFF', 'WEBP'):
                        return None
                    rgb = im.convert('RGB')
                    rgb.thumbnail(
                        (MOCK_LONG_EDGE, MOCK_LONG_EDGE),
                        Image.Resampling.LANCZOS,
                    )
                    buf = io.BytesIO()
                    rgb.save(buf, format='JPEG', quality=MOCK_QUALITY)
                    return buf.getvalue()
            except Exception as exc:
                logger.warning(
                    "RenderJobDownloadView: fallback mock generation failed for %s: %s",
                    print_path, exc,
                )
                return None

        # Build the ZIP on disk in a temp file living under EXPORTS_DIR (same
        # filesystem as the source files; lets the OS use sendfile for the read
        # back). This replaces the previous io.BytesIO buffer that pinned the
        # entire archive in worker memory — a 200-PNG render could push 500 MB
        # per concurrent download. Streaming from disk via FileResponse keeps
        # worker RAM flat regardless of archive size.
        # PNG files are already DEFLATE-compressed — ZIP_STORED skips the
        # redundant pass and saves CPU for marginal size savings.
        # Human-friendly, short download name: the layout name plus an 8-char
        # job suffix. The full job UUID produced an unwieldy 40-char filename
        # ("job-e557aa7d-3d4f-…-50e9c43bef23.zip"); the short suffix keeps the
        # name compact while still disambiguating repeated downloads of the
        # same layout. layout_name is sanitised for safe use in the
        # Content-Disposition header.
        if content == 'uploads' and not safe_upload_entries:
            return Response(
                {'detail': 'No customer uploads are available for this job'},
                status=status.HTTP_404_NOT_FOUND,
            )

        safe_layout = re.sub(r'[^A-Za-z0-9_.\-]+', '-', (canvas.layout_name or 'design')).strip('-._') or 'design'
        # Single-part archives carry the part in the filename so a caller
        # saving all three doesn't end up with three identically-named files.
        suffix = '' if content == 'all' else f'-{content}'
        zip_name = f"{safe_layout[:48]}-{str(job_id)[:8]}{suffix}.zip"

        # The combined archive keeps its three numbered folders (existing
        # callers extract by that path); a single-part archive puts its files
        # flat at the root, where a folder of one kind would be noise.
        def arcname(folder: str, basename: str) -> str:
            return f'{folder}/{basename}' if content == 'all' else basename
        tmp = tempfile.NamedTemporaryFile(
            mode='w+b', suffix='.zip', delete=False, dir=exports_root,
        )
        mock_count = 0
        try:
            with zipfile.ZipFile(tmp, mode='w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
                # 1_customer_uploads/ — original photos as customer named them
                for path, original_name in safe_upload_entries:
                    zf.write(path, arcname=arcname('1_customer_uploads', original_name))

                # 2_mock/ + 3_print/ — paired by index from the print list
                for print_path in safe_print_paths:
                    print_basename = os.path.basename(print_path)
                    if want_print:
                        zf.write(print_path, arcname=arcname('3_print', print_basename))

                    if not want_mock:
                        continue

                    # Prefer the pre-generated sibling JPEG (cheap path).
                    # Falls back to on-the-fly downscaling for legacy jobs
                    # rendered before the engine started writing siblings.
                    stem = os.path.splitext(print_basename)[0]
                    mock_name = f'{stem}_preview.jpg'
                    sibling_mock = os.path.splitext(print_path)[0] + '_preview.jpg'
                    sibling_mock_real = os.path.realpath(sibling_mock)
                    if (
                        os.path.isfile(sibling_mock_real)
                        and sibling_mock_real.startswith(exports_root + os.sep)
                    ):
                        zf.write(sibling_mock_real, arcname=arcname('2_mock', mock_name))
                        mock_count += 1
                    else:
                        mock_bytes = _build_mock_jpeg_bytes(print_path)
                        if mock_bytes is not None:
                            zf.writestr(
                                arcname('2_mock', mock_name),
                                mock_bytes,
                                compress_type=zipfile.ZIP_STORED,
                            )
                            mock_count += 1
            tmp.flush()
            zip_size = os.fstat(tmp.fileno()).st_size
            tmp.seek(0)
        except Exception:
            tmp.close()
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            raise

        # A mock-only archive with nothing in it is a failure, not an empty
        # success — the caller asked for previews and would otherwise store a
        # valid-looking 22-byte ZIP against the order.
        if content == 'mock' and mock_count == 0:
            tmp.close()
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            logger.warning("No mock previews could be produced for job %s", job_id)
            return Response(
                {'detail': 'No preview images are available for this job'},
                status=status.HTTP_404_NOT_FOUND,
            )

        api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
        if api_key:
            logger.info(
                "Job ZIP downloaded: job=%s content=%s uploads=%d mocks=%d prints=%d size=%d by %s",
                job_id, content, len(safe_upload_entries), mock_count,
                len(safe_print_paths) if want_print else 0, zip_size, api_key.name,
            )

        # FileResponse streams in chunks (8 KB by default) and closes the file
        # when the response ends. Wire a close hook to unlink the temp file so
        # the disk doesn't fill up with stale archives.
        response = FileResponse(
            tmp, as_attachment=True, filename=zip_name, content_type='application/zip',
        )
        response['Content-Length'] = zip_size

        _tmp_path = tmp.name
        original_close = response.close
        def _cleanup_close():
            try:
                original_close()
            finally:
                try:
                    os.unlink(_tmp_path)
                except OSError:
                    pass
        response.close = _cleanup_close
        return response


# ═══════════════════════════════════════════════════════════════════════════════
#  Canvas State Persistence  (P0 — survives page refresh / checkout transition)
# ═══════════════════════════════════════════════════════════════════════════════

class CanvasStateView(APIView):
    """
    Save / load the full editor state for a given order_id.

    PUT  /api/canvas-state/<order_id>/  — upsert editor state (called by the
         frontend on every meaningful edit, debounced ~2 s).
    GET  /api/canvas-state/<order_id>/  — restore editor state on page open or
         refresh.

    The state JSON is opaque to the backend — it stores whatever the frontend
    sends (frames, overlays, colours, surface layouts).  The only thing the
    backend validates is that it's valid JSON and under 5 MB.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    MAX_STATE_SIZE = 5 * 1024 * 1024  # 5 MB

    @extend_schema(
        tags=["canvas-state"],
        summary="Load saved editor state",
        responses={
            200: OpenApiResponse(description="Editor state JSON"),
            404: OpenApiResponse(description="No saved state for this order_id"),
        },
    )
    def get(self, request, order_id: str):
        from api.models import CanvasData

        # NOTE: GET deliberately respects the PATH param (unlike put(), where
        # the session header wins). The embed proxy injects X-Order-ID on
        # every request, so header-precedence here would make pre-adoption
        # autosaves (keyed by the old client-generated id) unreachable — the
        # client's legacy-id restore fallback needs the path to be honoured.
        # Tenant scoping below keeps this safe: a key can only read its own rows.

        # Resolve the API key so we can scope the lookup to the requesting
        # tenant.  Two different keys can legitimately share the same order_id
        # (e.g. separate embed customers); scoping prevents cross-tenant reads.
        api_key = getattr(request.user, 'api_key', None)
        if not api_key:
            return Response({'detail': 'API key required'}, status=status.HTTP_403_FORBIDDEN)

        try:
            canvas = CanvasData.objects.get(order_id=order_id, api_key=api_key)
        except CanvasData.DoesNotExist:
            return Response(
                {'detail': 'No saved state for this order'},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response({
            'order_id': canvas.order_id,
            'layout_name': canvas.layout_name,
            'fit_mode': canvas.fit_mode,
            'editor_state': canvas.editor_state,
            'image_paths': canvas.image_paths,
            'updated_at': canvas.updated_at.isoformat() if canvas.updated_at else None,
        })

    @extend_schema(
        tags=["canvas-state"],
        summary="Save editor state (upsert)",
        description=(
            "Autosave for the editor, called on a short debounce while the customer "
            "works. Keyed by `(order_id, api_key)`.\n\n"
            "The `X-Order-ID` header wins over the path parameter, so autosave and "
            "submit can never key different rows for one session.\n\n"
            "**This writes `editor_state` only.** The submit-time render payload "
            "lives in a separate column owned by the render endpoint. The two were "
            "one field once, and autosave firing after a submit could strip a "
            "queued job's payload. Do not merge them again.\n\n"
            "`image_paths` is deliberately not overwritten on update: blanking it "
            "every couple of seconds once made a customer's uploads unfindable for "
            "erasure, since that column was how a purge located their files."
        ),
        request=inline_serializer(
            name="CanvasStateWrite",
            fields={
                "editor_state": drf_serializers.JSONField(
                    help_text="Opaque editor snapshot — surfaces, frames, transforms, overlays, calendar/book state.",
                ),
                "layout_name": drf_serializers.CharField(
                    help_text="Required — the handler rejects a blank value with 400.",
                ),
                "image_paths": drf_serializers.ListField(
                    required=False, child=drf_serializers.CharField(),
                    help_text="Set on create. Not overwritten on update — see description.",
                ),
                "fit_mode": drf_serializers.ChoiceField(choices=["cover", "contain"], required=False, default="cover"),
            },
        ),
        responses={
            200: OpenApiResponse(description="State updated."),
            201: OpenApiResponse(description="State created."),
            400: OpenApiResponse(description="No order_id resolved from header or path, or `layout_name` missing."),
            403: OpenApiResponse(description="Caller presented no API key — PIA sessions cannot own canvas state."),
        },
    )
    def put(self, request, order_id: str):
        from api.models import CanvasData
        from datetime import timedelta

        # See get(): the embed session's order id wins over the path param so
        # autosave and submit can never key different rows again.
        order_id = (request.headers.get('X-Order-ID') or '').strip() or order_id

        body = request.data
        editor_state = body.get('editor_state')
        layout_name = body.get('layout_name', '')
        image_paths = body.get('image_paths', [])
        fit_mode = body.get('fit_mode', 'cover')

        if not order_id:
            return Response({'detail': 'order_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        if not layout_name:
            return Response({'detail': 'layout_name is required'}, status=status.HTTP_400_BAD_REQUEST)

        # Size guard — editor_state is opaque JSON but we cap it at 5 MB.
        raw = json.dumps(editor_state) if editor_state is not None else '{}'
        if len(raw) > self.MAX_STATE_SIZE:
            return Response(
                {'detail': f'editor_state exceeds {self.MAX_STATE_SIZE // (1024*1024)} MB limit'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_key = None
        if isinstance(request.user, APIKeyUser):
            api_key = request.user.api_key

        if not api_key:
            return Response({'detail': 'API key required'}, status=status.HTTP_403_FORBIDDEN)

        # Look up by (order_id, api_key) so each tenant owns its own namespace.
        # api_key is in the lookup key, NOT in defaults, so it's never changed
        # on update and is always set correctly on create.
        # image_paths is deliberately NOT in the unconditional defaults.
        #
        # update_or_create writes every key in `defaults`, and the editor's
        # autosave payload is {layout_name, editor_state} — it never carries
        # server-side file paths, because the browser never sees them. So
        # passing `image_paths or []` here overwrote the recorded paths with an
        # empty list on every autosave, i.e. every 2 seconds.
        #
        # That is what broke DPDP erasure: purge_order_data() finds a customer's
        # uploads through image_paths, and by the time anyone requested erasure
        # the field had long been blanked. Only write it when the caller
        # actually supplied paths. See docs/DPDP_ERASURE_GAP_PRD.md.
        defaults = dict(
            layout_name=layout_name,
            fit_mode=fit_mode,
            editor_state=editor_state,
            expires_at=timezone.now() + timedelta(days=settings.EXPORT_RETENTION_DAYS),
        )
        if image_paths:
            defaults['image_paths'] = image_paths

        canvas, created = CanvasData.objects.update_or_create(
            order_id=order_id,
            api_key=api_key,
            defaults=defaults,
        )

        logger.info(
            "Canvas state %s: order_id=%s, layout=%s",
            "created" if created else "updated",
            order_id,
            layout_name,
        )

        return Response(
            {
                'order_id': canvas.order_id,
                'layout_name': canvas.layout_name,
                'saved': True,
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


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