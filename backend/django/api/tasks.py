"""
Celery tasks for asynchronous image generation.
"""
import os
import time
import logging
from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.utils import timezone
from django.conf import settings

logger = logging.getLogger(__name__)

# Number of concurrent Celery workers — used for wait-time estimation.
# Must match the --concurrency value passed to the worker command.
WORKER_CONCURRENCY = int(os.getenv('CELERY_CONCURRENCY', '2'))


@shared_task(
    bind=True,
    max_retries=3,
    time_limit=600,    # 10 minutes hard kill
    soft_time_limit=570,  # 9.5 minutes — raises SoftTimeLimitExceeded cleanly
    acks_late=True,
)
def render_canvas_task(self, canvas_data_id: str, job_id: str):
    """
    Asynchronous canvas rendering task.

    Retry strategy: manual via self.retry() so the DB job record stays
    consistent with Celery's own retry counter. Does NOT use autoretry_for
    to avoid double-counting retries.

    Args:
        canvas_data_id: UUID of CanvasData record
        job_id:         UUID of RenderJob record
    """
    from api.models import CanvasData, RenderJob
    from layout_engine.engine import LayoutEngine
    from services.storage import get_storage
    try:
        import psutil
        process = psutil.Process()
        memory_mb = process.memory_info().rss / 1024 / 1024
        if memory_mb > 400:  # 80 % of 512 MB worker limit
            logger.warning(
                "Worker memory usage high at task start: %.1fMB (job_id=%s)",
                memory_mb, job_id,
            )
    except Exception:
        pass

    job = RenderJob.objects.get(id=job_id)
    job.status = 'processing'
    job.started_at = timezone.now()
    job.save(update_fields=['status', 'started_at'])

    logger.info("Starting render job %s for canvas %s", job_id, canvas_data_id)

    try:
        canvas = CanvasData.objects.get(id=canvas_data_id)
        storage = get_storage()
        engine = LayoutEngine(storage.layouts_dir(), settings.EXPORTS_DIR)

        start_time = time.time()

        try:
            if canvas.soft_proof:
                logger.info(
                    "Job %s: soft-proof rendering for layout '%s'",
                    job_id, canvas.layout_name,
                )
                outputs = engine.generate_soft_proof(
                    canvas.layout_name,
                    canvas.image_paths,
                    fit_mode=canvas.fit_mode,
                )
                output_paths = []
                for result in outputs:
                    output_paths.extend([
                        result['png'],
                        result['tiff_cmyk'],
                        result['cmyk_preview'],
                    ])
            else:
                logger.info(
                    "Job %s: standard rendering for layout '%s' format '%s'",
                    job_id, canvas.layout_name, canvas.export_format,
                )
                outputs = engine.generate(
                    canvas.layout_name,
                    canvas.image_paths,
                    fit_mode=canvas.fit_mode,
                    export_format=canvas.export_format,
                )
                output_paths = outputs

        except MemoryError:
            # MemoryError is unrecoverable — skip retries immediately.
            error_msg = (
                f"Render exceeded 512 MB memory limit. "
                f"Layout '{canvas.layout_name}' with {len(canvas.image_paths)} images "
                f"requires more memory than available."
            )
            logger.error("Job %s failed with MemoryError: %s", job_id, error_msg, exc_info=True)
            job.status = 'failed'
            job.completed_at = timezone.now()
            job.error_message = error_msg
            job.retry_count = self.max_retries  # prevent any further retry
            job.save(update_fields=['status', 'completed_at', 'error_message', 'retry_count'])
            return

        except SoftTimeLimitExceeded:
            error_msg = f"Render timed out after {settings.CELERY_TASK_SOFT_TIME_LIMIT or 570}s"
            logger.error("Job %s hit soft time limit", job_id)
            job.status = 'failed'
            job.completed_at = timezone.now()
            job.error_message = error_msg
            job.retry_count = self.max_retries  # timeouts are not worth retrying
            job.save(update_fields=['status', 'completed_at', 'error_message', 'retry_count'])
            return

        generation_time_ms = int((time.time() - start_time) * 1000)

        # Verify every output file was actually written to disk.
        for path in output_paths:
            if not os.path.exists(path):
                raise FileNotFoundError(f"Expected output file not found: {path}")

        logger.info("Job %s: all %d output files verified", job_id, len(output_paths))

        job.status = 'completed'
        job.completed_at = timezone.now()
        job.generation_time_ms = generation_time_ms
        job.output_paths = output_paths
        job.save(update_fields=['status', 'completed_at', 'generation_time_ms', 'output_paths'])

        # Dispatch OMS notification as a separate task so it never blocks this worker slot.
        push_to_production_estimator_task.apply_async(
            args=[str(canvas.id), output_paths],
            queue='standard',
            countdown=0,
        )

        logger.info(
            "Render job %s completed in %dms (order_id=%s, layout=%s)",
            job_id, generation_time_ms, canvas.order_id, canvas.layout_name,
        )

    except Exception as exc:
        # Determine whether we have retries left.
        retry_number = self.request.retries  # 0-based: 0 on first attempt
        exhausted = retry_number >= self.max_retries

        job.retry_count = retry_number + 1
        job.error_message = str(exc)

        if exhausted:
            job.status = 'failed'
            job.completed_at = timezone.now()
            logger.error(
                "Render job %s failed after %d retries (order_id=%s, layout=%s): %s",
                job_id, retry_number + 1,
                getattr(locals().get('canvas'), 'order_id', '?'),
                getattr(locals().get('canvas'), 'layout_name', '?'),
                exc,
                exc_info=True,
            )
            job.save(update_fields=['status', 'retry_count', 'error_message', 'completed_at'])
        else:
            job.status = 'queued'
            job.save(update_fields=['status', 'retry_count', 'error_message'])
            delay = (2 ** retry_number) * 2  # 2s, 4s, 8s
            logger.warning(
                "Render job %s retry %d/%d in %ds: %s",
                job_id, retry_number + 1, self.max_retries, delay, exc,
            )
            # self.retry raises Retry exception — must be last statement in branch.
            raise self.retry(exc=exc, countdown=delay)


@shared_task(
    bind=True,
    max_retries=5,
    acks_late=True,
)
def push_to_production_estimator_task(self, canvas_data_id: str, output_paths: list):
    """
    Notify Production_Estimator (OMS) that rendering is complete.

    Runs as a separate Celery task so it never blocks a render worker slot.
    Retries up to 5 times with exponential backoff via self.retry().
    On final failure the canvas is flagged for manual review.

    Args:
        canvas_data_id: UUID string of CanvasData record
        output_paths:   List of generated file paths
    """
    import requests
    from api.models import CanvasData

    canvas = CanvasData.objects.get(id=canvas_data_id)

    payload = {
        'order_id': canvas.order_id,
        'output_files': output_paths,
        'layout_name': canvas.layout_name,
        'export_format': canvas.export_format,
    }

    try:
        response = requests.post(
            settings.OMS_PRODUCTION_ESTIMATOR_URL,
            json=payload,
            timeout=10,
        )
        response.raise_for_status()
        logger.info(
            "Pushed order %s to Production_Estimator (attempt %d)",
            canvas.order_id, self.request.retries + 1,
        )

        # Fire the per-request callback URL if one was stored at submission time.
        if canvas.callback_url:
            try:
                cb_response = requests.post(
                    canvas.callback_url,
                    json={**payload, 'status': 'completed'},
                    timeout=10,
                )
                cb_response.raise_for_status()
                logger.info("Callback delivered to %s for order %s", canvas.callback_url, canvas.order_id)
            except Exception as cb_exc:
                # Callback failure is non-fatal — log and continue.
                logger.warning(
                    "Callback to %s failed for order %s: %s",
                    canvas.callback_url, canvas.order_id, cb_exc,
                )

    except Exception as exc:
        retry_number = self.request.retries
        exhausted = retry_number >= self.max_retries

        if exhausted:
            logger.error(
                "Failed to push order %s to Production_Estimator after %d attempts: %s",
                canvas.order_id, self.max_retries + 1, exc,
                exc_info=True,
            )
            canvas.requires_manual_review = True
            canvas.save(update_fields=['requires_manual_review'])
        else:
            delay = 2 ** retry_number  # 1s, 2s, 4s, 8s, 16s
            logger.warning(
                "Production_Estimator push attempt %d/%d failed for order %s: %s. Retry in %ds.",
                retry_number + 1, self.max_retries + 1, canvas.order_id, exc, delay,
            )
            raise self.retry(exc=exc, countdown=delay)


@shared_task
def garbage_collector_task():
    """
    Periodic task to clean up expired export files.

    Runs daily at 02:00 UTC. Reduces retention to 7 days when disk usage
    exceeds 80 %. Files belonging to orders flagged for manual review are
    skipped even if expired.

    Returns:
        dict with deleted_count, deleted_bytes, disk_usage_percent
    """
    import shutil
    from datetime import timedelta
    from api.models import ExportedResult, CanvasData

    now = timezone.now()
    retention_days = 14

    try:
        disk_usage = shutil.disk_usage(settings.EXPORTS_DIR)
        usage_percent = (disk_usage.used / disk_usage.total) * 100
    except Exception as exc:
        logger.error("Failed to check disk usage: %s", exc)
        usage_percent = 0

    if usage_percent > 80:
        logger.critical(
            "EXPORTS_DIR disk usage at %.1f%% — reducing retention to 7 days", usage_percent
        )
        retention_days = 7

    cutoff_date = now - timedelta(days=retention_days)

    # Collect file paths that belong to manual-review orders so we can skip them.
    # ExportedResult stores layout_name but not order_id; we cross-reference via
    # the output file path prefix (EXPORTS_DIR/<order_id>/...).
    manual_review_order_ids = set(
        CanvasData.objects.filter(
            requires_manual_review=True
        ).values_list('order_id', flat=True)
    )

    expired_exports = ExportedResult.objects.filter(
        created_at__lt=cutoff_date,
        is_deleted=False,
    )

    deleted_count = 0
    deleted_bytes = 0
    skipped_count = 0

    for export in expired_exports:
        # Skip files whose path contains a manual-review order_id segment.
        path_str = export.export_file_path or ''
        if any(oid in path_str for oid in manual_review_order_ids):
            skipped_count += 1
            logger.debug(
                "GC: skipping manual-review file %s", export.export_file_path
            )
            continue

        try:
            if os.path.exists(export.export_file_path):
                file_size = os.path.getsize(export.export_file_path)
                os.remove(export.export_file_path)
                deleted_bytes += file_size
                deleted_count += 1

            export.is_deleted = True
            export.save(update_fields=['is_deleted'])
            logger.info("GC: deleted expired file %s", export.export_file_path)
        except Exception as exc:
            logger.error("GC: failed to delete %s: %s", export.export_file_path, exc)

    logger.info(
        "GC complete: deleted=%d files (%.2f MB), skipped=%d manual-review, disk=%.1f%%",
        deleted_count, deleted_bytes / 1024 / 1024, skipped_count, usage_percent,
    )

    return {
        'deleted_count': deleted_count,
        'deleted_bytes': deleted_bytes,
        'skipped_count': skipped_count,
        'disk_usage_percent': usage_percent,
    }
