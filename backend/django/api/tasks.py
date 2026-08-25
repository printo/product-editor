"""
Celery tasks for asynchronous image generation.
"""
import os
import time
import logging
from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from celery.signals import task_failure
from django.db.models import Q
from django.utils import timezone
from django.conf import settings

logger = logging.getLogger(__name__)

# Number of concurrent Celery workers — used for wait-time estimation.
# Must match the --concurrency value passed to the worker command.
WORKER_CONCURRENCY = int(os.getenv('CELERY_CONCURRENCY', '2'))


def _extract_frame_transforms(editor_state: dict | None) -> list | None:
    """
    Flatten per-frame transforms from CanvasData.editor_state into a list
    ordered as [canvas0_frame0, canvas0_frame1, canvas1_frame0, ...].

    Returns None if editor_state is absent or has no canvases (engine then
    falls back to the global fit_mode with no per-frame adjustments).
    """
    if not editor_state:
        return None
    canvases = editor_state.get('canvases') or []
    if not canvases:
        return None
    transforms = []
    for canvas in canvases:
        for frame in canvas.get('frames') or []:
            transforms.append({
                'offset_x': float(frame.get('offset_x') or 0),
                'offset_y': float(frame.get('offset_y') or 0),
                'scale':    float(frame.get('scale') or 1),
                'rotation': float(frame.get('rotation') or 0),
                'fit_mode': frame.get('fit_mode') or None,
                # WYSIWYG extras — fill sides + caption (engine renders them into
                # the 300 DPI output). Absent on legacy payloads → None/False.
                'fill_style':      frame.get('fill_style') or None,
                'caption':         frame.get('caption') or None,
                'caption_enabled': bool(frame.get('caption_enabled')),
            })
    return transforms or None


def _extract_overlays_per_canvas(editor_state: dict | None) -> list | None:
    """
    Extract per-canvas overlay lists from CanvasData.editor_state for the
    server-side overlay renderer (Phase 1 of CALENDAR_FEATURE_PRD.md §5).

    Returns a list-of-lists indexed by canvas batch:
        [ [overlay, overlay, ...],   # canvas 0
          [overlay, ...],            # canvas 1
          ... ]

    Returns None when editor_state is absent or every canvas's overlays
    array is empty — letting the engine skip the overlay branch entirely
    (zero-cost for layouts without overlays).
    """
    if not editor_state:
        return None
    canvases = editor_state.get('canvases') or []
    if not canvases:
        return None
    out = [list(canvas.get('overlays') or []) for canvas in canvases]
    # All-empty short-circuit so the engine takes the fast path.
    if not any(out):
        return None
    return out


def _extract_backgrounds_per_canvas(editor_state: dict | None) -> list | None:
    """
    Extract per-canvas background + paper colours from CanvasData.editor_state
    for the server-side renderer (Phase 2 WYSIWYG). Returns a list aligned with
    the canvas order used by _extract_frame_transforms / _extract_overlays:

        [ {'bg': '#rrggbb'|None, 'paper': '#rrggbb'|None},  # canvas 0
          ... ]

    Returns None when editor_state is absent or no canvas set a colour — the
    engine then falls back to a plain white background (byte-identical to the
    previous behaviour).
    """
    if not editor_state:
        return None
    canvases = editor_state.get('canvases') or []
    if not canvases:
        return None
    out = []
    any_set = False
    for cv in canvases:
        bg = cv.get('bg_color') if isinstance(cv, dict) else None
        paper = cv.get('paper_color') if isinstance(cv, dict) else None
        if bg or paper:
            any_set = True
        out.append({'bg': bg, 'paper': paper})
    return out if any_set else None


def _extract_calendar_state(editor_state: dict | None):
    """
    Pull the customer's calendar-product choices out of editor_state for
    a productType='calendar' render (PRD Phase 4 Bug B fix).

    The customer's preview-page choices (theme preset, calendar type,
    Gen-Z palette) are product-wide — every canvas saves the same value.
    Per-cell entries are per-canvas (each month's cells are separate).

    Returns a dict shaped:
        {
            'theme_preset':     'modern-minimalist' | 'modern-genz' | 'weekday-highlight' | None,
            'calendar_type':    'english' | 'financial' | None,
            'palette':          '<palette name>' | None,   # only relevant for Gen-Z
            'cells':            { iso_date: [override, ...] }
                                # ONE flat product-wide map — entries key by
                                # globally-unique ISO date, so per-canvas
                                # association was never needed (Phase 2 item 6)
            'num_canvases':     int  # payload canvas count, for the engine's
                                     # per-month photo slicing
        }

    Both payload generations merge into the flat map: the current frontend
    sends the same product-wide cells map on every canvas (idempotent), and
    legacy per-index payloads union by their unique ISO keys.

    Returns None when editor_state is absent or contains no calendar
    blocks — the engine then renders with layout-level defaults only.
    """
    if not editor_state:
        return None
    canvases = editor_state.get('canvases') or []
    if not canvases:
        return None

    cells: dict = {}
    any_calendar_state = False
    for cv in canvases:
        cal = cv.get('calendar') if isinstance(cv, dict) else None
        if isinstance(cal, dict):
            any_calendar_state = True
            for iso, entries in (cal.get('cells') or {}).items():
                # Defensive: re-enforce the 3-entries-per-cell cap after the
                # merge (legacy corrupt states could hold dupes across slots).
                cells[iso] = list(entries or [])[:3]

    if not any_calendar_state:
        return None

    # Read product-wide fields from the first canvas that has them set.
    # Phase 5 UI will keep all canvases in sync; this just survives early
    # partial-saves where only canvas 0 has the choice recorded.
    theme_preset = None
    calendar_type = None
    palette = None
    for cv in canvases:
        cal = cv.get('calendar') if isinstance(cv, dict) else None
        if not isinstance(cal, dict):
            continue
        theme_preset = theme_preset or cal.get('themePreset')
        calendar_type = calendar_type or cal.get('calendarType')
        palette = palette or cal.get('genzPalette')
        if theme_preset and calendar_type and palette:
            break

    return {
        'theme_preset': theme_preset,
        'calendar_type': calendar_type,
        'palette': palette,
        'cells': cells,
        'num_canvases': len(canvases),
    }


def _extract_canvases_meta(editor_state: dict | None) -> list | None:
    """
    Per-payload-canvas metadata for the engine's per-surface grouping
    (Phase 3): [{'surface_key': str|None, 'frame_count': int}, ...] in canvas
    order. Returns None when the payload carries no canvases — the engine
    then keeps its legacy whole-list behaviour.
    """
    if not editor_state:
        return None
    canvases = editor_state.get('canvases') or []
    if not canvases:
        return None
    return [
        {
            'surface_key': cv.get('surface_key') if isinstance(cv, dict) else None,
            'frame_count': len(cv.get('frames') or []) if isinstance(cv, dict) else 0,
        }
        for cv in canvases
    ]


def _extract_book_state(editor_state: dict | None):
    """
    Pull the customer's page-count choice + ops per-page overrides out of
    editor_state for a productType='book' render (BOOK_LAYOUT_PRD.md §5.4).

    Page count is CUSTOMER state (D2) — the frontend echoes the count it
    materialized the editor with on every canvas, product-wide like the
    calendar's theme/type/palette. Returns None when editor_state carries
    no book block, matching `_extract_calendar_state`'s contract; the
    engine then falls back to the template default page count.

    Returns a dict shaped:
        {
            'page_count':     int | None,
            'page_overrides': { '<page index>': {...} } | None,
        }
    """
    if not editor_state:
        return None
    canvases = editor_state.get('canvases') or []
    if not canvases:
        return None

    page_count = None
    page_overrides = None
    any_book_state = False
    for cv in canvases:
        book = cv.get('book') if isinstance(cv, dict) else None
        if not isinstance(book, dict):
            continue
        any_book_state = True
        if page_count is None and book.get('pageCount') is not None:
            page_count = book.get('pageCount')
        if page_overrides is None and isinstance(book.get('pageOverrides'), dict):
            page_overrides = book.get('pageOverrides')

    if not any_book_state:
        return None

    return {'page_count': page_count, 'page_overrides': page_overrides}


def _free_space_mb(path: str) -> float:
    """Free disk space at `path` in MB (used by the disk-full pre-flight)."""
    import shutil
    try:
        return shutil.disk_usage(path).free / (1024 * 1024)
    except OSError:
        return float('inf')  # can't stat — don't block the render on it


def _resolve_render_inputs(canvas_data) -> tuple:
    """
    Pick the render contract source and image paths for a render job.

    The contract comes from the submit-time snapshot (render_state); falling
    back to editor_state keeps jobs enqueued before the 0008 deploy (whose
    payload lived in editor_state in the old shape) rendering correctly,
    including acks_late redeliveries.

    image_paths come from the snapshot, not the row: a post-submit autosave
    (CanvasStateView) resets CanvasData.image_paths to [] — the snapshot is
    immutable for the lifetime of the queued job.

    Returns (render_source, image_paths).
    """
    render_source = canvas_data.render_state or canvas_data.editor_state
    image_paths = (canvas_data.render_state or {}).get('image_paths') or canvas_data.image_paths
    return render_source, image_paths


def _build_uploaded_files_map(canvas_data, overlays_per_canvas) -> dict | None:
    """
    Build { upload_id → server file path } for image overlays referenced
    by this canvas's overlays list. Used by the server-side overlay
    renderer to resolve image overlays that point at local customer
    uploads (PRD §11 — Phase 1 of the calendar feature roadmap).

    Strategy:
      1. Walk every overlay across every canvas, collect each `fileId`
         (which is the upload_session_id assigned by the chunked-upload
         API when the customer uploaded the image).
      2. Query UploadedFile filtered by `api_key` (tenant boundary) and
         the collected upload_session_ids.
      3. Return a flat { upload_session_id → file_path } map.

    Returns None when no image overlays reference uploads (engine then
    skips the lookup entirely).
    """
    if not overlays_per_canvas:
        return None

    upload_ids: set[str] = set()
    for canvas_overlays in overlays_per_canvas:
        for o in canvas_overlays or []:
            if o.get('type') != 'image':
                continue
            fid = o.get('fileId')
            if fid:
                upload_ids.add(str(fid))

    if not upload_ids:
        return None

    from api.models import UploadedFile

    rows = UploadedFile.objects.filter(
        api_key=canvas_data.api_key,
        upload_session_id__in=upload_ids,
        is_deleted=False,
    ).values_list('upload_session_id', 'file_path')
    mapping = {str(uid): path for uid, path in rows if uid and path}
    return mapping or None


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

    # ── Poison-pill guard (Phase 4) ───────────────────────────────────────────
    # acks_late=True + task_reject_on_worker_lost means a payload that CRASHES
    # the worker process (C-level Pillow abort, SIGKILL/OOM — past the
    # Python-level Image.MAX_IMAGE_PIXELS guard) is redelivered forever, killing
    # workers in a loop. Count deliveries per job; after 3, fail the job and
    # ACK (return) so the poison pill drains. Rides the fail-open cache — if the
    # cache is down the guard is skipped and old behaviour returns.
    # Count ONLY genuine broker redeliveries (crash / worker-lost), NOT the
    # task's own self.retry() re-executions. A self.retry() publishes a fresh
    # message (redelivered=False, retries bumped); a worker crash under
    # acks_late redelivers the SAME message (redelivered=True, retries frozen).
    # Counting every execution would steal a transiently-failing job's final
    # legitimate retry and mislabel it as a crash.
    _MAX_DELIVERIES = 3
    _redelivered = bool(
        getattr(self.request, 'delivery_info', None)
        and self.request.delivery_info.get('redelivered')
    )
    if _redelivered:
        logger.warning("Render job %s was redelivered (possible crash-loop)", job_id)
    try:
        if _redelivered:
            from django.core.cache import cache
            dkey = f'render_deliveries:{job_id}'
            cache.add(dkey, 0, 7200)
            crash_deliveries = cache.incr(dkey)
        else:
            crash_deliveries = 0
        if crash_deliveries > _MAX_DELIVERIES:
            logger.error(
                "Render job %s aborted: %d crash-redeliveries — payload keeps crashing the worker",
                job_id, crash_deliveries,
            )
            job.status = 'failed'
            job.error_message = (
                'Render aborted: the design repeatedly crashed the renderer '
                '(possible corrupt or oversized image). Please re-check the photos.'
            )
            job.completed_at = timezone.now()
            job.retry_count = self.max_retries
            job.save(update_fields=['status', 'error_message', 'completed_at', 'retry_count'])
            try:
                canvas_cb = CanvasData.objects.filter(id=canvas_data_id).first()
                if canvas_cb and canvas_cb.callback_url:
                    notify_caller_render_failed_task.apply_async(
                        args=[canvas_data_id, job.error_message],
                        queue=job.queue_name or 'standard',
                    )
            except Exception:
                pass
            return  # ACK under acks_late — drains the poison pill
    except Exception:
        pass  # cache unavailable — guard disabled, proceed

    # ── Disk-full pre-flight (Phase 4) ────────────────────────────────────────
    # A render into a full EXPORTS_DIR writes a partial PNG then crashes; with
    # retries that's a wasted 8 s loop against a disk that won't clear. Fail
    # fast with a clear message instead.
    if _free_space_mb(settings.EXPORTS_DIR) < 500:
        logger.error("Render job %s aborted: EXPORTS_DIR free space < 500 MB", job_id)
        job.status = 'failed'
        job.error_message = 'Server storage is full — render aborted before writing any files.'
        job.completed_at = timezone.now()
        job.retry_count = self.max_retries
        job.save(update_fields=['status', 'error_message', 'completed_at', 'retry_count'])
        try:
            canvas_cb = CanvasData.objects.filter(id=canvas_data_id).first()
            if canvas_cb and canvas_cb.callback_url:
                notify_caller_render_failed_task.apply_async(
                    args=[canvas_data_id, job.error_message],
                    queue=job.queue_name or 'standard',
                )
        except Exception:
            pass
        return

    job.status = 'processing'
    job.started_at = timezone.now()
    job.save(update_fields=['status', 'started_at'])

    logger.info("Starting render job %s for canvas %s", job_id, canvas_data_id)

    # Initialise job_exports_dir to None so the except handler below can
    # safely reference it even when the try block fails before line 226.
    # (CanvasData.objects.get / get_storage can raise before the variable
    # is assigned, which would cause a NameError in the cleanup logic.)
    job_exports_dir = None

    try:
        canvas = CanvasData.objects.get(id=canvas_data_id)
        storage = get_storage()

        # Give each async job its own exports subdirectory so concurrent jobs
        # for the same layout name never overwrite each other's output files.
        job_exports_dir = os.path.join(settings.EXPORTS_DIR, job_id)
        os.makedirs(job_exports_dir, exist_ok=True)

        engine = LayoutEngine(storage.layouts_dir(), job_exports_dir)

        start_time = time.time()

        render_source, image_paths = _resolve_render_inputs(canvas)

        # Extract per-frame transforms saved by EditorRenderView so the engine
        # can reproduce the exact pan / zoom / rotation the user set in the editor.
        frame_transforms = _extract_frame_transforms(render_source)

        # Phase 1 (CALENDAR_FEATURE_PRD.md §5) — extract overlays + the upload
        # map so text/shape/image overlays render server-side. Layouts without
        # overlays return None here and the engine fast-paths past the new code.
        overlays_per_canvas = _extract_overlays_per_canvas(render_source)
        uploaded_files = _build_uploaded_files_map(canvas, overlays_per_canvas)

        # Phase 2 (WYSIWYG) — per-canvas background + paper colours so the print
        # matches the colours the customer chose (previously hardcoded white).
        backgrounds_per_canvas = _extract_backgrounds_per_canvas(render_source)

        # Phase 4 (Bug B fix) — extract customer-side calendar state. Returns
        # None for non-calendar products; engine then uses the layout's ops
        # defaults. For calendar products the customer's themePreset /
        # calendarType / palette choices override the layout defaults at
        # materialize time; per-canvas cells override at render time.
        calendar_state = _extract_calendar_state(render_source)

        # BOOK_LAYOUT_PRD.md §5.4 — extract the customer's page count + any
        # ops per-page overrides. None for non-book products; engine then
        # falls back to the template default page count.
        book_state = _extract_book_state(render_source)

        # Phase 3 — per-surface grouping metadata so multi-surface products
        # render each surface with ITS OWN photos (previously every surface
        # rendered the whole flattened list).
        canvases_meta = _extract_canvases_meta(render_source)

        try:
            logger.info(
                "Job %s: rendering layout '%s' format '%s' (overlays: %s, calendar_state: %s)",
                job_id, canvas.layout_name, canvas.export_format,
                sum(len(c or []) for c in (overlays_per_canvas or [])),
                bool(calendar_state),
            )
            outputs = engine.generate(
                canvas.layout_name,
                image_paths,
                fit_mode=canvas.fit_mode,
                export_format=canvas.export_format,
                frame_transforms=frame_transforms,
                overlays_per_canvas=overlays_per_canvas,
                uploaded_files=uploaded_files,
                calendar_state=calendar_state,
                backgrounds_per_canvas=backgrounds_per_canvas,
                canvases_meta=canvases_meta,
                book_state=book_state,
            )
            output_paths = outputs

        except MemoryError:
            # MemoryError is unrecoverable — skip retries immediately.
            error_msg = (
                f"Render exceeded 512 MB memory limit. "
                f"Layout '{canvas.layout_name}' with {len(image_paths)} images "
                f"requires more memory than available."
            )
            logger.error("Job %s failed with MemoryError: %s", job_id, error_msg, exc_info=True)
            job.status = 'failed'
            job.completed_at = timezone.now()
            job.error_message = error_msg
            job.retry_count = self.max_retries  # prevent any further retry
            job.save(update_fields=['status', 'completed_at', 'error_message', 'retry_count'])
            # Tell the embed caller the render failed so their order flow does
            # not stall forever waiting on a success webhook that never comes.
            if canvas.callback_url:
                notify_caller_render_failed_task.apply_async(
                    args=[str(canvas.id), error_msg], queue='standard', countdown=0,
                )
            return

        except SoftTimeLimitExceeded:
            error_msg = f"Render timed out after {settings.CELERY_TASK_SOFT_TIME_LIMIT or 570}s"
            logger.error("Job %s hit soft time limit", job_id)
            job.status = 'failed'
            job.completed_at = timezone.now()
            job.error_message = error_msg
            job.retry_count = self.max_retries  # timeouts are not worth retrying
            job.save(update_fields=['status', 'completed_at', 'error_message', 'retry_count'])
            if canvas.callback_url:
                notify_caller_render_failed_task.apply_async(
                    args=[str(canvas.id), error_msg], queue='standard', countdown=0,
                )
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

        # ── Register outputs for garbage collection ──────────────────────────
        # garbage_collector_task's primary sweep iterates ExportedResult rows.
        # Only GenerateLayoutView's synchronous path ever wrote them, and that
        # path is unreachable — so the table stayed empty and the sweep deleted
        # nothing, ever. Render outputs accumulated indefinitely (17 GB / 380
        # directories in production before this was found).
        #
        # Writing a row per output file here is what makes the existing GC work
        # as designed. expires_at is copied from the CanvasData so the retention
        # promised to the caller and the retention enforced here are the same
        # value (settings.EXPORT_RETENTION_DAYS).
        #
        # Wrapped in its own try: this is bookkeeping, and a failure to record
        # must never fail a render whose files are already on disk and whose
        # RenderJob is already marked completed.
        try:
            from api.models import ExportedResult

            rows = []
            for path in output_paths:
                try:
                    size = os.path.getsize(path)
                except OSError:
                    size = 0
                rows.append(ExportedResult(
                    api_key=canvas.api_key,
                    layout_name=canvas.layout_name,
                    export_file_path=path,
                    input_files=image_paths or [],
                    generation_time_ms=generation_time_ms,
                    file_size_bytes=size,
                    expires_at=canvas.expires_at,
                ))
            if rows:
                ExportedResult.objects.bulk_create(rows, batch_size=200)
                logger.info(
                    "Job %s: registered %d ExportedResult row(s) for GC", job_id, len(rows)
                )
        except Exception as exc:
            logger.error(
                "Job %s: failed to register ExportedResult rows (files will not be "
                "GC'd by the primary sweep): %s", job_id, exc
            )

        # Success — drop the poison-pill delivery counter (Phase 4).
        try:
            from django.core.cache import cache
            cache.delete(f'render_deliveries:{job_id}')
        except Exception:
            pass

        # Notify the caller's webhook (embed flow only — direct/dashboard
        # callers poll /api/render-status/<job_id>/ instead). Skipping the
        # task entirely when no callback_url avoids a no-op worker slot.
        if canvas.callback_url:
            notify_caller_webhook_task.apply_async(
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

        # PRD §11.5 — fail-all-or-nothing cleanup: remove any partial output
        # files written by this attempt before retrying or giving up, so a
        # retry starts from a clean slate and the customer never downloads a
        # partial ZIP. engine.py's internal _cleanup_partial_outputs() handles
        # within-generate() failures; this covers the case where generate()
        # raises all the way out to the task level.
        import shutil as _shutil
        try:
            if job_exports_dir and os.path.isdir(job_exports_dir):
                _shutil.rmtree(job_exports_dir, ignore_errors=True)
                logger.info("Cleaned up partial outputs at %s after task failure", job_exports_dir)
        except Exception as cleanup_exc:
            logger.warning("Could not clean partial outputs at %s: %s", job_exports_dir, cleanup_exc)

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
            # Notify the embed caller of the terminal failure (defensive
            # locals() lookup: canvas may be undefined if the failure happened
            # before it was fetched).
            _canvas = locals().get('canvas')
            if _canvas is not None and getattr(_canvas, 'callback_url', None):
                notify_caller_render_failed_task.apply_async(
                    args=[str(_canvas.id), str(exc)], queue='standard', countdown=0,
                )
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
    max_retries=8,   # ~3 min total window (see capped backoff below) so a brief
                     # callback outage doesn't permanently lose delivery.
    acks_late=True,
)
def notify_caller_webhook_task(self, canvas_data_id: str, output_paths: list):
    """
    Notify the embed caller (e.g. printo.in storefront) that rendering has
    completed, by POSTing a signed payload to ``canvas.callback_url``.

    This app is a standalone print-file generator — it does not push files
    anywhere itself. Files are delivered in two ways:
      1. Direct download via ``GET /api/jobs/<job_id>/download/`` (dashboard
         callers poll ``/api/render-status/<job_id>/`` then fetch the ZIP).
      2. Embed callers (those who set ``EmbedSession.callback_url``) get the
         signed webhook below; their backend then pulls the same download URL.

    Runs as a separate Celery task so it never blocks a render worker slot.
    The dispatch in ``render_canvas_task`` is gated on ``canvas.callback_url``
    being set — direct callers don't enqueue this at all.

    Retries up to 5 times with exponential backoff. On final failure the canvas
    is flagged for manual review and a ``status=failed`` payload is sent
    best-effort to the caller (so their order flow can react).

    Args:
        canvas_data_id: UUID string of CanvasData record
        output_paths:   List of generated file paths (server-side absolute paths)

    Webhook payload (success):
        {
          "order_id":      "<caller's id>",
          "job_id":        "<RenderJob uuid>",
          "status":        "completed",
          "download_url":         ".../api/jobs/<uuid>/download/",
          "print_download_url":   ".../api/jobs/<uuid>/download/?content=print",
          "mock_download_url":    ".../api/jobs/<uuid>/download/?content=mock",
          "uploads_download_url": ".../api/jobs/<uuid>/download/?content=uploads",
          "expires_at":    "<ISO 8601 timestamp>",
          "file_count":    <int>,
          "layout_name":   "<name>",
          "export_format": "png" | "pdf"
        }
        ``download_url`` is the combined three-folder archive and is kept for
        callers that already read it. The three ``*_download_url`` fields are
        the same job packaged one part per archive, for callers (printo.in)
        that store mock and print artefacts in separate fields.
        ``uploads_download_url`` is null when the session opted out of
        shipping the customer's originals (EmbedSession.include_uploads).
        All four need the caller's api_key as ``Authorization: Bearer``.
    Signed with HMAC-SHA256(api_key.key, raw_body) sent in ``X-Signature`` header
    so the caller can verify the request came from us.
    """
    import hmac
    import hashlib
    import json as _json
    from datetime import timedelta
    import requests
    from api.models import CanvasData, RenderJob

    canvas = CanvasData.objects.select_related('api_key').get(id=canvas_data_id)

    # Defensive: if callback_url got cleared between dispatch and execution
    # (rare but possible), exit cleanly without retrying.
    if not canvas.callback_url:
        logger.info(
            "Skipping webhook for order %s — callback_url empty",
            canvas.order_id,
        )
        return

    # Resolve the most recent completed RenderJob so the caller can fetch its
    # ZIP via the download URL.
    rjob = (RenderJob.objects
            .filter(canvas_data=canvas, status='completed')
            .order_by('-completed_at')
            .first())
    job_id = str(rjob.id) if rjob else None

    # Where will the ZIP live? Prefer PUBLIC_HOST + https. Without it the
    # caller can't reach us anyway.
    public_host = (
        getattr(settings, 'PUBLIC_HOST', None)
        or os.getenv('PUBLIC_HOST', '')
    )
    if public_host and not public_host.startswith('http'):
        base = f'https://{public_host}'
    else:
        base = public_host or ''
    # Honour the caller's session-time include_uploads choice (snapshotted in
    # render_state). Baked into the URL so their fetch gets the intended ZIP —
    # defaults to include for pre-existing jobs with no flag recorded.
    include_uploads = bool((canvas.render_state or {}).get('include_uploads', True))

    def _download_url(query: str) -> str | None:
        return f'{base}/api/jobs/{job_id}/download/?{query}' if (base and job_id) else None

    download_url = _download_url(
        f'include_uploads={"1" if include_uploads else "0"}'
    )
    # One archive per part, for callers that store mock and print separately.
    # The combined download_url above is unchanged so nothing that reads it
    # has to move.
    print_download_url = _download_url('content=print')
    mock_download_url = _download_url('content=mock')
    # Null rather than a URL that would 404: the session opted out of shipping
    # the customer's originals, so there is nothing behind it.
    uploads_download_url = _download_url('content=uploads') if include_uploads else None

    # What we tell the caller here MUST match what garbage_collector_task
    # actually enforces — both derive from settings.EXPORT_RETENTION_DAYS.
    # The fallback is only for rows written before expires_at was populated.
    #
    # Caveat worth knowing: the GC drops to EXPORT_RETENTION_DAYS_UNDER_PRESSURE
    # when EXPORTS_DIR passes 80% full, so under disk pressure files can go
    # earlier than this date. Callers should fetch promptly rather than treat
    # expires_at as a guarantee.
    expires_at = (
        canvas.expires_at.isoformat()
        if canvas.expires_at
        else (
            canvas.created_at + timedelta(days=settings.EXPORT_RETENTION_DAYS)
        ).isoformat()
    )

    webhook_payload = {
        'order_id':      canvas.order_id,
        'job_id':        job_id,
        'status':        'completed',
        'download_url':  download_url,
        'print_download_url':   print_download_url,
        'mock_download_url':    mock_download_url,
        'uploads_download_url': uploads_download_url,
        'expires_at':    expires_at,
        'file_count':    len(output_paths or []),
        'layout_name':   canvas.layout_name,
        'export_format': canvas.export_format,
    }
    # Sign the raw bytes so the caller can verify byte-for-byte. The shared
    # secret is api_key.key — the same key the caller used to create the
    # EmbedSession, so they already have it.
    raw_body = _json.dumps(webhook_payload, separators=(',', ':')).encode('utf-8')
    signature = hmac.new(
        canvas.api_key.key.encode('utf-8'),
        raw_body,
        hashlib.sha256,
    ).hexdigest()

    from services.url_safety import post_webhook_safely
    from django.core.exceptions import ValidationError as _URLValidationError
    try:
        # SSRF re-validation at SEND time (DNS-rebinding defence) + IP pinning
        # + no redirect-following. A URL that passed at session-create can
        # still rebind to an internal target before this POST fires.
        response = post_webhook_safely(
            canvas.callback_url,
            data=raw_body,
            headers={
                'Content-Type': 'application/json',
                'X-Signature': f'sha256={signature}',
            },
            timeout=10,
        )
        response.raise_for_status()
        logger.info(
            "Callback delivered to %s for order %s (job=%s, attempt %d)",
            canvas.callback_url, canvas.order_id, job_id,
            self.request.retries + 1,
        )
    except _URLValidationError as exc:
        # The target is not publicly routable — do NOT retry (it won't become
        # valid) and flag for manual review instead of hammering it.
        logger.error(
            "Webhook to %s BLOCKED for order %s (SSRF guard): %s",
            canvas.callback_url, canvas.order_id, exc,
        )
        canvas.requires_manual_review = True
        canvas.save(update_fields=['requires_manual_review'])
        return
    except Exception as exc:
        retry_number = self.request.retries
        exhausted = retry_number >= self.max_retries

        if exhausted:
            logger.error(
                "Webhook to %s failed for order %s after %d attempts: %s",
                canvas.callback_url, canvas.order_id, self.max_retries + 1, exc,
                exc_info=True,
            )
            canvas.requires_manual_review = True
            canvas.save(update_fields=['requires_manual_review'])

            # Best-effort failure notice — separate request so the success
            # signature isn't reused with mismatched payload.
            try:
                fail_payload = {
                    'order_id':    canvas.order_id,
                    'job_id':      job_id,
                    'status':      'failed',
                    'error':       'Webhook delivery failed after retries',
                    'layout_name': canvas.layout_name,
                }
                fail_body = _json.dumps(fail_payload, separators=(',', ':')).encode('utf-8')
                fail_sig = hmac.new(
                    canvas.api_key.key.encode('utf-8'),
                    fail_body, hashlib.sha256,
                ).hexdigest()
                post_webhook_safely(
                    canvas.callback_url,
                    data=fail_body,
                    headers={
                        'Content-Type': 'application/json',
                        'X-Signature': f'sha256={fail_sig}',
                    },
                    timeout=10,
                )
            except Exception:
                pass  # Manual review flag will catch it.
        else:
            delay = min(2 ** retry_number, 60)  # 1,2,4,8,16,32,60,60 → ~3 min total
            logger.warning(
                "Webhook attempt %d/%d failed for order %s: %s. Retry in %ds.",
                retry_number + 1, self.max_retries + 1, canvas.order_id, exc, delay,
            )
            raise self.retry(exc=exc, countdown=delay)


@shared_task(
    bind=True,
    max_retries=8,   # ~3 min total window (capped backoff below).
    acks_late=True,
)
def notify_caller_render_failed_task(self, canvas_data_id: str, error_message: str = ''):
    """
    Notify the embed caller that a RENDER failed, so their order flow does not
    stall forever waiting on the success webhook (which never fires on a failed
    render). Mirrors ``notify_caller_webhook_task`` but sends ``status='failed'``
    with no ``download_url``. Dispatched from ``render_canvas_task``'s terminal
    failure paths, gated on ``canvas.callback_url``.

    Signed the same way as the success webhook — HMAC-SHA256(api_key, raw_body)
    in the ``X-Signature`` header — so the caller verifies it identically.
    """
    import hmac
    import hashlib
    import json as _json
    import requests
    from api.models import CanvasData, RenderJob

    canvas = CanvasData.objects.select_related('api_key').get(id=canvas_data_id)
    if not canvas.callback_url:
        logger.info("Skipping failure webhook for order %s — callback_url empty", canvas.order_id)
        return

    rjob = RenderJob.objects.filter(canvas_data=canvas).order_by('-created_at').first()
    job_id = str(rjob.id) if rjob else None

    fail_payload = {
        'order_id':      canvas.order_id,
        'job_id':        job_id,
        'status':        'failed',
        'error':         (error_message or 'Render failed')[:500],
        'layout_name':   canvas.layout_name,
        'export_format': canvas.export_format,
    }
    raw_body = _json.dumps(fail_payload, separators=(',', ':')).encode('utf-8')
    signature = hmac.new(
        canvas.api_key.key.encode('utf-8'), raw_body, hashlib.sha256,
    ).hexdigest()

    from services.url_safety import post_webhook_safely
    from django.core.exceptions import ValidationError as _URLValidationError
    try:
        response = post_webhook_safely(  # SSRF-guarded (see notify_caller_webhook_task)
            canvas.callback_url,
            data=raw_body,
            headers={'Content-Type': 'application/json', 'X-Signature': f'sha256={signature}'},
            timeout=10,
        )
        response.raise_for_status()
        logger.info(
            "Failure webhook delivered to %s for order %s (job=%s, attempt %d)",
            canvas.callback_url, canvas.order_id, job_id, self.request.retries + 1,
        )
    except _URLValidationError as exc:
        logger.error(
            "Failure webhook to %s BLOCKED for order %s (SSRF guard): %s",
            canvas.callback_url, canvas.order_id, exc,
        )
        canvas.requires_manual_review = True
        canvas.save(update_fields=['requires_manual_review'])
        return
    except Exception as exc:
        retry_number = self.request.retries
        if retry_number >= self.max_retries:
            logger.error(
                "Failure webhook to %s exhausted for order %s after %d attempts: %s",
                canvas.callback_url, canvas.order_id, self.max_retries + 1, exc,
                exc_info=True,
            )
            canvas.requires_manual_review = True
            canvas.save(update_fields=['requires_manual_review'])
            return
        delay = min(2 ** retry_number, 60)  # 1,2,4,8,16,32,60,60 → ~3 min total
        logger.warning(
            "Failure webhook attempt %d/%d failed for order %s: %s. Retry in %ds.",
            retry_number + 1, self.max_retries + 1, canvas.order_id, exc, delay,
        )
        raise self.retry(exc=exc, countdown=delay)


@shared_task(
    soft_time_limit=3300,  # 55 min — give the task room to do its work
    time_limit=3600,       # 60 min — hard kill so a hung GC never blocks a worker slot
)
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
    from api.models import ExportedResult, CanvasData, RenderJob, UploadedFile

    now = timezone.now()
    # Same constant that sets CanvasData.expires_at and the expires_at we send
    # in the completion webhook — see settings.EXPORT_RETENTION_DAYS. Keep them
    # reading one value; when these drifted, callers were promised 30 days for
    # files the GC removed at 14.
    retention_days = settings.EXPORT_RETENTION_DAYS

    try:
        disk_usage = shutil.disk_usage(settings.EXPORTS_DIR)
        usage_percent = (disk_usage.used / disk_usage.total) * 100
    except Exception as exc:
        logger.error("Failed to check disk usage: %s", exc)
        usage_percent = 0

    if usage_percent > 80:
        retention_days = settings.EXPORT_RETENTION_DAYS_UNDER_PRESSURE
        logger.critical(
            "EXPORTS_DIR disk usage at %.1f%% — reducing retention to %d days",
            usage_percent, retention_days,
        )

    cutoff_date = now - timedelta(days=retention_days)

    # Collect file paths that belong to manual-review orders so we can skip them.
    # ExportedResult stores layout_name but not order_id; we cross-reference via
    # the output file path prefix (EXPORTS_DIR/<order_id>/...).
    manual_review_order_ids = set(
        CanvasData.objects.filter(
            requires_manual_review=True
        ).values_list('order_id', flat=True)
    )

    # Sweep on the expiry STAMPED ON THE ROW, not on `created_at + retention`
    # recomputed now. The old form was retroactive: shortening
    # EXPORT_RETENTION_DAYS deleted files whose expiry we had already promised a
    # partner in the completion webhook, and the download endpoint then served a
    # ZIP silently missing those files. CanvasData and the async render outputs
    # were already swept on a stored expires_at; these two now match.
    #
    # Rows written before expires_at was populated carry NULL and keep the old
    # age-based behaviour, so nothing already on disk changes semantics.
    #
    # Under genuine disk pressure the valve still wins: setting
    # EXPORT_RETENTION_DAYS_UNDER_PRESSURE below the normal window is an
    # explicit decision to break the promise to reclaim space (see settings.py),
    # so in that case we fall back to pure age.
    under_pressure = retention_days < settings.EXPORT_RETENTION_DAYS

    def _expiry_filter(now_ts, cutoff):
        if under_pressure:
            return Q(created_at__lt=cutoff)
        return Q(expires_at__lt=now_ts) | Q(expires_at__isnull=True, created_at__lt=cutoff)

    expired_exports = ExportedResult.objects.filter(
        _expiry_filter(now, cutoff_date),
        is_deleted=False,
    ).only('id', 'export_file_path')

    deleted_count = 0
    deleted_bytes = 0
    skipped_count = 0
    export_dirs_to_clean: set = set()
    deleted_export_ids: list = []

    def _is_manual_review_path(path_str: str, review_ids: set) -> bool:
        # Match an order_id only when it sits between path separators (or at
        # the start / end of the path). The previous `oid in path_str` check
        # would treat 'EXT-1' as a hit inside 'EXT-12', skipping unrelated GC.
        if not review_ids:
            return False
        parts = set(path_str.split(os.sep))
        return bool(parts & review_ids)

    for export in expired_exports:
        # Skip files whose path contains a manual-review order_id segment.
        path_str = export.export_file_path or ''
        if _is_manual_review_path(path_str, manual_review_order_ids):
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
                export_dirs_to_clean.add(os.path.dirname(export.export_file_path))

            deleted_export_ids.append(export.id)
            logger.info("GC: deleted expired file %s", export.export_file_path)
        except Exception as exc:
            logger.error("GC: failed to delete %s: %s", export.export_file_path, exc)

    # Bulk-flag rows as deleted in one UPDATE round-trip rather than per-row
    # .save(). For 1000+ expired rows this collapses 1000 UPDATEs into 1.
    if deleted_export_ids:
        ExportedResult.objects.filter(id__in=deleted_export_ids).update(is_deleted=True)

    # Remove per-request export subdirectories that are now empty (sync renders).
    for export_dir in export_dirs_to_clean:
        try:
            if export_dir and os.path.isdir(export_dir):
                os.rmdir(export_dir)  # only succeeds if the directory is empty
        except OSError:
            pass

    # ── Upload file cleanup ─────────────────────────────────────────────────
    # Delete uploaded images older than retention period (same as exports).
    from api.models import UploadedFile
    upload_cutoff = now - timedelta(days=retention_days)
    expired_uploads = UploadedFile.objects.filter(
        _expiry_filter(now, upload_cutoff),
        is_deleted=False,
    ).only('id', 'file_path')
    upload_deleted = 0
    upload_deleted_bytes = 0
    deleted_upload_ids: list = []
    for upload in expired_uploads:
        try:
            if os.path.exists(upload.file_path):
                fsize = os.path.getsize(upload.file_path)
                os.remove(upload.file_path)
                upload_deleted_bytes += fsize
                upload_deleted += 1
            deleted_upload_ids.append(upload.id)
        except Exception as exc:
            logger.error("GC: failed to delete upload %s: %s", upload.file_path, exc)
    if deleted_upload_ids:
        UploadedFile.objects.filter(id__in=deleted_upload_ids).update(is_deleted=True)

    # ── Stale chunked-upload staging cleanup ──────────────────────────────
    # Abandon sessions older than 24 hours — the user gave up or the network
    # dropped permanently.
    chunks_dir = os.path.join(settings.UPLOADS_DIR, '.chunks')
    stale_sessions = 0
    if os.path.isdir(chunks_dir):
        import time as _time
        stale_threshold = _time.time() - 86400  # 24 hours
        for session_id in os.listdir(chunks_dir):
            session_path = os.path.join(chunks_dir, session_id)
            if os.path.isdir(session_path):
                try:
                    mtime = os.path.getmtime(session_path)
                    if mtime < stale_threshold:
                        shutil.rmtree(session_path, ignore_errors=True)
                        stale_sessions += 1
                except Exception as exc:
                    logger.error("GC: failed to clean chunk session %s: %s", session_id, exc)

    # ── Async render output file cleanup ─────────────────────────────────
    # Async renders (via render_canvas_task) write output paths to
    # RenderJob.output_paths but do NOT create ExportedResult records, so
    # the ExportedResult-based GC loop above never touches them.
    # Clean up by finding RenderJobs whose CanvasData has expired and deleting
    # the actual files on disk.
    #
    # NOT filtered on status='completed' any more, and that omission is the
    # point. A job killed mid-render — worker OOM, SIGKILL, container recreate —
    # leaves output files behind with no cleanup path. It never reaches
    # 'completed', so this sweep skipped it; then its CanvasData expired, the
    # delete below cascaded the RenderJob away, and the files became
    # unreachable: no row names them, so no query-driven sweep can ever find
    # them again. That is how 62 orphaned export directories accumulated on
    # production (see reconcile_orphan_exports below, which reclaims the ones
    # already stranded).
    #
    # Safe to include unfinished jobs because the filter is on the CANVAS having
    # expired — a full retention window — while a render has a 55-minute soft
    # limit. Anything still 'processing' that far past its canvas expiry is dead.
    # The created_at guard is belt-and-braces for the one case that could race:
    # a brand-new job submitted against an already-expired CanvasData (a reprint
    # of an old order). A day is far more than a render needs, and every orphan
    # we are chasing is over a week old.
    async_files_deleted = 0
    async_bytes_deleted = 0
    try:
        expired_jobs = (
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
        for rjob in expired_jobs:
            dirs_to_clean: set = set()
            for fpath in (rjob.output_paths or []):
                try:
                    if os.path.exists(fpath):
                        fsize = os.path.getsize(fpath)
                        os.remove(fpath)
                        async_bytes_deleted += fsize
                        async_files_deleted += 1
                        dirs_to_clean.add(os.path.dirname(fpath))
                except Exception as exc:
                    logger.error("GC: failed to delete async render file %s: %s", fpath, exc)
            # Remove the per-job subdirectory if it is now empty.
            # os.rmdir raises OSError if the directory is non-empty, which
            # we silently ignore to avoid breaking jobs with partially-deleted files.
            for job_dir in dirs_to_clean:
                try:
                    if job_dir and os.path.isdir(job_dir):
                        os.rmdir(job_dir)  # no-op if not empty
                except OSError:
                    pass
    except Exception as exc:
        logger.error("GC: async render file cleanup failed: %s", exc)

    # ── Canvas-state record cleanup ───────────────────────────────────────
    # CanvasData rows that have passed their expires_at date accumulate large
    # editor_state JSON blobs (dataUrl previews).  Delete the expired rows that
    # are not flagged for manual review so the DB doesn't grow unbounded.
    # Note: this runs AFTER the file cleanups above so files are removed before
    # their parent DB records (and child RenderJob rows) are cascade-deleted.
    canvas_deleted = 0
    try:
        canvas_deleted, _ = CanvasData.objects.filter(
            expires_at__lt=now,
            requires_manual_review=False,
        ).delete()
        if canvas_deleted:
            logger.info("GC: deleted %d expired CanvasData records", canvas_deleted)
    except Exception as exc:
        logger.error("GC: failed to delete expired CanvasData records: %s", exc)

    # ── Tombstone cleanup ─────────────────────────────────────────────────
    # Deleting a file only flips is_deleted=True on its ExportedResult /
    # UploadedFile row — and every sweep above filters is_deleted=False, so
    # nothing ever looked at those rows again. They accumulated one per output
    # file forever (7,585 in production after a single backlog clear).
    #
    # Once the file is gone the row has no operational purpose: the sweeps skip
    # it and no endpoint reads it. Drop tombstones older than the retention
    # window, which leaves a full window of recent rows for anyone inspecting
    # what was collected, then reclaims the space.
    tombstones_deleted = 0
    try:
        for model in (ExportedResult, UploadedFile):
            n, _ = model.objects.filter(
                is_deleted=True, created_at__lt=cutoff_date,
            ).delete()
            tombstones_deleted += n
        if tombstones_deleted:
            logger.info("GC: hard-deleted %d tombstone row(s)", tombstones_deleted)
    except Exception as exc:
        logger.error("GC: tombstone cleanup failed: %s", exc)

    # ── API audit-trail cleanup ───────────────────────────────────────────
    # Kept on its own, much longer clock than the files (see
    # settings.API_AUDIT_RETENTION_DAYS): the trail has to outlive the data it
    # describes to be worth anything. Swept here so it cannot become the next
    # unbounded-growth surprise.
    audit_deleted = 0
    try:
        from api.models import APIRequest
        audit_cutoff = now - timedelta(days=settings.API_AUDIT_RETENTION_DAYS)
        audit_deleted, _ = APIRequest.objects.filter(created_at__lt=audit_cutoff).delete()
        if audit_deleted:
            logger.info("GC: deleted %d expired API audit row(s)", audit_deleted)
    except Exception as exc:
        logger.error("GC: API audit cleanup failed: %s", exc)

    logger.info(
        "GC complete: exports deleted=%d (%.2f MB), skipped=%d manual-review, "
        "uploads deleted=%d (%.2f MB), async render files deleted=%d (%.2f MB), "
        "stale chunk sessions=%d, canvas_data deleted=%d, tombstones=%d, "
        "audit rows=%d, disk=%.1f%%",
        deleted_count, deleted_bytes / 1024 / 1024, skipped_count,
        upload_deleted, upload_deleted_bytes / 1024 / 1024,
        async_files_deleted, async_bytes_deleted / 1024 / 1024,
        stale_sessions, canvas_deleted, tombstones_deleted, audit_deleted,
        usage_percent,
    )

    # ── Orphaned export directories ───────────────────────────────────────
    # The only sweep here that starts from the filesystem rather than a DB row,
    # because it is the only one that can reclaim a file whose row is gone. Off
    # by default (dry_run reports without deleting) — see
    # services/orphan_exports.py for why this one earns extra caution.
    orphan_result: dict = {}
    try:
        from services.orphan_exports import reconcile_orphan_exports
        orphan_result = reconcile_orphan_exports(now=now)
    except Exception as exc:
        logger.error("GC: orphan export sweep failed: %s", exc)

    # Abandoned chunked-upload staging dirs. Unlike the orphan sweep above this
    # one deletes by default: a stale `.chunks/<uuid>/` holds only `.part`
    # fragments that are unusable without the `/complete` call that would have
    # consumed them, so no inference about "is this still wanted" is involved.
    # See services/chunk_staging.py for the three conditions it requires.
    chunk_staging_result: dict = {}
    try:
        from services.chunk_staging import sweep_stale_chunk_staging
        chunk_staging_result = sweep_stale_chunk_staging(now=now)
    except Exception as exc:
        logger.error("GC: chunk staging sweep failed: %s", exc)

    result = {
        'chunk_staging': chunk_staging_result,
        'orphan_exports': orphan_result,
        'deleted_count': deleted_count,
        'deleted_bytes': deleted_bytes,
        'skipped_count': skipped_count,
        'upload_deleted_count': upload_deleted,
        'upload_deleted_bytes': upload_deleted_bytes,
        'async_render_files_deleted': async_files_deleted,
        'async_render_bytes_deleted': async_bytes_deleted,
        'stale_chunk_sessions_cleaned': stale_sessions,
        'canvas_data_deleted': canvas_deleted,
        'tombstones_deleted': tombstones_deleted,
        'audit_rows_deleted': audit_deleted,
        'disk_usage_percent': usage_percent,
    }

    # Leave a durable trace that this sweep happened. Everything above is
    # otherwise recorded only in the Celery log, which dies with the container,
    # and the DB keeps no evidence because the tombstone purge above removes the
    # very rows that would have shown it. A GC that silently stops running is
    # invisible until the disk fills — it was, for over a week, until prod hit
    # 89%. Surfaced on /api/celery/monitor/; see services/gc_status.py.
    from services.gc_status import record_gc_run
    record_gc_run(result)

    return result


# ── Make a failed sweep visible ──────────────────────────────────────────────
# record_gc_run above only fires on success, so until this hook existed a sweep
# that raised left no trace at all: the status file kept the previous timestamp
# (or none), and `stale` slowly drifted up looking exactly like "beat never
# scheduled it".
#
# That ambiguity produced two days of wrong answers on 2026-08-14 — "beat isn't
# firing", then "the task dies on a stale DB connection" — before the worker log
# showed the sweep succeeding nightly in 0.19s. Worker logs survive container
# recreation in Loki; query {container=~".*celery-worker.*"} for the window
# before theorising about a silent task.
#
# Connected to the task_failure signal rather than wrapping the sweep body in
# try/except so the task's retry and acknowledgement behaviour is untouched, and
# so the ~250-line body needs no reindentation.
@task_failure.connect(sender=garbage_collector_task)
def _record_garbage_collector_failure(exception=None, **_kwargs):
    try:
        from services.gc_status import record_gc_failure
        record_gc_failure(exception or "unknown error")
    except Exception as exc:  # never let the reporter mask the real failure
        logger.warning("Could not record GC failure status: %s", exc)
