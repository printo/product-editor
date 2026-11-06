"""The individual sweeps behind `api.tasks.garbage_collector_task`.

Each function does one sweep and returns its counts, so the task is a short list
of calls and a sweep can be read, tested and changed on its own. Behaviour is
pinned end to end by api/tests/test_gc_task.py.

Order matters and is kept by the task: files are removed before the CanvasData
rows whose cascade would otherwise strand them, and tombstones are dropped only
after the sweeps that create them.
"""
import logging
import os
import shutil
from datetime import timedelta

from django.conf import settings
from django.db.models import Q

logger = logging.getLogger(__name__)


def disk_usage_percent() -> float:
    try:
        usage = shutil.disk_usage(settings.EXPORTS_DIR)
        return (usage.used / usage.total) * 100
    except Exception as exc:
        logger.error("Failed to check disk usage: %s", exc)
        return 0


def effective_retention_days(usage_percent: float) -> int:
    """Normal retention, or the under-pressure value above 80 % disk use."""
    retention_days = settings.EXPORT_RETENTION_DAYS
    if usage_percent > 80:
        retention_days = settings.EXPORT_RETENTION_DAYS_UNDER_PRESSURE
        logger.critical(
            "EXPORTS_DIR disk usage at %.1f%% — reducing retention to %d days",
            usage_percent, retention_days,
        )
    return retention_days


def expiry_filter(now, cutoff, under_pressure: bool) -> Q:
    """Which rows are due: the expiry stamped on the row, not `created_at + retention`
    recomputed now. The old form was retroactive: shortening EXPORT_RETENTION_DAYS
    deleted files whose expiry we had already promised a partner in the completion
    webhook. Rows written before expires_at existed carry NULL and keep the
    age-based rule. Under genuine disk pressure the valve wins and it is pure age:
    setting EXPORT_RETENTION_DAYS_UNDER_PRESSURE below the normal window is an
    explicit decision to break the promise to reclaim space (see settings.py)."""
    if under_pressure:
        return Q(created_at__lt=cutoff)
    return Q(expires_at__lt=now) | Q(expires_at__isnull=True, created_at__lt=cutoff)


def _is_manual_review_path(path_str: str, review_ids: set) -> bool:
    # Match an order_id only when it sits between path separators (or at the
    # start / end of the path): 'EXT-1' must not hit inside 'EXT-12'.
    if not review_ids:
        return False
    return bool(set(path_str.split(os.sep)) & review_ids)


def sweep_expired_exports(due: Q) -> dict:
    """Delete expired export files and flag their rows. Files of orders flagged for
    manual review are skipped."""
    from api.models import CanvasData, ExportedResult

    review_ids = set(
        CanvasData.objects.filter(requires_manual_review=True).values_list('order_id', flat=True)
    )
    deleted_count = deleted_bytes = skipped_count = 0
    dirs_to_clean: set = set()
    deleted_ids: list = []

    for export in ExportedResult.objects.filter(due, is_deleted=False).only('id', 'export_file_path'):
        path_str = export.export_file_path or ''
        if _is_manual_review_path(path_str, review_ids):
            skipped_count += 1
            logger.debug("GC: skipping manual-review file %s", export.export_file_path)
            continue
        try:
            if os.path.exists(export.export_file_path):
                size = os.path.getsize(export.export_file_path)
                os.remove(export.export_file_path)
                deleted_bytes += size
                deleted_count += 1
                dirs_to_clean.add(os.path.dirname(export.export_file_path))
            deleted_ids.append(export.id)
            logger.info("GC: deleted expired file %s", export.export_file_path)
        except Exception as exc:
            logger.error("GC: failed to delete %s: %s", export.export_file_path, exc)

    # One UPDATE rather than a save() per row.
    if deleted_ids:
        ExportedResult.objects.filter(id__in=deleted_ids).update(is_deleted=True)
    _rmdir_if_empty(dirs_to_clean)
    return {'deleted_count': deleted_count, 'deleted_bytes': deleted_bytes,
            'skipped_count': skipped_count}


def sweep_expired_uploads(due: Q) -> dict:
    from api.models import UploadedFile

    deleted = deleted_bytes = 0
    deleted_ids: list = []
    for upload in UploadedFile.objects.filter(due, is_deleted=False).only('id', 'file_path'):
        try:
            if os.path.exists(upload.file_path):
                size = os.path.getsize(upload.file_path)
                os.remove(upload.file_path)
                deleted_bytes += size
                deleted += 1
            deleted_ids.append(upload.id)
        except Exception as exc:
            logger.error("GC: failed to delete upload %s: %s", upload.file_path, exc)
    if deleted_ids:
        UploadedFile.objects.filter(id__in=deleted_ids).update(is_deleted=True)
    return {'upload_deleted_count': deleted, 'upload_deleted_bytes': deleted_bytes}


def sweep_async_render_files(now) -> dict:
    """Delete the output files of render jobs whose CanvasData has expired.

    Async renders write RenderJob.output_paths but no ExportedResult, so the export
    sweep never sees them. Not filtered on status='completed', on purpose: a job
    killed mid-render (worker OOM, SIGKILL, container recreate) never completes,
    its CanvasData then expires and the delete cascades the RenderJob away, and
    the files become unreachable by any query-driven sweep. That is how 62
    orphaned export directories built up on production. Safe for unfinished jobs
    because the filter is on the canvas having expired, a full retention window,
    while a render has a 55-minute soft limit. The created_at guard covers a
    brand-new job submitted against an already-expired CanvasData (a reprint of an
    old order)."""
    from api.models import RenderJob

    files_deleted = bytes_deleted = 0
    try:
        jobs = (
            RenderJob.objects
            .filter(
                canvas_data__expires_at__lt=now,
                canvas_data__requires_manual_review=False,
                output_paths__isnull=False,
                created_at__lt=now - timedelta(days=1),
            )
            .exclude(output_paths=[])
            .select_related('canvas_data')
        )
        for job in jobs:
            dirs_to_clean: set = set()
            for fpath in (job.output_paths or []):
                try:
                    if os.path.exists(fpath):
                        size = os.path.getsize(fpath)
                        os.remove(fpath)
                        bytes_deleted += size
                        files_deleted += 1
                        dirs_to_clean.add(os.path.dirname(fpath))
                except Exception as exc:
                    logger.error("GC: failed to delete async render file %s: %s", fpath, exc)
            _rmdir_if_empty(dirs_to_clean)
    except Exception as exc:
        logger.error("GC: async render file cleanup failed: %s", exc)
    return {'async_render_files_deleted': files_deleted,
            'async_render_bytes_deleted': bytes_deleted}


def sweep_expired_canvas_data(now) -> int:
    """Delete expired CanvasData (large editor_state blobs) not flagged for manual
    review. Runs after the file sweeps so files go before the rows whose cascade
    would strand them. The count includes cascaded RenderJob rows."""
    from api.models import CanvasData

    deleted = 0
    try:
        deleted, _ = CanvasData.objects.filter(
            expires_at__lt=now, requires_manual_review=False,
        ).delete()
        if deleted:
            logger.info("GC: deleted %d expired CanvasData records", deleted)
    except Exception as exc:
        logger.error("GC: failed to delete expired CanvasData records: %s", exc)
    return deleted


def sweep_tombstones(cutoff) -> int:
    """Hard-delete flagged ExportedResult / UploadedFile rows older than the window.
    Deleting a file only flips is_deleted, and every sweep filters on
    is_deleted=False, so without this the rows pile up one per output file forever
    (7,585 on production after a single backlog clear)."""
    from api.models import ExportedResult, UploadedFile

    total = 0
    try:
        for model in (ExportedResult, UploadedFile):
            n, _ = model.objects.filter(is_deleted=True, created_at__lt=cutoff).delete()
            total += n
        if total:
            logger.info("GC: hard-deleted %d tombstone row(s)", total)
    except Exception as exc:
        logger.error("GC: tombstone cleanup failed: %s", exc)
    return total


def sweep_audit_trail(now) -> int:
    """API audit rows, on their own longer clock (settings.API_AUDIT_RETENTION_DAYS):
    the trail has to outlive the data it describes to be worth anything."""
    deleted = 0
    try:
        from api.models import APIRequest
        cutoff = now - timedelta(days=settings.API_AUDIT_RETENTION_DAYS)
        deleted, _ = APIRequest.objects.filter(created_at__lt=cutoff).delete()
        if deleted:
            logger.info("GC: deleted %d expired API audit row(s)", deleted)
    except Exception as exc:
        logger.error("GC: API audit cleanup failed: %s", exc)
    return deleted


def sweep_orphan_exports(now) -> dict:
    """The one sweep that starts from the filesystem rather than a DB row, so the
    only one that can reclaim a file whose row is gone. Off by default (dry_run);
    see services/orphan_exports.py."""
    try:
        from services.orphan_exports import reconcile_orphan_exports
        return reconcile_orphan_exports(now=now)
    except Exception as exc:
        logger.error("GC: orphan export sweep failed: %s", exc)
        return {}


def sweep_chunk_staging(now) -> dict:
    """Abandoned `.chunks/<uuid>/` dirs. Unlike the orphan sweep this deletes by
    default: the part files are unusable without the `/complete` call that would
    have consumed them. See services/chunk_staging.py."""
    try:
        from services.chunk_staging import sweep_stale_chunk_staging
        return sweep_stale_chunk_staging(now=now)
    except Exception as exc:
        logger.error("GC: chunk staging sweep failed: %s", exc)
        return {}


def sweep_embed_sessions(now) -> int:
    """EmbedSession rows keep ~30 days of history after their 2-hour token expiry."""
    deleted = 0
    try:
        from api.models import EmbedSession
        deleted, _ = EmbedSession.objects.filter(expires_at__lt=now - timedelta(days=30)).delete()
        if deleted:
            logger.info("GC: deleted %d expired EmbedSession row(s)", deleted)
    except Exception as exc:
        logger.error("GC: failed to delete expired EmbedSession rows: %s", exc)
    return deleted


def trim_purge_ledger_entries() -> int:
    """Ledger entries matter only while a backup still holds the order (daily sets:
    7 days), so they are kept well past that."""
    try:
        from services.purge_ledger import trim
        return trim(int(os.getenv('PURGE_LEDGER_RETENTION_DAYS', '45')))
    except Exception as exc:
        logger.error("GC: purge ledger trim failed: %s", exc)
        return 0


def _rmdir_if_empty(dirs) -> None:
    for d in dirs:
        try:
            if d and os.path.isdir(d):
                os.rmdir(d)  # raises OSError unless the directory is empty
        except OSError:
            pass
