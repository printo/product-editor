"""Ops-only endpoints: Celery/GC/disk monitoring and DPDP order-data purge."""
import re
import logging
from django.conf import settings
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import (
    extend_schema,
    OpenApiParameter,
    OpenApiResponse,
    inline_serializer,
)
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from ..permissions import IsAuthenticatedWithAPIKey, IsOpsTeam

logger = logging.getLogger(__name__)


def _jobs_per_day_status():
    """Jobs submitted per day, dashboard vs embed, for the ops monitoring endpoint.

    Degrades to an `error` key like `_disk_status`: a failed audit query must
    cost one field, not the whole endpoint.
    """
    from services.jobs_per_day import jobs_per_day
    try:
        return jobs_per_day()
    except Exception as exc:
        logger.warning("jobs_per_day failed: %s", exc)
        return {'error': str(exc)}


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
            "are absent or stale. `pressure` trips at the same 80% line the GC uses.\n\n"
            "`jobs_per_day` counts accepted `POST /api/editor/render` submissions for "
            "the last 14 IST days (oldest first, every day present, zero-filled), split "
            "into `dashboard` and `embed`. It reads the API audit trail, which is kept "
            "for `API_AUDIT_RETENTION_DAYS` (default 90) — `jobs` above cannot answer "
            "this, since a RenderJob is deleted with its canvas after the export "
            "retention window. A `0` before audit logging began is a missing record, "
            "not a quiet day. `dashboard` is the `DIRECT`/`INTERNAL` keys and `embed` "
            "is every other key; while prod has no separate INTERNAL key, `DIRECT` "
            "also carries QA embed sessions, so `dashboard` is an upper bound. "
            "`by_source` breaks the window down by key name so that can be checked."
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
                    "jobs_per_day": drf_serializers.DictField(
                        help_text=(
                            "{timezone, days[{date, dashboard, embed, total}], by_source{}} — "
                            "or {error} if the audit query failed."
                        ),
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
            # Whether the GC sweep is actually running. `stale: true` is the
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
            'jobs_per_day': _jobs_per_day_status(),
        })


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
                    "matched": drf_serializers.IntegerField(help_text="Records found for the order: saved designs, embed sessions and upload rows, plus its upload folder when present. 0 → 404."),
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
