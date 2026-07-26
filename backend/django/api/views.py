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

    django_cache.delete_many(["layouts_list_all", "ops_layouts_list_all"])

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
            )
        },
    )
    def get(self, request):
        try:
            from django.core.cache import cache as django_cache
            CACHE_KEY = "layouts_list_all"
            CACHE_TTL = 120  # 2 minutes — invalidated on upload/save

            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                storage = get_storage()
                layout_names = storage.list_layouts()
                layouts_data = []
                for name in layout_names:
                    path = os.path.join(storage.layouts_dir(), f"{name}.json")
                    if os.path.exists(path):
                        try:
                            with open(path, "r") as f:
                                data = json.load(f)
                                # The filename is the identifier every path-based
                                # endpoint (get/put/delete/render) resolves by, so it
                                # must win here too. A layout whose stored "name"
                                # diverges from its filename (e.g. classic_A4.json
                                # carrying "name":"classic_a4") is otherwise
                                # unopenable and undeletable on a case-sensitive
                                # (production Linux) filesystem — the list reports
                                # "classic_a4" but only "classic_A4.json" exists.
                                data["name"] = name
                                # Explicit flag for the ops layout list badge (PRD §6
                                # Phase 6 / audit fix #4). Frontend can also check
                                # `productType` directly but hasCalendar is the
                                # canonical field per the PRD spec.
                                data["hasCalendar"] = data.get("productType") == "calendar"
                                layouts_data.append(data)
                        except Exception:
                            layouts_data.append({"name": name})
                    else:
                        layouts_data.append({"name": name})
                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
                logger.info(f"Layouts cache miss — loaded {len(layouts_data)} layouts from disk")
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
            200: inline_serializer(
                name="GenerateLayoutResponse",
                fields={
                    "canvases": drf_serializers.ListField(child=drf_serializers.CharField()),
                    "layout_name": drf_serializers.CharField(),
                    "export_format": drf_serializers.CharField(),
                    "generation_time_ms": drf_serializers.IntegerField(),
                },
            ),
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


class CeleryMonitoringView(APIView):
    """Monitoring endpoint for ops team to check Celery worker status."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    
    def get(self, request):
        """Get Celery worker and queue statistics."""
        from celery import current_app
        from api.models import RenderJob
        from django.utils import timezone
        from datetime import timedelta
        
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
            }
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
            # Malformed name is a client error; a well-formed name that simply
            # isn't there is a missing resource. Collapsing both into 400
            # "Invalid layout name" made a deleted layout look like a caller
            # bug — misleading for partners whose SKU maps to a removed layout.
            if not self._is_safe_layout_name(name):
                return Response(
                    {"detail": "Invalid layout name"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            if not self._layout_exists(name):
                return Response(
                    {"detail": f"Layout '{name}' not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            from django.core.cache import cache as django_cache

            storage = get_storage()
            # Use basename to prevent path traversal
            safe_name = os.path.basename(name)

            # Cache individual layout JSON (same TTL as list endpoint)
            surfaces_param = request.query_params.get('surfaces', '')
            cache_key = f"layout_detail:{safe_name}:{surfaces_param}"
            cached_data = django_cache.get(cache_key)

            if cached_data is not None:
                response = Response(cached_data)
                response['Cache-Control'] = 'private, max-age=30, must-revalidate'
                return response

            path = os.path.join(storage.layouts_dir(), f"{safe_name}.json")

            # Extra security: ensure path is within layouts directory
            if not self._is_path_safe(path, storage.layouts_dir()):
                return Response(
                    {"detail": "Access denied"},
                    status=status.HTTP_403_FORBIDDEN
                )

            if not os.path.exists(path):
                return Response(
                    {"detail": "Layout not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            with open(path, "r") as f:
                data = json.load(f)

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            django_cache.set(cache_key, data, 120)  # 2 min TTL, same as list endpoint

            response = Response(data)
            response['Cache-Control'] = 'private, max-age=30, must-revalidate'
            return response

        except json.JSONDecodeError:
            logger.error(f"Invalid JSON in layout file: {name}")
            return Response(
                {"detail": "Corrupted layout file"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        except Exception as e:
            logger.error(f"Error getting layout: {str(e)}")
            return Response(
                {"detail": "Failed to get layout"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @staticmethod
    def _is_safe_layout_name(name: str) -> bool:
        """Path-traversal guard only — says nothing about existence."""
        if not name or '/' in name or '\\' in name or '..' in name:
            return False
        return not name.startswith('.')

    @staticmethod
    def _layout_exists(name: str) -> bool:
        try:
            return name in get_storage().list_layouts()
        except Exception:
            return False

    @staticmethod
    def _is_valid_layout_name(name: str) -> bool:
        """Safe AND present. Retained for callers that treat absence as a 400."""
        return GetLayoutView._is_safe_layout_name(name) and GetLayoutView._layout_exists(name)

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


class LayoutManagementView(APIView):
    """View to manage layout JSON files - requires Ops Team permissions."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    from rest_framework.parsers import JSONParser, MultiPartParser, FormParser
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    
    def _is_valid_layout_name(self, name: str) -> bool:
        """Validate layout name for security."""
        import re
        return bool(re.match(r'^[a-zA-Z0-9_.\-]+$', name))
    
    def _is_path_safe(self, path: str, base_dir: str) -> bool:
        """Ensure path is within the intended directory."""
        return os.path.abspath(path).startswith(os.path.abspath(base_dir))

    def get(self, request, name=None):
        """List layouts or get a specific layout's JSON."""
        from django.core.cache import cache as django_cache
        storage = get_storage()
        if name:
            if not self._is_valid_layout_name(name):
                return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

            path = os.path.join(storage.layouts_dir(), f"{name}.json")
            if not self._is_path_safe(path, storage.layouts_dir()):
                return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)

            if not os.path.exists(path):
                return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)

            try:
                with open(path, "r") as f:
                    response = Response(json.load(f))
                    # Single-layout fetches are dominated by the editor mount on
                    # an ops admin's machine; a 60 s browser cache + 120 s SWR
                    # keeps repeat visits free without making invalidation
                    # tricky (PUT clears `layouts_list_all` already; per-layout
                    # cache is browser-only and ages out fast).
                    response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
                    return response
            except Exception as e:
                return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        else:
            # Full list — server-side Django cache mirrors ListLayoutsView so
            # repeat hits skip the disk scan; HTTP Cache-Control lets the
            # admin's browser cache it too.
            CACHE_KEY = "ops_layouts_list_all"
            CACHE_TTL = 120
            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                layout_names = storage.list_layouts()
                layouts_data = []
                for name in layout_names:
                    path = os.path.join(storage.layouts_dir(), f"{name}.json")
                    if os.path.exists(path):
                        try:
                            with open(path, "r") as f:
                                data = json.load(f)
                                # Filename is the source of truth for the identifier
                                # (see ListLayoutsView) — always override a divergent
                                # stored "name" so open/delete resolve on a
                                # case-sensitive prod filesystem.
                                data["name"] = name
                                data["hasCalendar"] = data.get("productType") == "calendar"
                                layouts_data.append(data)
                        except Exception:
                            layouts_data.append({"name": name})
                    else:
                        layouts_data.append({"name": name})
                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
            response = Response({"layouts": layouts_data})
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response

    def post(self, request, name=None):
        """Create or update a layout JSON file."""
        layout_name = name or request.data.get("name")
        layout_data = request.data.get("layout_data") or request.data.get("layout")
        
        if not layout_name or not layout_data:
            return Response({"detail": "name and layout_data are required"}, status=status.HTTP_400_BAD_REQUEST)
        
        if not self._is_valid_layout_name(layout_name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
            
        storage = get_storage()
        path = os.path.join(storage.layouts_dir(), f"{layout_name}.json")
        
        if not self._is_path_safe(path, storage.layouts_dir()):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
        
        # Support rename: if old_name is provided and differs from layout_name,
        # the old file will be removed after the new one is saved.
        old_name = request.data.get("old_name") or request.data.get("originalName")
        if old_name and old_name == layout_name:
            old_name = None  # Not actually a rename
        
        try:
            # Basic validation: ensure it's a valid JSON dict
            if isinstance(layout_data, str):
                layout_data = json.loads(layout_data)
            
            # Ensure required fields for LayoutEngine exist
            is_multi_surface = layout_data.get('type') == 'product' and isinstance(layout_data.get('surfaces'), list)
            if is_multi_surface:
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
            
            # Append metadata
            from django.utils import timezone
            now = timezone.now().isoformat()
            
            # Use full_name and empid if available, fallback to username
            full_name = getattr(request.user, 'full_name', getattr(request.user, 'username', str(request.user)))
            emp_id = getattr(request.user, 'empid', None)
            
            # Prepare metadata in array format for fast external loading/parsing
            meta_entries = {
                "createdByName": full_name,
                "createdById": emp_id,
                "createdAt": now,
                "updatedByName": full_name,
                "updatedById": emp_id,
                "updatedAt": now
            }
            
            # Handle Mask Image Upload
            # For multi-surface layouts, masks can be uploaded as mask_{surface_key} fields
            if is_multi_surface:
                for surface in layout_data.get('surfaces', []):
                    surface_key = surface.get('key', '')
                    mask_field = f"mask_{surface_key}"
                    surface_mask_file = request.FILES.get(mask_field)
                    if surface_mask_file:
                        try:
                            import glob as glob_mod_s
                            existing = glob_mod_s.glob(os.path.join(storage.masks_dir(), f"{layout_name}_{surface_key}_mask.*"))
                            for m in existing:
                                if os.path.exists(m):
                                    os.remove(m)
                        except Exception as e:
                            logger.warning(f"Failed to cleanup old surface masks: {e}")
                        mask_filename = f"{layout_name}_{surface_key}_mask{os.path.splitext(surface_mask_file.name)[1]}"
                        mask_path = os.path.join(storage.masks_dir(), mask_filename)
                        with open(mask_path, 'wb+') as destination:
                            for chunk in surface_mask_file.chunks():
                                destination.write(chunk)
                        surface['maskUrl'] = f"/api/layouts/masks/{mask_filename}"

            mask_file = request.FILES.get('mask')
            if mask_file:
                # Cleanup ANY existing mask files for this layout first (to handle extension changes)
                try:
                    import glob
                    existing_masks = glob.glob(os.path.join(storage.masks_dir(), f"{layout_name}_mask.*"))
                    for m in existing_masks:
                        if os.path.exists(m):
                            os.remove(m)
                except Exception as e:
                    logger.warning(f"Failed to cleanup old masks during update: {e}")

                mask_filename = f"{layout_name}_mask{os.path.splitext(mask_file.name)[1]}"
                mask_path = os.path.join(storage.masks_dir(), mask_filename)
                with open(mask_path, 'wb+') as destination:
                    for chunk in mask_file.chunks():
                        destination.write(chunk)
                layout_data['maskUrl'] = f"/api/layouts/masks/{mask_filename}"
            
            # Handle boolean flag for maskOnExport
            if 'maskOnExport' in request.data:
                val = request.data.get('maskOnExport')
                layout_data['maskOnExport'] = str(val).lower() == 'true'

            # Handle explicit mask removal
            remove_mask = str(request.data.get('remove_mask', '')).lower() == 'true'
            if remove_mask:
                # Delete existing mask files from disk
                try:
                    import glob as glob_mod
                    existing_masks = glob_mod.glob(os.path.join(storage.masks_dir(), f"{layout_name}_mask.*"))
                    for m in existing_masks:
                        os.remove(m)
                        logger.info(f"Removed mask file: {m}")
                except Exception as e:
                    logger.warning(f"Failed to cleanup masks during removal: {e}")
                layout_data['maskUrl'] = None
                layout_data['maskOnExport'] = False

            if os.path.exists(path):
                try:
                    with open(path, "r") as f:
                        existing_data = json.load(f)

                    # Handle Mask Migration if layout is renamed but mask already exists for old name
                    # This prevents broken mask URLs when 'Saving As' or renaming
                    # Skip restoration if mask was explicitly removed
                    if not remove_mask and 'maskUrl' not in layout_data and 'maskUrl' in existing_data:
                        layout_data['maskUrl'] = existing_data['maskUrl']
                    elif not remove_mask and layout_data.get('maskUrl') and not mask_file:
                        old_mask_url = layout_data['maskUrl']
                        if f"masks/{layout_name}_mask" not in old_mask_url:
                            # Mask belongs to a different layout name, try to migrate it
                            try:
                                old_filename = os.path.basename(old_mask_url)
                                old_path = os.path.join(storage.masks_dir(), old_filename)
                                if os.path.exists(old_path):
                                    ext = os.path.splitext(old_filename)[1]
                                    new_filename = f"{layout_name}_mask{ext}"
                                    new_path = os.path.join(storage.masks_dir(), new_filename)
                                    
                                    import shutil
                                    # Only copy if destination doesn't exist to avoid infinite recursion or overhead
                                    if not os.path.exists(new_path):
                                        shutil.copy2(old_path, new_path)
                                        layout_data['maskUrl'] = f"/api/layouts/masks/{new_filename}"
                                        logger.info(f"Migrated mask from {old_filename} to {new_filename} due to layout rename")
                            except Exception as e:
                                logger.warning(f"Failed to migrate mask during rename: {e}")

                    # Persist certain fields if not provided (skip if mask was explicitly removed)
                    if not remove_mask and 'maskOnExport' not in layout_data and 'maskOnExport' in existing_data:
                        layout_data['maskOnExport'] = existing_data['maskOnExport']

                    # Persist creation metadata
                    existing_meta = existing_data.get('metadata', {})
                    if isinstance(existing_meta, list):
                        # Convert list back to dict for easy update if it was already stored as list
                        existing_meta = {item['key']: item['value'] for item in existing_meta if 'key' in item}
                    
                    meta_entries["createdByName"] = existing_meta.get("createdByName", full_name)
                    meta_entries["createdById"] = existing_meta.get("createdById", emp_id)
                    meta_entries["createdAt"] = existing_meta.get("createdAt", now)
                    
                    # Merge tags if they aren't explicitly provided
                    if 'tags' not in layout_data and 'tags' in existing_data:
                        layout_data['tags'] = existing_data['tags']
                except Exception:
                    pass

            # Update final metadata object (storing both for backward compatibility and the new array format)
            # The user specifically requested an array format [ {label: value} ]
            # Keep legacy top-level fields for existing UI components to prevent breakage while transitioning
            layout_data['createdAt'] = meta_entries["createdAt"]
            layout_data['createdBy'] = f"{meta_entries['createdByName']} ({meta_entries['createdById']})" if meta_entries['createdById'] else meta_entries['createdByName']
            layout_data['updatedAt'] = meta_entries["updatedAt"]
            layout_data['updatedBy'] = f"{meta_entries['updatedByName']} ({meta_entries['updatedById']})" if meta_entries['updatedById'] else meta_entries['updatedByName']
            
            # Ensure tags is a list
            if 'tags' not in layout_data:
                layout_data['tags'] = []
            elif isinstance(layout_data['tags'], str):
                layout_data['tags'] = [t.strip() for t in layout_data['tags'].split(',') if t.strip()]

            # Final Dimensions & Metadata array for easy extraction
            if is_multi_surface:
                surface_dims = []
                for s in layout_data.get('surfaces', []):
                    sc = s.get('canvas', {})
                    try:
                        sw = float(sc.get('widthMm', 0))
                        sh = float(sc.get('heightMm', 0))
                    except (ValueError, TypeError):
                        sw = sh = 0
                    surface_dims.append(f"{s.get('key', '?')}: {sw:.2f}x{sh:.2f}mm")
                dim_str = " | ".join(surface_dims) if surface_dims else "N/A"
            else:
                canvas = layout_data.get('canvas', {})
                try:
                    val_w = float(canvas.get('widthMm', 0))
                    val_h = float(canvas.get('heightMm', 0))
                except (ValueError, TypeError):
                    val_w = 0
                    val_h = 0
                dim_str = f"{val_w:.2f} x {val_h:.2f}mm"
            
            layout_data['metadata'] = [
                {"key": "createdByName", "label": "Created By", "value": meta_entries["createdByName"]},
                {"key": "createdById", "label": "Emp ID", "value": meta_entries["createdById"]},
                {"key": "createdAt", "label": "Created At", "value": meta_entries["createdAt"]},
                {"key": "updatedByName", "label": "Updated By", "value": meta_entries["updatedByName"]},
                {"key": "updatedById", "label": "Updated Emp ID", "value": meta_entries["updatedById"]},
                {"key": "updatedAt", "label": "Updated At", "value": meta_entries["updatedAt"]},
                {"key": "dimensions", "label": "Dimensions", "value": dim_str},
                {"key": "tags", "label": "Tags", "value": ", ".join(layout_data.get('tags', []))},
                {"key": "maskOnExport", "label": "Mask on Export", "value": "Enabled" if layout_data.get('maskOnExport') else "Disabled"}
            ]
            with open(path, "w") as f:
                json.dump(layout_data, f, indent=4)
            
            # --- Rename Cleanup: Delete the old layout file and move old mask ---
            if old_name and old_name != layout_name:
                old_path = os.path.join(storage.layouts_dir(), f"{old_name}.json")
                if os.path.exists(old_path):
                    try:
                        os.remove(old_path)
                        logger.info(f"Rename: removed old layout file '{old_name}.json'")
                    except Exception as e:
                        logger.warning(f"Rename: could not remove old file '{old_name}.json': {e}")
                # Move old mask to new name if it exists and wasn't already migrated above
                try:
                    import glob
                    old_masks = glob.glob(os.path.join(storage.masks_dir(), f"{old_name}_mask.*"))
                    for old_mask in old_masks:
                        ext = os.path.splitext(old_mask)[1]
                        new_mask = os.path.join(storage.masks_dir(), f"{layout_name}_mask{ext}")
                        if not os.path.exists(new_mask):
                            import shutil
                            shutil.move(old_mask, new_mask)
                            logger.info(f"Rename: moved mask {old_mask} -> {new_mask}")
                        else:
                            os.remove(old_mask)
                except Exception as e:
                    logger.warning(f"Rename: mask move failed: {e}")
            
            # Clear the list caches AND this layout's detail entries, so the
            # editor cannot keep composing against the pre-edit geometry.
            # On rename, old_name's entries must go too or the old id stays
            # resolvable until its TTL lapses.
            invalidate_layout_caches(layout_name)
            if old_name and old_name != layout_name:
                invalidate_layout_caches(old_name)

            return Response({"status": "success", "name": layout_name, "maskUrl": layout_data.get('maskUrl')})
        except json.JSONDecodeError:
            return Response({"detail": "Invalid JSON data"}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            logger.error(f"Error saving layout {layout_name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    def delete(self, request, name):
        """Delete a layout JSON file."""
        if not self._is_valid_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
        
        storage = get_storage()
        path = os.path.join(storage.layouts_dir(), f"{name}.json")
        
        if not self._is_path_safe(path, storage.layouts_dir()):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
        if not os.path.exists(path):
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
            
        try:
            # Cleanup mask file if it exists
            try:
                import glob
                mask_pattern = os.path.join(storage.masks_dir(), f"{name}_mask.*")
                for m in glob.glob(mask_pattern):
                    if os.path.exists(m):
                        os.remove(m)
            except Exception as e:
                logger.warning(f"Failed to delete mask for layout {name}: {e}")

            os.remove(path)
            # Clear both list caches AND this layout's detail entries. Dropping
            # only "layouts_list_all" left the ops Templates page serving the
            # deleted row for its 2-minute TTL; leaving the detail entries meant
            # the deleted layout stayed openable in the editor for just as long.
            invalidate_layout_caches(name)
            return Response({"status": "success", "detail": f"Layout {name} deleted"})
        except Exception as e:
            logger.error(f"Error deleting layout {name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class ExternalLayoutDetailView(APIView):
    """
    Secured view for external systems to fetch layout JSON.
    Requires a valid API Key or Bearer Token.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    def _is_valid_layout_name(self, name: str) -> bool:
        # Dots are valid — layout names like `retro_polaroid_4.2x3.5` contain them.
        # Double-dot sequences are still blocked to prevent path traversal.
        return bool(re.match(r'^[a-zA-Z0-9_.\-]+$', name)) and '..' not in name

    def _is_path_safe(self, path: str, base_dir: str) -> bool:
        return os.path.abspath(path).startswith(os.path.abspath(base_dir))

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
        # 400 for a malformed name, 404 for one that simply isn't there.
        if not GetLayoutView._is_safe_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
        if not GetLayoutView._layout_exists(name):
            return Response({"detail": f"Layout '{name}' not found"}, status=status.HTTP_404_NOT_FOUND)

        storage = get_storage()
        path = os.path.join(storage.layouts_dir(), f"{name}.json")
        
        if not self._is_path_safe(path, storage.layouts_dir()):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
        if not os.path.exists(path):
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
            
        try:
            with open(path, "r") as f:
                data = json.load(f)

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
    """View to download/serve layout mask images."""
    permission_classes = [AllowAny] # Publicly accessible if URL is known

    def get(self, request, filename):
        storage = get_storage()
        path = os.path.join(storage.masks_dir(), filename)
        
        # Security check: ensure path is within masks directory
        if not os.path.abspath(path).startswith(os.path.abspath(storage.masks_dir())):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
        if not os.path.exists(path):
            return Response({"detail": "Mask not found"}, status=status.HTTP_404_NOT_FOUND)
            
        try:
            from django.http import FileResponse
            import mimetypes
            content_type, _ = mimetypes.guess_type(path)
            return FileResponse(open(path, 'rb'), content_type=content_type or 'image/png')
        except Exception as e:
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


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
            "                 docs/INTEGRATION.md for the full contract)\n"
            "```\n\n"
            "### Security guarantees\n\n"
            "- Token is a disposable UUID — never the real API key\n"
            "- All subsequent calls from the embed page go through the Next.js server-side proxy "
            "which resolves the token to the real key without exposing it to the browser\n"
            "- Token expires after 2 hours; generate a fresh one per customer session\n\n"
            "**Auth:** `Authorization: Bearer <real-api-key>` (server-to-server only)"
        ),
        request=None,
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
        },
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

        name = (request.query_params.get('layout') or '').strip()
        if not name:
            return Response({'detail': '`layout` query param required'}, status=status.HTTP_400_BAD_REQUEST)
        # 400 for a malformed name, 404 for one that simply isn't there — the
        # editor needs to tell "bad request" apart from "this layout is gone".
        if not GetLayoutView._is_safe_layout_name(name):
            return Response({'detail': 'Invalid layout name'}, status=status.HTTP_400_BAD_REQUEST)
        if not GetLayoutView._layout_exists(name):
            return Response({'detail': f"Layout '{name}' not found"}, status=status.HTTP_404_NOT_FOUND)

        surfaces_param = request.query_params.get('surfaces', '')
        # Reuse the GetLayoutView cache key so a request to either endpoint
        # warms both. Cache TTL matches GetLayoutView (2 min).
        cache_key = f"layout_detail:{name}:{surfaces_param}"
        layout_data = django_cache.get(cache_key)

        if layout_data is None:
            storage = get_storage()
            safe_name = os.path.basename(name)
            path = os.path.join(storage.layouts_dir(), f"{safe_name}.json")
            if not GetLayoutView._is_path_safe(path, storage.layouts_dir()):
                return Response({'detail': 'Access denied'}, status=status.HTTP_403_FORBIDDEN)
            if not os.path.exists(path):
                return Response({'detail': 'Layout not found'}, status=status.HTTP_404_NOT_FOUND)
            try:
                with open(path, 'r') as f:
                    layout_data = json.load(f)
            except json.JSONDecodeError:
                logger.error("Invalid JSON in layout file: %s", name)
                return Response({'detail': 'Corrupted layout file'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

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
        response['Cache-Control'] = 'private, max-age=30, must-revalidate'
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
_SKU_LAYOUTS_CACHE_KEY = 'storage:sku_layouts'
_STORAGE_CACHE_TTL = 300


def _read_fonts():
    """Read the fonts config from disk, with a 5-minute Redis cache."""
    from django.core.cache import cache
    cached = cache.get(_FONTS_CACHE_KEY)
    if cached is not None:
        return cached
    try:
        with open(FONTS_JSON_PATH, 'r') as f:
            data = json.load(f)
            value = data if isinstance(data, list) else DEFAULT_FONTS
    except (FileNotFoundError, json.JSONDecodeError):
        value = DEFAULT_FONTS
    cache.set(_FONTS_CACHE_KEY, value, _STORAGE_CACHE_TTL)
    return value


def _write_fonts(fonts):
    """Write fonts config to disk and invalidate the cache."""
    from django.core.cache import cache
    with open(FONTS_JSON_PATH, 'w') as f:
        json.dump(fonts, f, indent=2)
    cache.delete(_FONTS_CACHE_KEY)


class FontsView(APIView):
    """
    GET  /api/fonts  — returns the list of enabled fonts (open to any authenticated user).
    PUT  /api/fonts  — saves the list of enabled fonts (ops team only).
    """
    permission_classes = [AllowAny]

    def get(self, request):
        response = Response({'fonts': _read_fonts()})
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

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


SKU_LAYOUTS_JSON_PATH = os.path.join(settings.STORAGE_ROOT, 'sku_layouts.json')


def _read_sku_layouts():
    """Read the SKU → layout mapping with a 5-minute Redis cache."""
    from django.core.cache import cache
    cached = cache.get(_SKU_LAYOUTS_CACHE_KEY)
    if cached is not None:
        return cached
    try:
        with open(SKU_LAYOUTS_JSON_PATH, 'r') as f:
            data = json.load(f)
            mappings = data.get('mappings') if isinstance(data, dict) else data
            value = mappings if isinstance(mappings, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        value = {}
    cache.set(_SKU_LAYOUTS_CACHE_KEY, value, _STORAGE_CACHE_TTL)
    return value


def _write_sku_layouts(mappings):
    """Persist the SKU → layout mapping atomically and invalidate the cache."""
    from django.core.cache import cache
    payload = {
        '_meta': {
            'description': 'Maps Printo SKU codes to layout names from storage/layouts/.',
            'version': 1,
        },
        'mappings': mappings,
    }
    tmp_path = SKU_LAYOUTS_JSON_PATH + '.tmp'
    with open(tmp_path, 'w') as f:
        json.dump(payload, f, indent=2, sort_keys=True)
    os.replace(tmp_path, SKU_LAYOUTS_JSON_PATH)
    cache.delete(_SKU_LAYOUTS_CACHE_KEY)


class SKULayoutView(APIView):
    """
    SKU → layout resolution. Public read so printo.in can call it before
    creating the embed session; ops-team write to update the mapping.

    GET  /api/sku-layouts/             → { "mappings": { sku: layout_name, ... } }
    GET  /api/sku-layouts/<sku>/       → { "sku": ..., "layout_name": ... } or 404
    PUT  /api/sku-layouts/             → { "mappings": {...} }, ops-team only
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["sku-layouts"],
        summary="Get SKU → layout mapping",
        description="Returns the full mapping (no `sku` arg) or a single resolution.",
    )
    def get(self, request, sku=None):
        mappings = _read_sku_layouts()
        if sku is None:
            response = Response({'mappings': mappings})
            response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
            return response

        layout_name = mappings.get(sku)
        if not layout_name:
            return Response(
                {'detail': f'No layout mapped for SKU "{sku}"'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Verify the mapped layout actually exists on disk so callers don't
        # get a stale pointer to a deleted layout.
        layout_path = os.path.join(settings.LAYOUTS_DIR, f'{layout_name}.json')
        if not os.path.exists(layout_path):
            logger.warning(
                "SKU '%s' maps to missing layout '%s'", sku, layout_name
            )
            return Response(
                {'detail': f'SKU "{sku}" is mapped to layout "{layout_name}" which no longer exists'},
                status=status.HTTP_410_GONE,
            )

        response = Response({'sku': sku, 'layout_name': layout_name})
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

    @extend_schema(
        tags=["sku-layouts"],
        summary="Replace SKU → layout mapping (ops only)",
    )
    def put(self, request):
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

        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return Response({'detail': 'Only ops team can modify SKU mappings'}, status=status.HTTP_403_FORBIDDEN)

        mappings = request.data.get('mappings')
        if not isinstance(mappings, dict):
            return Response({'detail': 'mappings must be an object {sku: layout_name}'}, status=status.HTTP_400_BAD_REQUEST)
        if not all(isinstance(k, str) and isinstance(v, str) for k, v in mappings.items()):
            return Response({'detail': 'mappings keys and values must all be strings'}, status=status.HTTP_400_BAD_REQUEST)

        # Reject mappings to nonexistent layouts so we never persist a broken pointer.
        missing = [
            (sku, layout) for sku, layout in mappings.items()
            if not os.path.exists(os.path.join(settings.LAYOUTS_DIR, f'{layout}.json'))
        ]
        if missing:
            return Response(
                {
                    'detail': 'Some mappings reference layouts that do not exist',
                    'missing': [{'sku': s, 'layout_name': l} for s, l in missing],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        _write_sku_layouts(mappings)
        return Response({'mappings': mappings})


# ── Calendar style presets + Gen-Z palettes (PRD §10.3, §6.3) ───────────────

CALENDAR_STYLES_DIR = os.path.join(settings.STORAGE_ROOT, 'calendar_styles')
GENZ_PALETTES_DIR = os.path.join(settings.STORAGE_ROOT, 'calendar_palettes', 'genz')
_CALENDAR_STYLES_CACHE_KEY = 'storage:calendar_styles:list'
_CALENDAR_STYLE_CACHE_KEY = 'storage:calendar_styles:'  # + name


def _list_calendar_styles():
    """Return [{name, label}] for every calendar style on disk."""
    from django.core.cache import cache
    cached = cache.get(_CALENDAR_STYLES_CACHE_KEY)
    if cached is not None:
        return cached

    out = []
    if os.path.isdir(CALENDAR_STYLES_DIR):
        for fname in sorted(os.listdir(CALENDAR_STYLES_DIR)):
            if not fname.endswith('.json'):
                continue
            path = os.path.join(CALENDAR_STYLES_DIR, fname)
            try:
                with open(path, 'r') as f:
                    style = json.load(f)
                out.append({
                    'name': style.get('name') or fname[:-5],
                    'label': style.get('label') or style.get('name') or fname[:-5],
                    'description': style.get('description') or '',
                })
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read calendar style %s: %s", fname, exc)
    cache.set(_CALENDAR_STYLES_CACHE_KEY, out, _STORAGE_CACHE_TTL)
    return out


def _read_calendar_style(name):
    """Read a single calendar style JSON. Returns None if missing/invalid."""
    from django.core.cache import cache
    cache_key = _CALENDAR_STYLE_CACHE_KEY + name
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    path = os.path.join(CALENDAR_STYLES_DIR, f'{name}.json')
    # Path-traversal guard — name must round-trip through basename.
    if os.path.basename(path) != f'{name}.json' or not name.replace('-', '').replace('_', '').isalnum():
        return None
    try:
        with open(path, 'r') as f:
            style = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

    # For Gen-Z, attach the available palettes inline so clients don't
    # have to make a second request to enumerate them.
    if style.get('name') == 'modern-genz' and os.path.isdir(GENZ_PALETTES_DIR):
        palettes = []
        for fname in sorted(os.listdir(GENZ_PALETTES_DIR)):
            if fname.endswith('.json'):
                try:
                    with open(os.path.join(GENZ_PALETTES_DIR, fname), 'r') as f:
                        palettes.append(json.load(f))
                except (OSError, json.JSONDecodeError):
                    continue
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
    """Read a holiday file from disk with a Redis cache."""
    from django.core.cache import cache
    cache_key = f"{_HOLIDAYS_CACHE_KEY}{locale}:{year}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    path = _holiday_path(locale, year)
    if not os.path.exists(path):
        cache.set(cache_key, None, _STORAGE_CACHE_TTL)
        return None
    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read holiday file %s: %s", path, exc)
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
    Stream all output files of a completed render job as a single ZIP archive.

    This replaces the client-side ZIP assembly (JSZip + canvas re-render) with a
    lightweight server-side stream, eliminating the CPU/RAM spike on low-end devices.

    GET /api/jobs/<job_id>/download/
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanAccessExports]

    @extend_schema(
        tags=["exports"],
        summary="Download completed job output as ZIP",
        description=(
            "Streams all output files (PNG or PDF) for a completed render job as a "
            "single ZIP archive. Returns 409 if the job has not yet completed."
        ),
        responses={
            200: OpenApiResponse(description="application/zip binary stream"),
            404: OpenApiResponse(description="Job not found or no output files"),
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

        if not safe_print_paths:
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
        safe_upload_entries: list[tuple[str, str]] = []  # (resolved_path, arcname_basename)
        if include_uploads:
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
        safe_layout = re.sub(r'[^A-Za-z0-9_.\-]+', '-', (canvas.layout_name or 'design')).strip('-._') or 'design'
        zip_name = f"{safe_layout[:48]}-{str(job_id)[:8]}.zip"
        tmp = tempfile.NamedTemporaryFile(
            mode='w+b', suffix='.zip', delete=False, dir=exports_root,
        )
        mock_count = 0
        try:
            with zipfile.ZipFile(tmp, mode='w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
                # 1_customer_uploads/ — original photos as customer named them
                for path, original_name in safe_upload_entries:
                    zf.write(path, arcname=f'1_customer_uploads/{original_name}')

                # 2_mock/ + 3_print/ — paired by index from the print list
                for idx, print_path in enumerate(safe_print_paths, start=1):
                    print_basename = os.path.basename(print_path)
                    zf.write(print_path, arcname=f'3_print/{print_basename}')

                    # Prefer the pre-generated sibling JPEG (cheap path).
                    # Falls back to on-the-fly downscaling for legacy jobs
                    # rendered before the engine started writing siblings.
                    stem = os.path.splitext(print_basename)[0]
                    sibling_mock = os.path.splitext(print_path)[0] + '_preview.jpg'
                    sibling_mock_real = os.path.realpath(sibling_mock)
                    if (
                        os.path.isfile(sibling_mock_real)
                        and sibling_mock_real.startswith(exports_root + os.sep)
                    ):
                        zf.write(sibling_mock_real, arcname=f'2_mock/{stem}_preview.jpg')
                        mock_count += 1
                    else:
                        mock_bytes = _build_mock_jpeg_bytes(print_path)
                        if mock_bytes is not None:
                            zf.writestr(
                                f'2_mock/{stem}_preview.jpg',
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

        api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
        if api_key:
            logger.info(
                "Job ZIP downloaded: job=%s uploads=%d mocks=%d prints=%d size=%d by %s",
                job_id, len(safe_upload_entries), mock_count,
                len(safe_print_paths), zip_size, api_key.name,
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
        responses={
            200: OpenApiResponse(description="State saved / updated"),
            201: OpenApiResponse(description="State created"),
            400: OpenApiResponse(description="Invalid payload"),
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

    @extend_schema(tags=["upload"], summary="Initialise a chunked upload session")
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

    @extend_schema(tags=["upload"], summary="Upload a single chunk")
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

    @extend_schema(tags=["upload"], summary="Assemble chunks and finalise upload")
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

    @extend_schema(tags=["upload"], summary="Detect rotation for a single file")
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