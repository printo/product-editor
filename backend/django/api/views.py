import os
import re
import json
import time
import logging
from functools import wraps
from typing import Optional, Dict, Any, List
from django.conf import settings
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.parsers import BaseParser
from rest_framework.response import Response
from rest_framework import status
from django.utils.crypto import get_random_string
from django.core.exceptions import ValidationError
import platform
import signal
import threading
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiExample, OpenApiResponse, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from layout_engine.engine import LayoutEngine
from services.storage import get_storage
from .permissions import IsAuthenticatedWithAPIKey, CanGenerateLayouts, CanListLayouts, CanAccessExports, IsOpsTeam
from .authentication import APIKeyUser
from .validators import validate_image_files
from .models import UploadedFile, ExportedResult, EmbedSession

logger = logging.getLogger(__name__)


def timeout_handler(signum, frame):
    """Handle timeout for long-running operations."""
    raise TimeoutError("Operation timed out")


def with_timeout(seconds=600):
    """Decorator to add timeout to operations. (600 seconds = 10 minutes default — matches Celery render_canvas_task hard limit)"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if (platform.system() == 'Windows'
                    or not hasattr(signal, 'SIGALRM')
                    or threading.current_thread() is not threading.main_thread()):
                # SIGALRM only works on the main thread; skip timeout in worker threads
                return func(*args, **kwargs)
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(seconds)
            try:
                result = func(*args, **kwargs)
                signal.alarm(0)  # Disable alarm
                return result
            except TimeoutError as e:
                logger.error(f"Operation timeout in {func.__name__}: {str(e)}")
                raise
            finally:
                signal.alarm(0)  # Ensure alarm is disabled
        return wrapper
    return decorator


class HealthView(APIView):
    """Health check endpoint - public access."""
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["health"],
        summary="Service health check",
        description="Returns `ok` if the service and database are reachable. No authentication required.",
        responses={
            200: inline_serializer(
                name="HealthResponse",
                fields={
                    "status": drf_serializers.CharField(default="ok"),
                    "database": drf_serializers.CharField(default="connected"),
                    "timestamp": drf_serializers.IntegerField(),
                },
            )
        },
    )
    def get(self, request):
        return Response({
            "status": "ok",
            "database": "connected",
            "timestamp": int(time.time() * 1000)
        })


class ConfigView(APIView):
    """
    Public runtime-config endpoint — exposes a handful of settings the
    browser needs to know to decide which feature paths to activate.

    Kept deliberately tiny so it's safe to hit on every editor mount.
    Anything sensitive (API keys, secrets) MUST NOT be added here.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["config"],
        summary="Public runtime configuration",
        description=(
            "Read-only config flags the frontend needs at boot. Currently "
            "exposes `autoOrientationMode` ('off' | 'mediapipe' | 'hybrid'); "
            "the frontend uses this to decide whether to load the MediaPipe "
            "BlazeFace model and whether to fall through to the server-side "
            "MoveNet pose endpoint when no face is detected client-side."
        ),
        responses={
            200: inline_serializer(
                name="ConfigResponse",
                fields={
                    "autoOrientationMode": drf_serializers.CharField(),
                },
            )
        },
    )
    def get(self, request):
        from django.conf import settings as _s
        response = Response({
            "autoOrientationMode": getattr(_s, "AUTO_ORIENTATION_MODE", "mediapipe"),
        })
        # Brief browser cache so the editor doesn't refetch every navigation;
        # operator restart of backend will still propagate within ~30 s.
        response['Cache-Control'] = 'public, max-age=30, stale-while-revalidate=60'
        return response


def invalidate_layout_caches(name: str | None = None) -> None:
    """
    Drop every cache entry that can serve a stale copy of a layout.

    Three families exist and they must be cleared together:
      * "layouts_list_all"      — public list  (ListLayoutsView)
      * "ops_layouts_list_all"  — ops list     (LayoutManagementView)
      * "layout_detail:<name>:<surfaces>" — per-layout JSON, written by BOTH
        GetLayoutView and EditorInitView, keyed by the optional ?surfaces=
        filter so ONE layout can hold several entries.

    The detail family was previously never invalidated at all. Because the
    renderer reads the layout fresh from disk at render time while the editor
    was served the cached copy, an ops edit opened a window where the customer
    composed against stale frame geometry and the print used the new one — a
    silent wrong print. A deleted layout also stayed openable until its TTL
    lapsed.

    `delete_pattern` is a django_redis extension (the configured backend); it
    is guarded so a non-Redis backend or an unreachable Redis degrades to
    "list caches cleared" rather than failing the write that triggered it.
    """
    from django.core.cache import cache as django_cache

    try:
        django_cache.delete_many(["layouts_list_all", "ops_layouts_list_all"])
    except Exception as exc:  # pragma: no cover — cache must never break a write
        logger.warning("Failed to invalidate list caches: %s", exc)

    if not name:
        return
    try:
        # Covers every ?surfaces= variant for this layout.
        django_cache.delete_pattern(f"layout_detail:{name}:*")
    except AttributeError:
        # Backend without delete_pattern — clear the unparameterised key, which
        # is the one the editor and partner API actually request.
        django_cache.delete(f"layout_detail:{name}:")
    except Exception as exc:  # pragma: no cover — cache must never break a write
        logger.warning("Failed to invalidate layout_detail cache for %s: %s", name, exc)


def _summarize_layout(data):
    """Trim a full layout def down to the fields an external catalog/picker needs.

    Handles both layout shapes: root-`canvas` (single-surface) and `surfaces[]`
    (multi-surface). Only exposes fields that actually exist on disk — there is
    no displayLabel/thumbnail in the layout JSON, so we don't fabricate them.
    """
    canvas = data.get("canvas")
    surfaces = data.get("surfaces")

    dim_src = canvas if isinstance(canvas, dict) else None
    if dim_src is None and isinstance(surfaces, list) and surfaces and isinstance(surfaces[0], dict):
        dim_src = surfaces[0].get("canvas")
    dim_src = dim_src if isinstance(dim_src, dict) else {}

    if isinstance(surfaces, list):
        surface_count = len(surfaces)
        frame_count = sum(
            len(s.get("frames", [])) for s in surfaces if isinstance(s, dict)
        )
    else:
        surface_count = 1
        frame_count = len(data.get("frames", [])) if isinstance(data.get("frames"), list) else 0

    return {
        "name": data.get("name"),
        "productType": data.get("productType"),
        "hasCalendar": data.get("productType") == "calendar",
        "tags": data.get("tags", []),
        "surfaceCount": surface_count,
        "frameCount": frame_count,
        "dimensions": {
            "widthMm": dim_src.get("widthMm"),
            "heightMm": dim_src.get("heightMm"),
            "widthPx": dim_src.get("width"),
            "heightPx": dim_src.get("height"),
            "dpi": dim_src.get("dpi"),
        },
        "updatedAt": data.get("updatedAt"),
    }


class ListLayoutsView(APIView):
    """List available layouts - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="List all available layouts",
        description=(
            "Returns all layout definitions the API key is permitted to use.\n\n"
            "Pass `?fields=summary` to get a slim catalog (name, productType, "
            "hasCalendar, tags, surfaceCount, frameCount, dimensions, updatedAt) "
            "instead of the full layout defs — intended for external systems that "
            "auto-pull the catalog to render a picker."
        ),
        parameters=[
            OpenApiParameter(
                "fields", OpenApiTypes.STR, OpenApiParameter.QUERY,
                required=False,
                description="Set to `summary` for the slim catalog. Omit for full layout defs.",
            ),
        ],
        responses={
            200: inline_serializer(
                name="LayoutListResponse",
                fields={"layouts": drf_serializers.ListField(child=drf_serializers.DictField())},
            ),
            500: OpenApiResponse(description="The layout store could not be read."),
        },
    )
    def get(self, request):
        try:
            from django.core.cache import cache as django_cache
            from api.models import LayoutCatalogue

            CACHE_KEY = "layouts_list_all"
            CACHE_TTL = 120  # 2 minutes — invalidated on layout write

            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                # Query LayoutCatalogue from Postgres — single source of truth
                rows = LayoutCatalogue.objects.filter(
                    is_deprecated=False,
                    is_public=True,
                ).values('name', 'definition', 'product_type', 'category', 'updated_at')

                layouts_data = []
                for row in rows:
                    # Merge definition with metadata for response
                    data = row['definition'].copy() if isinstance(row['definition'], dict) else {}
                    data['name'] = row['name']
                    data['category'] = row['category']
                    data['hasCalendar'] = data.get('productType') == 'calendar'
                    layouts_data.append(data)

                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
                logger.info(f"Layouts cache miss — loaded {len(layouts_data)} layouts from LayoutCatalogue")
            else:
                logger.info(f"Layouts cache hit — serving {len(layouts_data)} layouts")

            # ?fields=summary → slim catalog (name, productType, tags, dimensions,
            # surface/frame counts, updatedAt) instead of the full layout defs.
            # Derived from the same cached full list so one cache serves both.
            if request.query_params.get('fields') == 'summary':
                payload = [_summarize_layout(d) for d in layouts_data]
            else:
                payload = layouts_data

            response = Response({"layouts": payload})
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response
        except Exception as e:
            logger.error(f"Error listing layouts: {str(e)}")
            return Response(
                {"detail": "Failed to list layouts"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


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

            # Save uploaded files
            storage = get_storage()
            upload_paths = []
            for f in files:
                fname = get_random_string(8) + "_" + f.name
                # Per-order directory so erasure can find these by path.
                path = storage.save_upload(fname, f.file, order_id=order_id or '')
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

            # Soft-proof + CMYK pipelines retired; everything renders to the
            # standard queue now.
            queue_name = 'standard'

            # Upsert CanvasData — if the same (order_id, api_key) pair is
            # resubmitted (operator retry, customer re-upload) we update in
            # place rather than blowing up on the unique_together constraint.
            with transaction.atomic():
                canvas, created = CanvasData.objects.update_or_create(
                    order_id=order_id,
                    api_key=api_key,        # part of the lookup key
                    defaults=dict(
                        layout_name=layout_name,
                        image_paths=upload_paths,
                        fit_mode=fit_mode,
                        export_format=export_format,
                        # Invalidate any prior editor-submit snapshot: a
                        # direct-API resubmit must render THESE uploads, not
                        # a stale render_state (whose embedded image_paths
                        # would silently hijack the job — wrong-print class).
                        render_state=None,
                        # callback_url is no longer accepted at this endpoint;
                        # configure it via POST /api/embed/session for the
                        # embed flow. Direct callers should poll render-status.
                        callback_url=None,
                        requires_manual_review=False,
                        expires_at=timezone.now() + timedelta(days=settings.EXPORT_RETENTION_DAYS),
                    ),
                )

                job = RenderJob.objects.create(
                    canvas_data=canvas,
                    celery_task_id=None,  # set after enqueue inside on_commit
                    queue_name=queue_name,
                )

                # Capture loop variables explicitly to avoid late-binding closure bugs.
                _canvas_id = str(canvas.id)
                _job_id = str(job.id)
                _queue = queue_name
                transaction.on_commit(
                    lambda cid=_canvas_id, jid=_job_id, q=_queue: self._enqueue_task(cid, jid, q)
                )

            action = 'created' if created else 'resubmitted'
            logger.info(
                "Async job %s: order_id=%s, job_id=%s, queue=%s",
                action, order_id, job.id, queue_name,
            )

            return Response({
                'job_id': str(job.id),
                'status_url': f'/api/render-status/{job.id}/',
                'queue': queue_name,
                'estimated_wait_seconds': self._estimate_wait_time(queue_name),
            }, status=status.HTTP_202_ACCEPTED)
            
        except Exception as exc:
            logger.error("Error in async generate: %s", exc)
            return Response(
                {"detail": f"Failed to enqueue job: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
    
    def _enqueue_task(self, canvas_id: str, job_id: str, queue_name: str):
        """
        Enqueue render task to Celery and update the job record with the Celery task ID.

        Called inside transaction.on_commit(), so the DB row is guaranteed to exist.
        On failure (e.g. Redis down) the job is immediately marked 'failed' so it
        doesn't silently stay in 'queued' forever.
        """
        from api.tasks import render_canvas_task
        from api.models import RenderJob

        try:
            task = render_canvas_task.apply_async(
                args=[canvas_id, job_id],
                queue=queue_name,
            )
            RenderJob.objects.filter(id=job_id).update(celery_task_id=task.id)
            logger.info(
                "Task enqueued: job_id=%s, celery_task_id=%s, queue=%s",
                job_id, task.id, queue_name,
            )
        except Exception as exc:
            logger.error(
                "Failed to enqueue task for job_id=%s (queue=%s): %s",
                job_id, queue_name, exc,
                exc_info=True,
            )
            # Mark job failed so operators can see it immediately; don't leave it stuck.
            RenderJob.objects.filter(id=job_id).update(
                status='failed',
                error_message=f"Failed to dispatch task to Celery: {exc}",
                completed_at=timezone.now(),
            )

    def _estimate_wait_time(self, queue_name: str) -> int:
        """
        Estimate seconds until a newly-enqueued job will start processing.

        Takes worker concurrency into account: with N concurrent workers, the
        effective wait is depth/concurrency * avg_render_time, not depth * avg_render_time.
        """
        from api.models import RenderJob
        from api.tasks import WORKER_CONCURRENCY

        queued_count = RenderJob.objects.filter(
            queue_name=queue_name,
            status__in=('queued', 'processing'),
        ).count()

        avg_time_per_job = 30 if queue_name == 'priority' else 60
        # Divide by concurrency — jobs drain in parallel across workers.
        concurrency = max(1, WORKER_CONCURRENCY)
        return max(0, int((queued_count / concurrency) * avg_time_per_job))

    @with_timeout(seconds=600)
    def _handle_sync(self, request):
        """Handle synchronous generation request - backward compatible."""
        try:
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

            upload_paths = []
            storage = get_storage()
            start_time = time.time()

            try:
                for f in files:
                    fname = get_random_string(8) + "_" + f.name
                    # Direct-API sync path has no order context -> _no_order bucket.
                    path = storage.save_upload(fname, f.file)
                    upload_paths.append(path)
                    if api_key:
                        UploadedFile.objects.create(
                            api_key=api_key,
                            file_path=path,
                            original_filename=f.name,
                            file_size_bytes=f.size,
                            file_type='image',
                            # Synchronous direct-API path carries no order id;
                            # left blank, swept by the GC on age.
                            order_id='',
                        )

                # Give every render request its own subdirectory so concurrent
                # jobs for the same layout name never overwrite each other's files.
                import uuid as _uuid
                render_id = str(_uuid.uuid4())
                render_exports_dir = os.path.join(settings.EXPORTS_DIR, render_id)
                os.makedirs(render_exports_dir, exist_ok=True)

                engine = LayoutEngine(storage.layouts_dir(), render_exports_dir)
                generation_time_ms = 0

                # ── PNG / PDF export at 300 DPI ──────────────────────────
                outputs = engine.generate(
                    layout_name, upload_paths, fit_mode=fit_mode, export_format=export_format,
                )
                generation_time_ms = int((time.time() - start_time) * 1000)

                if api_key and outputs:
                    for out_path in outputs:
                        ExportedResult.objects.create(
                            api_key=api_key,
                            layout_name=layout_name,
                            export_file_path=out_path,
                            input_files=upload_paths,
                            generation_time_ms=generation_time_ms,
                            file_size_bytes=os.path.getsize(out_path),
                        )

                rel = [os.path.relpath(p, settings.EXPORTS_DIR) for p in outputs]
                logger.info(
                    "Layout generated: %s by %s (%d files, %d ms, format=%s)",
                    layout_name,
                    api_key.name if api_key else "unknown",
                    len(rel),
                    generation_time_ms,
                    export_format,
                )
                return Response({
                    "canvases": rel,
                    "layout_name": layout_name,
                    "export_format": export_format,
                    "generation_time_ms": generation_time_ms,
                })

            except TimeoutError:
                logger.error("Timeout generating layout: %s", layout_name)
                return Response(
                    {"detail": "Layout generation timed out. Try with fewer/smaller images."},
                    status=status.HTTP_408_REQUEST_TIMEOUT,
                )
            except Exception as exc:
                logger.error("Error generating layout '%s': %s", layout_name, exc)
                return Response(
                    {"detail": f"Failed to generate layout: {exc}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        except Exception as exc:
            logger.error("Unexpected error in GenerateLayoutView: %s", exc)
            return Response(
                {"detail": "An unexpected error occurred"},
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
        """Does a layout with this filename stem exist in storage?"""
        try:
            return name in get_storage().list_layouts()
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


def _disk_status():
    """Live disk usage for EXPORTS_DIR, for the ops monitoring endpoint.

    Returns a dict with an `error` key instead of raising: a stat failure must
    degrade one field, not 500 the endpoint an operator is using to find out
    what is wrong.
    """
    import shutil
    try:
        usage = shutil.disk_usage(settings.EXPORTS_DIR)
    except Exception as exc:
        return {'error': str(exc)}
    percent = (usage.used / usage.total) * 100 if usage.total else 0
    return {
        'total_gb': round(usage.total / 1024 ** 3, 2),
        'used_gb': round(usage.used / 1024 ** 3, 2),
        'free_gb': round(usage.free / 1024 ** 3, 2),
        'used_percent': round(percent, 1),
        # Same 80% line garbage_collector_task trips on, so the two agree.
        'pressure': percent > 80,
    }


class CeleryMonitoringView(APIView):
    """Monitoring endpoint for ops team to check Celery worker status."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    
    @extend_schema(
        tags=["ops"],
        summary="Worker, queue, GC and disk health (ops only)",
        description=(
            "Operational snapshot of the render pipeline. **Ops team only.**\n\n"
            "Two fields here are the supported way to answer questions you cannot "
            "answer from the database:\n\n"
            "- **`garbage_collector.stale`** — no *successful* sweep within "
            "`GC_STALE_AFTER_HOURS` (default 36). Do **not** try to infer this by "
            "counting soft-deleted rows: the sweep hard-deletes its own tombstones "
            "in the same pass, so that count reads `0` whether the GC ran an hour "
            "ago or has never run at all.\n"
            "- **`garbage_collector.failing`** — the most recent *attempt* raised, "
            "with `last_error` saying how. A sweep can be failing without yet being "
            "stale, and \"broke\" and \"was never scheduled\" look identical without "
            "this field. **Alert on both.**\n\n"
            "`disk` is read live at request time, not lifted from the last sweep's "
            "stats — at the moment it matters most (nothing sweeping) those stats "
            "are absent or stale. `pressure` trips at the same 80% line the GC uses."
        ),
        responses={
            200: inline_serializer(
                name="CeleryMonitor",
                fields={
                    "workers": inline_serializer(name="MonitorWorkers", fields={
                        "total": drf_serializers.IntegerField(),
                        "active": drf_serializers.IntegerField(),
                    }),
                    "queues": inline_serializer(name="MonitorQueues", fields={
                        "priority": drf_serializers.DictField(help_text="{depth, alert} — alert above 50."),
                        "standard": drf_serializers.DictField(help_text="{depth, alert} — alert above 200."),
                    }),
                    "jobs": drf_serializers.DictField(help_text="RenderJob counts by state."),
                    "garbage_collector": drf_serializers.DictField(
                        help_text="{last_run_at, stale, failing, last_error, stats{…}} — see description.",
                    ),
                    "disk": drf_serializers.DictField(
                        help_text="{total_gb, used_gb, free_gb, used_percent, pressure} for the exports volume.",
                    ),
                },
            ),
            403: OpenApiResponse(description="Caller is not on the ops team."),
        },
    )
    def get(self, request):
        """Get Celery worker and queue statistics."""
        from celery import current_app
        from api.models import RenderJob
        from django.utils import timezone
        from datetime import timedelta
        from services.gc_status import read_gc_status

        inspect = current_app.control.inspect()
        
        # Queue depths from reserved tasks
        active_tasks = inspect.active() or {}
        reserved_tasks = inspect.reserved() or {}
        
        priority_depth = 0
        standard_depth = 0
        
        for worker_tasks in reserved_tasks.values():
            for task in worker_tasks:
                routing_key = task.get('delivery_info', {}).get('routing_key', '')
                if routing_key == 'priority':
                    priority_depth += 1
                elif routing_key == 'standard':
                    standard_depth += 1
        
        # Worker stats
        stats = inspect.stats() or {}
        worker_count = len(stats)
        active_worker_count = len(active_tasks)
        
        # Job counts from database — single aggregated query instead of 4 separate COUNT(*)
        now = timezone.now()
        cutoff_24h = now - timedelta(hours=24)
        job_counts = RenderJob.objects.aggregate(
            queued=Count('id', filter=Q(status='queued')),
            processing=Count('id', filter=Q(status='processing')),
            completed_24h=Count('id', filter=Q(status='completed', completed_at__gte=cutoff_24h)),
            failed_24h=Count('id', filter=Q(status='failed', completed_at__gte=cutoff_24h)),
        )

        return Response({
            'workers': {
                'total': worker_count,
                'active': active_worker_count,
            },
            'queues': {
                'priority': {
                    'depth': priority_depth,
                    'alert': priority_depth > 50
                },
                'standard': {
                    'depth': standard_depth,
                    'alert': standard_depth > 200
                }
            },
            'jobs': {
                'queued': job_counts['queued'],
                'processing': job_counts['processing'],
                'completed_24h': job_counts['completed_24h'],
                'failed_24h': job_counts['failed_24h'],
            },
            # Whether the nightly sweep is actually running. `stale: true` is the
            # field to alert on — it means either no sweep has ever been recorded
            # or the last one is older than GC_STALE_AFTER_HOURS. Do NOT infer
            # this from ExportedResult.is_deleted: the sweep purges its own
            # tombstones in the same pass, so that count reads 0 whether the GC
            # ran an hour ago or has never run at all. See services/gc_status.py.
            'garbage_collector': read_gc_status(),
            # Live disk, read now rather than lifted from the last sweep's stats.
            # That distinction is the whole point: disk_usage_percent inside
            # garbage_collector.stats is only as fresh as the last sweep, so at
            # the moment it matters most — no sweeps happening — it is absent or
            # stale. Production reached 89% unnoticed twice for exactly that
            # reason. `pressure` mirrors the >80% threshold the GC itself uses.
            'disk': _disk_status(),
        })


class GetLayoutView(APIView):
    """Get layout JSON - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="Get layout by name",
        description="Retrieve the full JSON definition for a specific layout.",
        parameters=[
            OpenApiParameter("name", OpenApiTypes.STR, OpenApiParameter.PATH, description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(
                name="LayoutDetailResponse",
                fields={
                    "name": drf_serializers.CharField(),
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                },
            ),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request, name: str):
        try:
            from django.core.cache import cache as django_cache
            from api.models import LayoutCatalogue

            # Malformed name is a client error; a well-formed name that simply
            # isn't there is a missing resource.
            if not self._is_safe_layout_name(name):
                return Response(
                    {"detail": "Invalid layout name"},
                    status=status.HTTP_400_BAD_REQUEST
                )

            # Cache individual layout JSON (same TTL as list endpoint)
            surfaces_param = request.query_params.get('surfaces', '')
            cache_key = f"layout_detail:{name}:{surfaces_param}"
            cached_data = django_cache.get(cache_key)

            if cached_data is not None:
                response = Response(cached_data)
                response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
                return response

            # Query LayoutCatalogue from Postgres
            try:
                layout = LayoutCatalogue.objects.get(
                    name=name,
                    is_deprecated=False,
                    is_public=True,
                )
            except LayoutCatalogue.DoesNotExist:
                return Response(
                    {"detail": f"Layout '{name}' not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Fetch definition from database
            data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            data['name'] = layout.name

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            django_cache.set(cache_key, data, 120)  # 2 min TTL

            response = Response(data)
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response

        except Exception as e:
            logger.error(f"Error getting layout: {str(e)}")
            return Response(
                {"detail": "Failed to get layout"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @staticmethod
    def _is_safe_layout_name(name: str) -> bool:
        """Guard against obviously malformed layout names — says nothing about existence."""
        if not name or '/' in name or '\\' in name or '..' in name:
            return False
        return not name.startswith('.')

    @staticmethod
    def _is_path_safe(path: str, allowed_dir: str) -> bool:
        """Ensure path is within allowed directory (prevents path traversal)."""
        try:
            real_path = os.path.realpath(path)
            real_allowed_dir = os.path.realpath(allowed_dir)
            return real_path.startswith(real_allowed_dir)
        except:
            return False


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

class OrderDataPurgeView(APIView):
    """
    Ops-only immediate data erasure for one order (Phase 4 — DPDP
    right-to-erasure). DELETE /api/ops/orders/<order_id>/purge — hard-deletes
    uploads, exports, CanvasData (cascades RenderJobs) and EmbedSessions,
    rows AND files. Never added to the embed-proxy allowlist.

    Query params:
      ?api_key=<name>  narrow to one tenant (default: all keys for the order)
      ?force=true      purge even while a render is queued/processing
    """
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]

    _ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')

    @extend_schema(
        tags=["ops"],
        summary="DPDP erasure — hard-delete one order (ops only)",
        description=(
            "**Irreversible.** Hard-deletes an order's uploads, exports, "
            "`CanvasData` and `EmbedSession` rows *and* the corresponding files on "
            "disk. There is no soft-delete stage and no undo — this exists to serve "
            "a DPDP right-to-erasure request.\n\n"
            "Upload files still referenced by a surviving order are kept.\n\n"
            "**Scoping is mandatory.** `order_id` is only unique per API key "
            "(`unique_together = (order_id, api_key)`), so the same id can belong to "
            "several tenants. The endpoint refuses to guess: pass `api_key` to scope "
            "the erasure to one tenant, or `all_tenants=true` to purge every tenant "
            "sharing the id. Omitting both is a **400**, not a default.\n\n"
            "Not reachable through the embed proxy, and re-gated to the ops team in "
            "the Next.js internal proxy as well — a Django-side `IsOpsTeam` check "
            "alone would not restrict it, because everything arriving through that "
            "proxy presents one shared ops-flagged service account."
        ),
        parameters=[
            OpenApiParameter("api_key", OpenApiTypes.STR, OpenApiParameter.QUERY, required=False,
                             description="APIKey **name** to scope the erasure to one tenant."),
            OpenApiParameter("all_tenants", OpenApiTypes.BOOL, OpenApiParameter.QUERY, required=False,
                             description="Purge every tenant sharing this order_id. Required when `api_key` is omitted."),
            OpenApiParameter("force", OpenApiTypes.BOOL, OpenApiParameter.QUERY, required=False,
                             description="Purge even while a render is queued or processing (otherwise 409)."),
        ],
        request=None,
        responses={
            200: inline_serializer(
                name="OrderPurgeResult",
                fields={
                    "matched": drf_serializers.IntegerField(help_text="Orders matched. 0 → 404."),
                    "erasure_complete": drf_serializers.BooleanField(),
                    "files_deleted": drf_serializers.IntegerField(),
                    "bytes_freed": drf_serializers.IntegerField(),
                    "canvas_rows_deleted": drf_serializers.IntegerField(),
                    "embed_rows_deleted": drf_serializers.IntegerField(),
                    "api_keys_touched": drf_serializers.ListField(child=drf_serializers.CharField()),
                    "unlocated_upload_rows": drf_serializers.IntegerField(
                        help_text="Rows whose file could not be located on disk.",
                    ),
                    "residual_files": drf_serializers.ListField(child=drf_serializers.CharField()),
                    "residual_dirs": drf_serializers.ListField(child=drf_serializers.CharField()),
                    "errors": drf_serializers.ListField(child=drf_serializers.CharField()),
                },
            ),
            400: OpenApiResponse(description="Malformed order_id, or neither api_key nor all_tenants given."),
            403: OpenApiResponse(description="Caller is not on the ops team."),
            404: OpenApiResponse(description="No data matched this order_id (nothing was deleted)."),
            409: OpenApiResponse(description="A render is in flight for this order. Re-send with force=true to override."),
        },
    )
    def delete(self, request, order_id: str):
        from api.purge import purge_order_data
        from api.models import APIKey

        if not self._ORDER_ID_RE.match(order_id or ''):
            return Response({'detail': 'Invalid order_id.'}, status=status.HTTP_400_BAD_REQUEST)

        api_key = None
        key_name = request.query_params.get('api_key')
        if key_name:
            api_key = APIKey.objects.filter(name=key_name).first()
            if not api_key:
                return Response({'detail': f"No API key named '{key_name}'."}, status=status.HTTP_404_NOT_FOUND)

        # Cross-tenant erasure is destructive — the same order_id can exist for
        # different embed customers (unique_together is (order_id, api_key)).
        # Purging every tenant sharing an id must be a CONSCIOUS choice, not the
        # default: require ?all_tenants=true when no api_key is scoped.
        all_tenants = str(request.query_params.get('all_tenants', '')).lower() in ('1', 'true', 'yes')
        if api_key is None and not all_tenants:
            return Response(
                {'detail': "This order_id may belong to multiple tenants. Pass "
                           "?api_key=<name> to scope the erasure, or ?all_tenants=true "
                           "to purge every tenant sharing this order_id."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        force = str(request.query_params.get('force', '')).lower() in ('1', 'true', 'yes')

        result = purge_order_data(order_id, api_key=api_key, force=force)
        if result.get('matched', 0) == 0:
            return Response(result, status=status.HTTP_404_NOT_FOUND)
        if result.get('blocked'):
            return Response(result, status=status.HTTP_409_CONFLICT)
        return Response(result, status=status.HTTP_200_OK)


# Shared by the layout read/write/delete schema descriptions below. Stated once
# because it is the single most expensive thing to get wrong about layouts.
LAYOUT_ID_NOTE = (
    "**A layout's identifier is its filename stem**, never the `name` field "
    "inside the JSON — both this endpoint and the public list overwrite the "
    "stored `name` with the filename for exactly that reason. When the two "
    "diverged in case, the layout became unopenable and undeletable on the "
    "case-sensitive production filesystem while working fine on a developer's "
    "case-insensitive Mac."
)


class LayoutManagementView(APIView):
    """View to manage layout JSON files - requires Ops Team permissions."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    from rest_framework.parsers import JSONParser, MultiPartParser, FormParser
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    
    @staticmethod
    def _is_safe_layout_name(name: str) -> bool:
        """Guard against obviously malformed layout names."""
        if not name or '/' in name or '\\' in name or '..' in name:
            return False
        return not name.startswith('.')

    @extend_schema(
        tags=["ops"],
        summary="List layouts, or fetch one layout's full JSON",
        description=(
            "Ops view of the layout library. Without `name`, returns every layout's "
            "full definition plus a `hasCalendar` convenience flag; with `name`, "
            "returns that one layout.\n\n"
            + LAYOUT_ID_NOTE +
            "\n\nThe list is cached server-side for 2 minutes and invalidated on "
            "write, so an edit shows up immediately rather than after the TTL."
        ),
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "`{layouts: [...]}` for the list form, or the raw layout object "
                    "for the detail form. Layout JSON is free-form by design — the "
                    "schema differs per productType (photo / calendar / book)."
                ),
            ),
            400: OpenApiResponse(description="Layout name contains characters outside `A-Za-z0-9_.-`."),
            403: OpenApiResponse(description="Caller is not on the ops team, or the name resolved outside the layouts directory."),
            404: OpenApiResponse(description="No such layout."),
        },
    )
    def get(self, request, name=None):
        """List layouts or get a specific layout's JSON."""
        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue

        if name:
            if not self._is_safe_layout_name(name):
                return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

            # Query LayoutCatalogue from Postgres (ops can see all, not just public)
            try:
                layout = LayoutCatalogue.objects.get(name=name)
            except LayoutCatalogue.DoesNotExist:
                return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)

            try:
                data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
                data['name'] = layout.name
                response = Response(data)
                response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
                return response
            except Exception as e:
                return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        else:
            # Full list — server-side Django cache mirrors ListLayoutsView so
            # repeat hits skip the DB query; HTTP Cache-Control lets the
            # admin's browser cache it too.
            CACHE_KEY = "ops_layouts_list_all"
            CACHE_TTL = 120
            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                # Query all layouts (not just public) for ops view
                rows = LayoutCatalogue.objects.all().values('name', 'definition', 'product_type', 'is_deprecated')
                layouts_data = []
                for row in rows:
                    data = row['definition'].copy() if isinstance(row['definition'], dict) else {}
                    data['name'] = row['name']
                    data['hasCalendar'] = data.get('productType') == 'calendar'
                    data['isDeprecated'] = row['is_deprecated']
                    layouts_data.append(data)
                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
            response = Response({"layouts": layouts_data})
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response

    @extend_schema(
        tags=["ops"],
        summary="Create, update or rename a layout",
        description=(
            "Writes a layout JSON file. Ops team only.\n\n"
            + LAYOUT_ID_NOTE +
            "\n\n**Rename:** send `old_name` (or `originalName`) alongside the new "
            "`name`; the old file is removed only after the new one is written.\n\n"
            "**Validation depends on `productType`.** A calendar or book layout is "
            "checked against its own validator; a multi-surface product must give "
            "every surface a canvas width and height; a plain layout must carry a "
            "root `canvas`. Book layouts carry neither a root canvas nor a surfaces "
            "list — their per-role canvases live under `book.cover` / "
            "`book.innerPage` / `book.backCover` — so they are exempt from the "
            "canvas check and validated separately."
        ),
        request=inline_serializer(
            name="LayoutWrite",
            fields={
                "name": drf_serializers.CharField(
                    required=False,
                    help_text="Layout identifier. Optional when supplied in the URL path. `A-Za-z0-9_.-` only.",
                ),
                "layout_data": drf_serializers.JSONField(
                    help_text="The layout definition. Also accepted under the key `layout`. A JSON string is parsed.",
                ),
                "old_name": drf_serializers.CharField(
                    required=False,
                    help_text="Previous identifier, to rename. Also accepted as `originalName`. Ignored if equal to `name`.",
                ),
            },
        ),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT, description="The layout as stored."),
            400: OpenApiResponse(description="Missing name/layout_data, invalid name, malformed JSON, or failed product validation."),
            403: OpenApiResponse(description="Caller is not on the ops team, or the path resolved outside the layouts directory."),
        },
    )
    def post(self, request, name=None):
        """Create or update a layout in LayoutCatalogue."""
        from api.models import LayoutCatalogue
        from django.db import transaction as db_transaction
        from django.core.exceptions import ValidationError as _DjangoValidationError

        layout_name = name or request.data.get("name")
        layout_data = request.data.get("layout_data") or request.data.get("layout")

        if not layout_name or not layout_data:
            return Response({"detail": "name and layout_data are required"}, status=status.HTTP_400_BAD_REQUEST)

        if not self._is_safe_layout_name(layout_name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        # Support rename: if old_name is provided and differs from layout_name
        old_name = request.data.get("old_name") or request.data.get("originalName")
        if old_name and old_name == layout_name:
            old_name = None  # Not actually a rename

        try:
            # Basic validation: ensure it's a valid JSON dict
            if isinstance(layout_data, str):
                layout_data = json.loads(layout_data)
            
            # Ensure required fields for LayoutEngine exist. Book layouts (D2a)
            # carry neither a root `canvas` nor a `surfaces[]` list — their
            # per-role canvases live under `book.cover` / `book.innerPage` /
            # `book.backCover` (D7) and are checked by validate_book_layout
            # below instead.
            is_book = layout_data.get('productType') == 'book'
            is_multi_surface = layout_data.get('type') == 'product' and isinstance(layout_data.get('surfaces'), list)
            if is_book:
                pass
            elif is_multi_surface:
                for idx, surface in enumerate(layout_data['surfaces']):
                    s_canvas = surface.get('canvas', {})
                    if 'width' not in s_canvas or 'height' not in s_canvas:
                        return Response(
                            {"detail": f"Surface '{surface.get('key', idx)}': missing canvas width/height"},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
            elif 'canvas' not in layout_data or 'width' not in layout_data['canvas'] or 'height' not in layout_data['canvas']:
                return Response({"detail": "Invalid layout structure: missing canvas width/height"}, status=status.HTTP_400_BAD_REQUEST)

            # Calendar product type — enforce monthRange × calendars constraint,
            # validate ops-default + customer-controllable fields, reject banned
            # fields inside surfaceOverrides. PRD §10.2, §11.1, §11.15.
            if layout_data.get('productType') == 'calendar':
                from api.validators import validate_calendar_layout
                from django.core.exceptions import ValidationError as _DjangoValidationError
                try:
                    validate_calendar_layout(layout_data)
                except _DjangoValidationError as exc:
                    # Surface the first failure message exactly as the validator
                    # built it — already specific and actionable.
                    msg = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                    return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)

            # Book product type — enforce the two-template contract (D2a),
            # per-role canvas presence (D7), and pageCount/gutter shape.
            # BOOK_LAYOUT_PRD.md §5.
            if is_book:
                from api.validators import validate_book_layout
                from django.core.exceptions import ValidationError as _DjangoValidationError
                try:
                    validate_book_layout(layout_data)
                except _DjangoValidationError as exc:
                    msg = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                    return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)

            # Handle mask uploads (S3 or local storage)
            mask_file = request.FILES.get('mask')
            if mask_file:
                try:
                    storage = get_storage()
                    from services.storage import S3Storage

                    mask_filename = f"{layout_name}_mask{os.path.splitext(mask_file.name)[1]}"

                    if isinstance(storage, S3Storage):
                        # Upload to S3
                        s3_key = f"masks/{mask_filename}"
                        storage.save_upload(mask_filename, mask_file.file, order_id='')
                        layout_data['maskUrl'] = f"/api/layouts/masks/{mask_filename}"
                        logger.info(f"Uploaded mask to S3: {s3_key}")
                    else:
                        # Upload to local storage
                        mask_path = os.path.join(storage.masks_dir(), mask_filename)
                        with open(mask_path, 'wb+') as destination:
                            for chunk in mask_file.chunks():
                                destination.write(chunk)
                        layout_data['maskUrl'] = f"/api/layouts/masks/{mask_filename}"
                        logger.info(f"Uploaded mask to disk: {mask_path}")
                except Exception as exc:
                    logger.error(f"Failed to upload mask: {exc}")
                    return Response(
                        {"detail": f"Failed to upload mask: {str(exc)}"},
                        status=status.HTTP_500_INTERNAL_SERVER_ERROR
                    )

            # Infer product_type from definition
            product_type = layout_data.get('productType', 'single_canvas')

            with db_transaction.atomic():
                if old_name and old_name != layout_name:
                    # Rename: update the old row's name + mark the new version
                    try:
                        old_layout = LayoutCatalogue.objects.get(name=old_name)
                        old_layout.name = layout_name
                        old_layout.definition = layout_data
                        old_layout.product_type = product_type
                        old_layout.version = old_layout.version + 1
                        old_layout.save()
                        logger.info(f"Renamed layout '{old_name}' → '{layout_name}'")

                        # Migrate masks on rename (S3 only)
                        from services.storage import S3Storage
                        storage = get_storage()
                        if isinstance(storage, S3Storage):
                            try:
                                # Look for old mask with old name pattern
                                # Try common extensions: .png, .jpg, .jpeg, .gif, .webp
                                for ext in ['.png', '.jpg', '.jpeg', '.gif', '.webp']:
                                    old_mask_key = f"masks/{old_name}_mask{ext}"
                                    new_mask_key = f"masks/{layout_name}_mask{ext}"
                                    try:
                                        if storage.file_exists(old_mask_key):
                                            storage.copy_object(old_mask_key, new_mask_key)
                                            storage.delete_file(old_mask_key)
                                            logger.info(f"Migrated mask: {old_mask_key} → {new_mask_key}")
                                            break
                                    except Exception as inner_exc:
                                        logger.warning(f"Failed to migrate mask {old_mask_key}: {inner_exc}")
                            except Exception as exc:
                                logger.warning(f"Mask migration failed on rename: {exc}")
                    except LayoutCatalogue.DoesNotExist:
                        # Old layout doesn't exist — create as new
                        LayoutCatalogue.objects.create(
                            name=layout_name,
                            definition=layout_data,
                            product_type=product_type,
                            category='',
                            is_public=True,
                            version=1,
                        )
                        logger.info(f"Created new layout '{layout_name}'")
                else:
                    # Create or update (no rename)
                    obj, created = LayoutCatalogue.objects.update_or_create(
                        name=layout_name,
                        defaults={
                            'definition': layout_data,
                            'product_type': product_type,
                            'category': '',
                            'is_public': True,
                        },
                    )
                    if created:
                        obj.version = 1
                        obj.save()
                        logger.info(f"Created new layout '{layout_name}'")
                    else:
                        obj.version = obj.version + 1
                        obj.save()
                        logger.info(f"Updated layout '{layout_name}' (version {obj.version})")

            # Invalidate caches
            invalidate_layout_caches(layout_name)
            if old_name and old_name != layout_name:
                invalidate_layout_caches(old_name)

            return Response({"status": "success", "name": layout_name})
        except json.JSONDecodeError:
            return Response({"detail": "Invalid JSON data"}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            logger.error(f"Error saving layout {layout_name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @extend_schema(
        tags=["ops"],
        summary="Delete a layout",
        description=(
            "Removes the layout JSON and any `<name>_mask.*` file beside it, then "
            "invalidates both the list cache and this layout's detail cache "
            "entries. Dropping only the list cache used to leave the deleted "
            "template visible on the Templates page — and still openable in the "
            "editor — for the remainder of the TTL.\n\n"
            "Renders already queued against this layout are unaffected; they read "
            "the definition snapshotted at submit time."
        ),
        request=None,
        responses={
            200: inline_serializer(
                name="LayoutDeleteResult",
                fields={
                    "status": drf_serializers.CharField(),
                    "detail": drf_serializers.CharField(),
                },
            ),
            400: OpenApiResponse(description="No layout name in the URL, or a name containing characters outside `A-Za-z0-9_.-`."),
            403: OpenApiResponse(description="Caller is not on the ops team, or the name resolved outside the layouts directory."),
            404: OpenApiResponse(description="No such layout."),
        },
    )
    def delete(self, request, name=None):
        """Soft-delete a layout from LayoutCatalogue."""
        from api.models import LayoutCatalogue

        # Both /api/ops/layouts and /api/ops/layouts/<name> route here, so the
        # collection form arrives with no name at all. Without this guard that
        # was a TypeError — a 500 on a route the API reference advertised as
        # valid. Deleting "every layout" is not a thing we want to offer, so the
        # collection form is simply a bad request.
        if not name:
            return Response(
                {"detail": "layout name is required in the URL: /api/ops/layouts/<name>"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not self._is_safe_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Soft-delete from LayoutCatalogue
            layout = LayoutCatalogue.objects.get(name=name)
            layout.is_deprecated = True
            layout.save()
            logger.info(f"Soft-deleted layout '{name}'")

            # Clear both list caches AND this layout's detail entries. Dropping
            # only "layouts_list_all" left the ops Templates page serving the
            # deleted row for its 2-minute TTL; leaving the detail entries meant
            # the deleted layout stayed openable in the editor for just as long.
            invalidate_layout_caches(name)
            return Response({"status": "success", "detail": f"Layout {name} deleted"})
        except LayoutCatalogue.DoesNotExist:
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            logger.error(f"Error deleting layout {name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class ExternalLayoutDetailView(APIView):
    """
    Secured view for external systems to fetch layout JSON.
    Requires a valid API Key or Bearer Token.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="Get layout for external systems",
        description=(
            "Fetch a layout JSON definition via API key auth. "
            "Intended for external server-to-server use (not browser clients)."
        ),
        parameters=[
            OpenApiParameter("name", OpenApiTypes.STR, OpenApiParameter.PATH, description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(
                name="ExternalLayoutResponse",
                fields={
                    "name": drf_serializers.CharField(),
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                },
            ),
            400: OpenApiResponse(description="Invalid layout name"),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request, name):
        from api.models import LayoutCatalogue

        # 400 for a malformed name, 404 for one that simply isn't there.
        if not GetLayoutView._is_safe_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Query LayoutCatalogue from Postgres
            layout = LayoutCatalogue.objects.get(
                name=name,
                is_deprecated=False,
                is_public=True,
            )
        except LayoutCatalogue.DoesNotExist:
            return Response(
                {"detail": f"Layout '{name}' not found"},
                status=status.HTTP_404_NOT_FOUND
            )

        try:
            data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            data['name'] = layout.name

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            surfaces_param = request.query_params.get('surfaces')
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            return Response(data)
        except Exception as e:
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class MaskDownloadView(APIView):
    """View to serve layout mask images from S3 or local storage."""
    permission_classes = [AllowAny]  # Publicly accessible if URL is known

    @extend_schema(
        tags=["layouts"],
        summary="Fetch a layout mask image",
        description=(
            "Serves the mask bitmap a layout clips its frames against. Public if "
            "you know the filename — masks are shape stencils, not customer data.\n\n"
            "**Local storage (dev):** Streams the file directly.\n"
            "**S3 storage (prod):** Returns a 301 redirect to a presigned URL (1-hour expiry)."
        ),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.BINARY, description="The mask image (usually image/png) — local storage only."),
            301: OpenApiResponse(description="Redirect to presigned S3 URL — S3 storage only."),
            403: OpenApiResponse(description="Path traversal attempt detected."),
            404: OpenApiResponse(description="No such mask."),
            502: OpenApiResponse(description="S3 service error."),
        },
        auth=[],
    )
    def get(self, request, filename):
        from services.storage import LocalStorage, S3Storage

        storage = get_storage()

        # Guard against path traversal — filename must not contain / or .. or start with .
        if '/' in filename or '\\' in filename or '..' in filename or filename.startswith('.'):
            return Response(
                {"detail": "Access denied"},
                status=status.HTTP_403_FORBIDDEN
            )

        try:
            if isinstance(storage, S3Storage):
                # S3 storage: generate presigned URL and redirect
                s3_key = f"masks/{filename}"
                try:
                    presigned_url = storage.generate_mask_presigned_url(s3_key, expiry=3600)
                    response = Response(status=status.HTTP_301_MOVED_PERMANENTLY)
                    response['Location'] = presigned_url
                    return response
                except Exception as exc:
                    logger.error(f"Failed to generate presigned URL for mask {filename}: {exc}")
                    return Response(
                        {"detail": "S3 service unavailable"},
                        status=status.HTTP_502_BAD_GATEWAY
                    )
            else:
                # LocalStorage: serve file directly
                import os
                from django.http import FileResponse
                import mimetypes

                path = os.path.join(storage.masks_dir(), filename)

                # Double-check path safety (belt and suspenders)
                if not os.path.abspath(path).startswith(os.path.abspath(storage.masks_dir())):
                    return Response(
                        {"detail": "Access denied"},
                        status=status.HTTP_403_FORBIDDEN
                    )

                if not os.path.exists(path):
                    return Response(
                        {"detail": "Mask not found"},
                        status=status.HTTP_404_NOT_FOUND
                    )

                content_type, _ = mimetypes.guess_type(path)
                return FileResponse(
                    open(path, 'rb'),
                    content_type=content_type or 'image/png'
                )
        except Exception as e:
            logger.error(f"Error serving mask {filename}: {e}")
            return Response(
                {"detail": str(e)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


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
            "Your page    →  <iframe src=\"https://product-editor.printo.in/editor/layout/<name>?token=<uuid>&qty=<N>\" />\n\n"
            "Customer edits canvas and clicks Save & Continue\n\n"
            "Your page    ←  window.postMessage({ type: 'pe:render_job', jobId, orderID })\n"
            "                (UX ping only — the rendered ZIP is delivered out-of-band\n"
            "                 via a signed webhook to your callback_url; see\n"
            "                 docs/INTEGRATION.md for the full contract)\n"
            "```\n\n"
            "### Ordered quantity (`qty`)\n\n"
            "`qty` is **not a field on this endpoint** — append it to the iframe URL "
            "as shown above, or it has no effect. It caps how many photos the customer "
            "can submit:\n\n"
            "- **More than `qty`** — blocked. The editor offers *Keep first N* or "
            "*Choose again*; there is no way to proceed with more.\n"
            "- **Fewer than `qty`** — allowed, with an auto-fill prompt and a "
            "pre-submit warning. Deliberate: `qty` travels in a URL the customer's "
            "browser can edit, so a wrong value must not strand a real order at "
            "checkout. Re-check `file_count` on the completion webhook if you need a "
            "guaranteed count.\n"
            "- Applies to **single-surface products only**. Two-sided products, "
            "calendars and books have a surface count fixed by the layout.\n\n"
            "Enforced in the browser only — nothing server-side validates it today.\n\n"
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
                    "2000 chars, or `callback_url` failing the https-only + "
                    "public-address SSRF check."
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

        session = EmbedSession.objects.create(
            api_key=api_key,
            expires_at=expires_at,
            order_id=order_id,
            callback_url=callback_url,
            include_uploads=include_uploads,
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
                },
            ),
            400: OpenApiResponse(description="Missing or invalid `layout` query param"),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request):
        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue

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
            # Query LayoutCatalogue from Postgres
            try:
                layout = LayoutCatalogue.objects.get(
                    name=name,
                    is_deprecated=False,
                    is_public=True,
                )
            except LayoutCatalogue.DoesNotExist:
                return Response(
                    {'detail': f"Layout '{name}' not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Fetch definition from database
            layout_data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            layout_data['name'] = layout.name

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
        response = Response({
            'layout': layout_data,
            'fonts': _read_fonts(),
            'order_id': (request.headers.get('X-Order-ID') or '').strip() or None,
        })
        # Cacheable on the proxy edge for short-lived shared cache; private so a
        # tenant's surfaces= filter doesn't bleed across tenants.
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response


# ─── Editor Render (server-side high-res render from uploaded files) ──────────

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
            "twice creates a second job."
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
            400: OpenApiResponse(description="Missing order_id, unknown layout, empty canvases, or an upload_id that resolves to no stored file."),
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

        # ── Persist CanvasData + RenderJob atomically ───────────────────────
        # Soft-proof + CMYK pipelines retired; everything routes to 'standard'.
        queue_name = 'standard'
        expires_at = timezone.now() + timedelta(days=settings.EXPORT_RETENTION_DAYS)

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
        }

        try:
            with db_transaction.atomic():
                canvas_obj, _ = CanvasData.objects.update_or_create(
                    order_id=order_id,
                    api_key=api_key,
                    defaults={
                        'layout_name': layout_name,
                        'image_paths': image_paths,
                        'fit_mode': 'cover',
                        'export_format': export_format,
                        'render_state': render_state,
                        'callback_url': callback_url,
                        'expires_at': expires_at,
                    },
                )
                job = RenderJob.objects.create(
                    canvas_data=canvas_obj,
                    status='queued',
                    queue_name=queue_name,
                )
                # on_commit inside atomic() so it fires only after the
                # transaction commits — task is guaranteed to find the DB rows.
                _canvas_id = str(canvas_obj.id)
                _job_id = str(job.id)
                _queue = queue_name
                db_transaction.on_commit(
                    lambda: render_canvas_task.apply_async(
                        args=[_canvas_id, _job_id],
                        queue=_queue,
                    )
                )

        except Exception as exc:
            logger.error("EditorRenderView: failed to create render job for order_id=%s: %s", order_id, exc)
            return Response({'detail': 'Failed to submit render job.'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        logger.info("Editor render job %s queued: order_id=%s, layout=%s, queue=%s", _job_id, order_id, layout_name, queue_name)

        return Response({
            'job_id': _job_id,
            'order_id': order_id,
            'status_url': f'/api/render-status/{_job_id}/',
            'queue': queue_name,
        }, status=status.HTTP_202_ACCEPTED)


# ─── Fonts management ─────────────────────────────────────────────────────────

FONTS_JSON_PATH = os.path.join(settings.STORAGE_ROOT, 'fonts.json')

DEFAULT_FONTS = ['sans-serif', 'serif', 'monospace']

# Shared Redis cache for the on-disk JSON config files. Keys are namespaced so
# `cache.delete()` from the corresponding _write_* function invalidates exactly
# one entry without touching the rest of the cache. TTL is 5 min — matches the
# Cache-Control max-age served to clients, so callers and our cache stay in sync.
_FONTS_CACHE_KEY = 'storage:fonts'
_STORAGE_CACHE_TTL = 300


def _read_fonts():
    """Read the fonts config from asset store, with a 5-minute Redis cache."""
    from django.core.cache import cache
    from services.asset_store import read_asset, AssetNotFoundError

    cached = cache.get(_FONTS_CACHE_KEY)
    if cached is not None:
        return cached

    try:
        # Fonts are stored as 'fonts' asset (no subdirectory)
        data = json.loads(read_asset('fonts', 'fonts').decode('utf-8'))
        value = data if isinstance(data, list) else DEFAULT_FONTS
    except (AssetNotFoundError, json.JSONDecodeError, ValueError):
        logger.warning("Failed to read fonts from asset store, using defaults")
        value = DEFAULT_FONTS

    cache.set(_FONTS_CACHE_KEY, value, _STORAGE_CACHE_TTL)
    return value


def _write_fonts(fonts):
    """Write fonts config to disk and invalidate the cache."""
    from django.core.cache import cache
    with open(FONTS_JSON_PATH, 'w') as f:
        json.dump(fonts, f, indent=2)
    cache.delete(_FONTS_CACHE_KEY)


# These three views are declared AllowAny because their GET is public, then gate
# their writes on the ops team *inside* the handler. drf-spectacular reads
# permission_classes, so without an explicit `auth=` it would advertise the
# destructive methods as requiring no credentials at all. State the truth
# per-operation instead: public reads carry `auth=[]`, ops writes carry this.
OPS_WRITE_AUTH = [{"BearerAuth": []}, {"PIAAuth": []}, {"PIASessionCookie": []}]

_OPS_GATE_RESPONSES = {
    401: OpenApiResponse(description="No API key or PIA session presented."),
    403: OpenApiResponse(description="Authenticated, but not on the ops team."),
}


class FontsView(APIView):
    """
    GET  /api/fonts  — returns the list of enabled fonts (open to any authenticated user).
    PUT  /api/fonts  — saves the list of enabled fonts (ops team only).
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["fonts"],
        summary="List enabled fonts",
        description=(
            "Font families offered in the editor's text-overlay picker. Public and "
            "cached (`max-age=300`, `stale-while-revalidate=600`) so the editor can "
            "fetch it on mount without an auth round-trip.\n\n"
            "This is the *editor* font list. It is unrelated to print rendering, "
            "which uses a single bundled Inter Variable face server-side — there is "
            "deliberately no font picker in the 300-DPI output path."
        ),
        responses={200: inline_serializer(
            name="FontList",
            fields={"fonts": drf_serializers.ListField(child=drf_serializers.CharField())},
        )},
        auth=[],
    )
    def get(self, request):
        response = Response({'fonts': _read_fonts()})
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

    @extend_schema(
        tags=["fonts"],
        summary="Replace the enabled font list (ops only)",
        description=(
            "Replaces the whole list — this is not a merge. Written atomically "
            "(temp file + rename) and the read cache is dropped immediately.\n\n"
            "Ops team only, enforced inside the handler rather than by "
            "`permission_classes`, because the GET on this same view is public."
        ),
        request=inline_serializer(
            name="FontListWrite",
            fields={"fonts": drf_serializers.ListField(
                child=drf_serializers.CharField(),
                help_text="Font family names. Must be a list of strings.",
            )},
        ),
        responses={
            200: inline_serializer(
                name="FontListWritten",
                fields={"fonts": drf_serializers.ListField(child=drf_serializers.CharField())},
            ),
            400: OpenApiResponse(description="`fonts` missing, or not a list of strings."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def put(self, request):
        # Only ops team can modify fonts
        from .authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue

        if not user:
            return Response({'detail': 'Authentication required'}, status=status.HTTP_401_UNAUTHORIZED)

        # Check ops team permission
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return Response({'detail': 'Only ops team can modify fonts'}, status=status.HTTP_403_FORBIDDEN)

        fonts = request.data.get('fonts')
        if not isinstance(fonts, list) or not all(isinstance(f, str) for f in fonts):
            return Response({'detail': 'fonts must be a list of strings'}, status=status.HTTP_400_BAD_REQUEST)

        _write_fonts(fonts)
        return Response({'fonts': fonts})


# ── Calendar style presets + Gen-Z palettes (PRD §10.3, §6.3) ───────────────

CALENDAR_STYLES_DIR = os.path.join(settings.STORAGE_ROOT, 'calendar_styles')
GENZ_PALETTES_DIR = os.path.join(settings.STORAGE_ROOT, 'calendar_palettes', 'genz')
_CALENDAR_STYLES_CACHE_KEY = 'storage:calendar_styles:list'
_CALENDAR_STYLE_CACHE_KEY = 'storage:calendar_styles:'  # + name


def _list_calendar_styles():
    """Return [{name, label}] for every calendar style from asset store."""
    from django.core.cache import cache
    from services.asset_store import list_assets_in_local_storage

    cached = cache.get(_CALENDAR_STYLES_CACHE_KEY)
    if cached is not None:
        return cached

    out = []
    try:
        # List from local storage (asset_store handles S3 fallback on read)
        style_names = list_assets_in_local_storage('calendar_styles')
        for name in style_names:
            try:
                style = _read_calendar_style(name)
                if style:
                    out.append({
                        'name': style.get('name') or name,
                        'label': style.get('label') or style.get('name') or name,
                        'description': style.get('description') or '',
                    })
            except Exception as exc:
                logger.warning("Failed to read calendar style %s: %s", name, exc)
    except Exception as exc:
        logger.error("Error listing calendar styles: %s", exc)

    cache.set(_CALENDAR_STYLES_CACHE_KEY, out, _STORAGE_CACHE_TTL)
    return out


def _read_calendar_style(name):
    """Read a single calendar style JSON using asset_store. Returns None if missing/invalid."""
    from django.core.cache import cache
    from services.asset_store import read_asset_json, AssetNotFoundError

    # Path-traversal guard — name must be safe
    if not name or not name.replace('-', '').replace('_', '').isalnum():
        return None

    cache_key = _CALENDAR_STYLE_CACHE_KEY + name
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        style = read_asset_json('calendar_styles', name)
    except (AssetNotFoundError, json.JSONDecodeError):
        return None

    # For Gen-Z, attach the available palettes inline so clients don't
    # have to make a second request to enumerate them.
    if style.get('name') == 'modern-genz':
        from services.asset_store import read_asset_json, AssetNotFoundError, list_assets_in_local_storage

        palettes = []
        try:
            palette_names = list_assets_in_local_storage('calendar_palettes/genz')
            for palette_name in palette_names:
                try:
                    palette = read_asset_json('calendar_palettes/genz', palette_name)
                    palettes.append(palette)
                except (AssetNotFoundError, json.JSONDecodeError) as exc:
                    logger.warning("Failed to read palette %s: %s", palette_name, exc)
                    continue
        except Exception as exc:
            logger.warning("Failed to load Gen-Z palettes: %s", exc)

        style['palettes'] = palettes

    cache.set(cache_key, style, _STORAGE_CACHE_TTL)
    return style


def _write_calendar_style(name, payload):
    """Persist a calendar style atomically and invalidate cache."""
    from django.core.cache import cache
    if not name.replace('-', '').replace('_', '').isalnum():
        raise ValueError("invalid style name")
    os.makedirs(CALENDAR_STYLES_DIR, exist_ok=True)
    path = os.path.join(CALENDAR_STYLES_DIR, f'{name}.json')
    tmp_path = path + '.tmp'
    with open(tmp_path, 'w') as f:
        json.dump(payload, f, indent=2, sort_keys=True)
    os.replace(tmp_path, path)
    cache.delete(_CALENDAR_STYLES_CACHE_KEY)
    cache.delete(_CALENDAR_STYLE_CACHE_KEY + name)


class CalendarStylesView(APIView):
    """
    GET  /api/calendar-styles/             → list summary [{name, label, description}]
    GET  /api/calendar-styles/<name>       → full style JSON (with palettes for genz)
    PUT  /api/calendar-styles/<name>       → ops-team only; replaces a style preset

    Public read so the customer preview page can fetch styles without an
    auth round-trip. Cached 5 min with stale-while-revalidate so the
    storefront can hammer it under load.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["calendar"],
        summary="List calendar theme presets, or fetch one",
        description=(
            "Without `name`, a summary list of `{name, label, description}`. With "
            "`name`, the full preset — including its palette swatches for the "
            "Gen-Z theme, of which the customer picks exactly one per render.\n\n"
            "Public so the customer-facing preview can load themes straight through "
            "the embed proxy. Cached 5 minutes with a 10-minute "
            "stale-while-revalidate window.\n\n"
            "Theme colours are resolved server-side at render time from these same "
            "files, so the printed calendar matches the preview; ops colours set on "
            "the layout win over the preset."
        ),
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="`{styles: [{name, label, description}]}` for the list form, or the full preset object.",
            ),
            404: OpenApiResponse(description="No such style preset. Detail form only — the list never 404s."),
        },
        auth=[],
    )
    def get(self, request, name=None):
        if name is None:
            response = Response({'styles': _list_calendar_styles()})
            response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
            return response

        style = _read_calendar_style(name)
        if style is None:
            return Response(
                {'detail': f"Calendar style '{name}' not found"},
                status=status.HTTP_404_NOT_FOUND,
            )
        response = Response(style)
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

    @extend_schema(
        tags=["calendar"],
        summary="Replace a calendar theme preset (ops only)",
        description=(
            "Replaces one preset wholesale. Ops team only — mutations are routed "
            "through `/api/ops/calendar-styles/<name>` rather than the public read "
            "path, so the embed proxy (which allows `calendar-styles` for reads) "
            "can never forward a write.\n\n"
            "The stored `name` is forced to match the URL, so a client cannot "
            "smuggle a different identifier in the body and overwrite another "
            "preset."
        ),
        request=OpenApiTypes.OBJECT,
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT, description="The preset as stored."),
            400: OpenApiResponse(description="Name missing from the URL, body not a JSON object, or preset rejected by validation."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def put(self, request, name=None):
        if name is None:
            return Response(
                {'detail': 'style name is required in the URL'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Ops-only mutation — mirror the FontsView gate.
        from .authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue

        if not user:
            return Response(
                {'detail': 'Authentication required'},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return Response(
                {'detail': 'Only ops team can modify calendar styles'},
                status=status.HTTP_403_FORBIDDEN,
            )

        payload = request.data
        if not isinstance(payload, dict):
            return Response(
                {'detail': 'request body must be a JSON object'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Ensure the stored name field matches the URL path so clients
        # can't smuggle a different name into the payload.
        payload['name'] = name

        try:
            _write_calendar_style(name, payload)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(payload)


# ── Holiday data (PRD §11.9, §11.11) ────────────────────────────────────────

HOLIDAYS_ROOT = os.path.join(settings.STORAGE_ROOT, 'holidays')
_HOLIDAYS_CACHE_KEY = 'storage:holidays:'  # + locale:year


def _safe_locale_year(locale: str, year_str: str) -> tuple[str, int]:
    """
    Validate path-traversal-safe locale + year before touching disk.

    Returns (locale, year_int) or raises ValueError.
    """
    if not locale or not all(c.isalnum() or c == '-' for c in locale):
        raise ValueError(f"invalid locale: {locale!r}")
    try:
        year = int(year_str)
    except (TypeError, ValueError):
        raise ValueError(f"invalid year: {year_str!r}")
    if not (1900 <= year <= 2100):
        raise ValueError(f"year {year} outside the supported range 1900..2100")
    return locale, year


def _holiday_path(locale: str, year: int) -> str:
    return os.path.join(HOLIDAYS_ROOT, locale, f"{year}.json")


def _read_holidays(locale: str, year: int) -> dict | None:
    """Read holidays from asset store with Redis cache."""
    from django.core.cache import cache
    from services.asset_store import read_asset_json, AssetNotFoundError

    cache_key = f"{_HOLIDAYS_CACHE_KEY}{locale}:{year}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        # Asset name format: {locale}/{year}
        asset_name = f"{locale}/{year}"
        data = read_asset_json('holidays', asset_name)
    except (AssetNotFoundError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read holidays for %s/%d: %s", locale, year, exc)
        cache.set(cache_key, None, _STORAGE_CACHE_TTL)
        return None

    cache.set(cache_key, data, _STORAGE_CACHE_TTL)
    return data


def _write_holidays(locale: str, year: int, payload: dict) -> None:
    """Persist a holiday file atomically and invalidate cache."""
    from django.core.cache import cache
    dir_path = os.path.dirname(_holiday_path(locale, year))
    os.makedirs(dir_path, exist_ok=True)
    path = _holiday_path(locale, year)
    tmp_path = path + '.tmp'
    with open(tmp_path, 'w') as f:
        json.dump(payload, f, indent=2, sort_keys=False)
    os.replace(tmp_path, path)
    cache.delete(f"{_HOLIDAYS_CACHE_KEY}{locale}:{year}")


class HolidaysView(APIView):
    """
    GET    /api/holidays/<locale>/<year>           → public, cached 1 day / swr 7 days
    PUT    /api/ops/holidays/<locale>/<year>       → ops-team only; replaces year file
    DELETE /api/ops/holidays/<locale>/<year>       → ops-team only

    Per PRD §11.9 + §11.11. Calendar layouts that opt into a locale auto-load
    the matching year's holiday file; years without a file render with no
    auto-injection (no error — customers can still add their own entries).
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["calendar"],
        summary="Fetch holiday data for a locale and year",
        description=(
            "Holidays auto-injected into calendar layouts that opt into a locale. "
            "Seeded locales are `en-IN` and `generic`; seeded years are 2026-2030.\n\n"
            "A year with no file is **404, not an error condition** — calendars for "
            "that year simply render with no auto-injected holidays, and customers "
            "can still add their own entries. Refreshing the data annually is an "
            "ops task (`scripts/refresh-holidays.py`).\n\n"
            "Cached hard (1 day, 7-day stale-while-revalidate); the data changes at "
            "most once a year."
        ),
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="`{events: [...]}` plus any locale metadata stored with it.",
            ),
            400: OpenApiResponse(description="Malformed locale or a year outside the supported range."),
            404: OpenApiResponse(description="No holiday file for this locale/year."),
        },
        auth=[],
    )
    def get(self, request, locale: str, year: str):
        try:
            locale, year_int = _safe_locale_year(locale, year)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        data = _read_holidays(locale, year_int)
        if data is None:
            return Response(
                {'detail': f"No holiday data for {locale}/{year_int}"},
                status=status.HTTP_404_NOT_FOUND,
            )
        response = Response(data)
        # 1-day cache + 7-day stale-while-revalidate. Holiday data changes
        # at most once a year, so aggressive caching is the right call.
        response['Cache-Control'] = 'public, max-age=86400, stale-while-revalidate=604800'
        return response

    def _gate_ops(self, request):
        """Returns (user, None) on success or (None, Response) on auth failure."""
        from .authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue
        if not user:
            return None, Response(
                {'detail': 'Authentication required'},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return None, Response(
                {'detail': 'Only ops team can modify holidays'},
                status=status.HTTP_403_FORBIDDEN,
            )
        return user, None

    @extend_schema(
        tags=["calendar"],
        summary="Replace a locale-year holiday file (ops only)",
        description=(
            "Replaces one year's holidays for one locale. Ops team only, via "
            "`/api/ops/holidays/<locale>/<year>`.\n\n"
            "Takes effect on the next render — already-queued jobs read the data "
            "snapshotted when they were submitted."
        ),
        request=inline_serializer(
            name="HolidayFileWrite",
            fields={"events": drf_serializers.ListField(
                child=drf_serializers.DictField(),
                help_text="Holiday entries. Required, and must be an array.",
            )},
        ),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT, description="The holiday file as stored."),
            400: OpenApiResponse(description="Malformed locale/year, body not a JSON object, or no `events` array."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def put(self, request, locale: str, year: str):
        try:
            locale, year_int = _safe_locale_year(locale, year)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        user, err = self._gate_ops(request)
        if err:
            return err

        payload = request.data
        if not isinstance(payload, dict):
            return Response(
                {'detail': 'request body must be a JSON object'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        events = payload.get('events')
        if not isinstance(events, list):
            return Response(
                {'detail': 'payload must contain an "events" array'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Lightly validate each event so an ops typo doesn't corrupt the file.
        # Empty events: [] is intentionally allowed — it's the canonical way to
        # clear out a year's auto-injection without deleting the file (which
        # would also drop the _meta metadata).
        from datetime import date as _date
        for idx, ev in enumerate(events):
            if not isinstance(ev, dict):
                return Response(
                    {'detail': f'events[{idx}] must be an object'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            date_str = ev.get('date')
            if not isinstance(date_str, str):
                return Response(
                    {'detail': f"events[{idx}].date must be a string"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Full ISO YYYY-MM-DD parse — rejects "2026-13-32" and friends
            # that the old startswith check would have let through.
            try:
                parsed = _date.fromisoformat(date_str)
            except ValueError:
                return Response(
                    {'detail': f"events[{idx}].date is not a valid ISO date: {date_str!r}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if parsed.year != year_int:
                return Response(
                    {'detail': (
                        f"events[{idx}].date year ({parsed.year}) doesn't match the URL year ({year_int})"
                    )},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not ev.get('name'):
                return Response(
                    {'detail': f'events[{idx}].name is required'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Stamp authoritative metadata
        from django.utils import timezone
        payload['year'] = year_int
        payload['locale'] = locale
        payload.setdefault('_meta', {})
        payload['_meta']['lastRefreshed'] = timezone.now().isoformat()

        _write_holidays(locale, year_int, payload)
        return Response(payload)

    @extend_schema(
        tags=["calendar"],
        summary="Delete a locale-year holiday file (ops only)",
        description=(
            "Removes the file and drops its cache entry. Idempotent — deleting a "
            "locale/year that has no file still returns 204.\n\n"
            "Calendars for that year then render with no auto-injected holidays "
            "rather than failing."
        ),
        request=None,
        responses={
            204: OpenApiResponse(description="Deleted, or there was nothing to delete."),
            400: OpenApiResponse(description="Malformed locale or year."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def delete(self, request, locale: str, year: str):
        try:
            locale, year_int = _safe_locale_year(locale, year)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        user, err = self._gate_ops(request)
        if err:
            return err
        path = _holiday_path(locale, year_int)
        if os.path.exists(path):
            os.remove(path)
            from django.core.cache import cache
            cache.delete(f"{_HOLIDAYS_CACHE_KEY}{locale}:{year_int}")
        return Response(status=status.HTTP_204_NO_CONTENT)


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