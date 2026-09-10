"""
Shared render submission service for GenerateLayoutView and EditorRenderView.

Consolidates CanvasData creation, RenderJob tracking, and Celery dispatch logic
that was previously duplicated across two endpoints.
"""
import logging
from typing import Optional
from datetime import timedelta
from django.utils import timezone
from django.db import transaction as db_transaction
from django.conf import settings
from api.models import CanvasData, RenderJob
from api.tasks import render_canvas_task

logger = logging.getLogger(__name__)


class RenderSubmissionError(Exception):
    """Raised when render submission fails."""
    pass


class RenderSubmissionService:
    """
    Unified render submission service.

    Handles:
      1. CanvasData upsert (idempotent, survives resubmit)
      2. RenderJob creation with queue selection
      3. Celery task dispatch via transaction.on_commit()
      4. Error recovery (marks job failed if dispatch fails)

    Two paths share this:
      - GenerateLayoutView (direct partner API): image files already uploaded
      - EditorRenderView (embed/dashboard): files pre-uploaded via chunked API

    Note: GenerateLayoutView must NOT support books (no canvases_meta to slice
    photos per page). EditorRenderView supports books via the canvases_meta
    contract. The service does not enforce this; it is the caller's gate.
    """

    def __init__(self, api_key, order_id: str):
        """
        Initialize submission service.

        Args:
            api_key: The APIKey object making the request
            order_id: Customer's job ID for identity + erasure
        """
        self.api_key = api_key
        self.order_id = order_id

    def submit(
        self,
        layout_name: str,
        image_paths: list,
        export_format: str = "png",
        fit_mode: str = "cover",
        render_state: Optional[dict] = None,
        callback_url: Optional[str] = None,
        queue_name: str = "standard",
    ) -> dict:
        """
        Submit a render job.

        Creates CanvasData + RenderJob atomically, then dispatches to Celery.
        If the same (order_id, api_key) pair is resubmitted, upserts in place
        (idempotent — supports operator retry and customer re-upload).

        Args:
            layout_name: Layout identifier (e.g. 'circle_48mm')
            image_paths: List of file paths (order matters for multi-canvas)
            export_format: 'png' or 'pdf'
            fit_mode: 'cover' or 'contain'
            render_state: Optional snapshot of render contract (frame transforms,
                         canvases metadata, include_uploads flag). When present,
                         takes precedence over editor_state at render time.
            callback_url: Optional webhook URL (embed sessions only)
            queue_name: Celery queue ('standard' or 'priority')

        Returns:
            dict with keys:
              - job_id (str UUID)
              - order_id (str, echoed)
              - status_url (str path to poll)
              - queue (str)
              - estimated_wait_seconds (int, optional)

        Raises:
            RenderSubmissionError: If submission fails
        """
        try:
            expires_at = timezone.now() + timedelta(days=settings.EXPORT_RETENTION_DAYS)

            with db_transaction.atomic():
                # Upsert CanvasData — if the same (order_id, api_key) is
                # resubmitted (operator retry, customer re-upload) we update
                # in place rather than violating unique_together.
                canvas_obj, created = CanvasData.objects.update_or_create(
                    order_id=self.order_id,
                    api_key=self.api_key,
                    defaults={
                        "layout_name": layout_name,
                        "image_paths": image_paths,
                        "fit_mode": fit_mode,
                        "export_format": export_format,
                        "render_state": render_state,
                        "callback_url": callback_url,
                        "expires_at": expires_at,
                    },
                )

                # Create RenderJob (always a new row — tracks each submission)
                job = RenderJob.objects.create(
                    canvas_data=canvas_obj,
                    status="queued",
                    queue_name=queue_name,
                )

                # Capture variables for on_commit lambda (avoid late-binding)
                _canvas_id = str(canvas_obj.id)
                _job_id = str(job.id)
                _queue = queue_name

                # Enqueue inside on_commit so DB row is guaranteed to exist
                # before the worker tries to read it.
                db_transaction.on_commit(
                    lambda: self._enqueue_task(_canvas_id, _job_id, _queue)
                )

            action = "created" if created else "resubmitted"
            logger.info(
                "Render job %s: order_id=%s, job_id=%s, layout=%s, queue=%s",
                action,
                self.order_id,
                job.id,
                layout_name,
                queue_name,
            )

            return {
                "job_id": str(job.id),
                "order_id": self.order_id,
                "status_url": f"/api/render-status/{job.id}/",
                "queue": queue_name,
                "estimated_wait_seconds": self._estimate_wait_time(queue_name),
            }

        except Exception as exc:
            logger.error(
                "Render submission failed for order_id=%s: %s",
                self.order_id,
                exc,
                exc_info=True,
            )
            raise RenderSubmissionError(str(exc)) from exc

    def _enqueue_task(self, canvas_id: str, job_id: str, queue_name: str):
        """
        Enqueue render task to Celery and update job with Celery task ID.

        Called inside transaction.on_commit(), so DB row is guaranteed to exist.
        On failure (Redis down, etc.) the job is immediately marked 'failed'
        so it doesn't silently stay in 'queued' forever.
        """
        try:
            task = render_canvas_task.apply_async(
                args=[canvas_id, job_id],
                queue=queue_name,
            )
            RenderJob.objects.filter(id=job_id).update(celery_task_id=task.id)
            logger.info(
                "Task enqueued: job_id=%s, celery_task_id=%s, queue=%s",
                job_id,
                task.id,
                queue_name,
            )
        except Exception as exc:
            logger.error(
                "Failed to enqueue task for job_id=%s (queue=%s): %s",
                job_id,
                queue_name,
                exc,
                exc_info=True,
            )
            # Mark job failed immediately so it doesn't stay stuck in 'queued'
            RenderJob.objects.filter(id=job_id).update(
                status="failed",
                error_message=f"Failed to dispatch task to Celery: {exc}",
                completed_at=timezone.now(),
            )

    def _estimate_wait_time(self, queue_name: str) -> int:
        """
        Estimate seconds until a newly-enqueued job will start processing.

        Takes worker concurrency into account: with N concurrent workers,
        effective wait is depth/concurrency * avg_render_time.
        """
        from api.tasks import WORKER_CONCURRENCY

        queued_count = RenderJob.objects.filter(
            queue_name=queue_name,
            status__in=("queued", "processing"),
        ).count()

        # Average render time varies by queue (priority was express, now unused)
        avg_time_per_job = 30 if queue_name == "priority" else 60
        # Divide by concurrency — jobs drain in parallel across workers.
        concurrency = max(1, WORKER_CONCURRENCY)
        return max(0, int((queued_count / concurrency) * avg_time_per_job))
