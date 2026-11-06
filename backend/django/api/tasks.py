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
    Flatten per-frame transforms from the render_state snapshot into a list
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
    Extract per-canvas overlay lists from the render_state snapshot for the
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
    Extract per-canvas background + paper colours from the render_state snapshot
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

    The contract is the submit-time snapshot (render_state) and nothing else.
    editor_state is the autosave's field and is never read here: a job whose
    payload lived there predates migration 0008, and no such row can still
    exist — CanvasData expires after EXPORT_RETENTION_DAYS. A direct-API row
    (GenerateLayoutView) has no snapshot at all; the engine then falls back
    to the layout's fit_mode.

    image_paths come from the snapshot, not the row, when the snapshot has
    them: a post-submit autosave (CanvasStateView) resets
    CanvasData.image_paths to [] — the snapshot is immutable for the lifetime
    of the queued job. Direct-API rows carry their paths on the row.

    Returns (render_source, image_paths).
    """
    render_source = canvas_data.render_state or None
    image_paths = (canvas_data.render_state or {}).get('image_paths') or canvas_data.image_paths
    return render_source, image_paths


def _referenced_upload_ids(overlays_per_canvas, calendar_state=None) -> set[str]:
    """Every customer upload the print draws besides the frame photos: image
    overlays (`fileId`) and photos placed on calendar dates (`uploadId` on an
    `image` entry in `calendar.cells`).

    Calendar date photos were missing here, so the renderer never found their
    files and printed those dates as empty cells while the editor showed the
    photo.
    """
    upload_ids: set[str] = set()
    for canvas_overlays in overlays_per_canvas or []:
        for o in canvas_overlays or []:
            if isinstance(o, dict) and o.get('type') == 'image' and o.get('fileId'):
                upload_ids.add(str(o['fileId']))
    cells = (calendar_state or {}).get('cells') or {}
    for entries in cells.values():
        for e in entries or []:
            if isinstance(e, dict) and e.get('type') == 'image' and e.get('uploadId'):
                upload_ids.add(str(e['uploadId']))
    return upload_ids


def _build_uploaded_files_map(canvas_data, overlays_per_canvas, calendar_state=None) -> dict | None:
    """
    Build { upload_id → server file path } for the uploads the print draws
    besides frame photos — image overlays and calendar date photos — so the
    overlay and calendar renderers can open them.

    Uploads are matched by `upload_session_id` (the id the chunked-upload API
    gave the customer) within the canvas's own api_key (tenant boundary).

    Returns None when nothing references an upload (the engine then skips
    the lookup entirely).
    """
    upload_ids = _referenced_upload_ids(overlays_per_canvas, calendar_state)
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


def _build_restore_manifest(canvas_data, job_id: str, layout_version) -> dict | None:
    """The restore.json for this job (services/restore_manifest.py), or None.

    Built from the same submit-time snapshot the print was made from. Only for
    jobs whose caller wants the uploads archive, which is what carries it.
    """
    render_state = canvas_data.render_state or {}
    if not render_state.get('include_uploads', True):
        return None

    from PIL import Image
    from api.models import UploadedFile
    from services.restore_manifest import build_restore_manifest, referenced_uploads

    upload_ids = [uid for uid, _ in referenced_uploads(render_state.get('canvases'))]
    if not upload_ids:
        return None

    uploads = {}
    rows = UploadedFile.objects.filter(
        api_key=canvas_data.api_key,
        upload_session_id__in=upload_ids,
        is_deleted=False,
    ).values_list('upload_session_id', 'file_path', 'original_filename', 'file_size_bytes')
    for upload_id, path, name, size in rows:
        # Pixel size as stored. Reading the header does not decode the photo,
        # so this stays cheap for a 200-photo order.
        width = height = None
        try:
            with Image.open(path) as im:
                width, height = im.size
        except Exception:
            pass
        uploads[str(upload_id)] = {
            'original_name': name, 'size_bytes': size, 'width': width, 'height': height,
        }

    return build_restore_manifest(
        order_id=canvas_data.order_id,
        render_job_id=job_id,
        layout_name=canvas_data.layout_name,
        layout_version=layout_version,
        created_at=timezone.localtime().isoformat(timespec='seconds'),
        render_state=render_state,
        uploads=uploads,
    )


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
    from services.layout_orientation import apply_orientation
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
        from api.models import LayoutCatalogue

        canvas = CanvasData.objects.get(id=canvas_data_id)
        storage = get_storage()

        # Load layout from LayoutCatalogue (Postgres). resolve_active follows
        # a rename alias — canvas.layout_name was snapshotted at submit time
        # and may since have been renamed away in the ops UI; the render
        # must not fail just because the identifier moved.
        layout_def = None
        try:
            layout_obj = LayoutCatalogue.resolve_active(canvas.layout_name)
            layout_def = layout_obj.definition
            if layout_obj.name != canvas.layout_name:
                logger.info(
                    "Layout '%s' resolved via rename alias to '%s' for job %s",
                    canvas.layout_name, layout_obj.name, job_id,
                )
        except LayoutCatalogue.DoesNotExist:
            logger.error(
                "Layout '%s' not found in LayoutCatalogue for job %s",
                canvas.layout_name, job_id
            )
            raise

        # Turn the layout the way the editor showed it. The submit-time report
        # is the contract: it only says applied when the layout could be
        # turned, and the same function runs here, so print and preview agree.
        orientation = (canvas.render_state or {}).get('orientation') or {}
        if orientation.get('applied'):
            layout_def, _ = apply_orientation(layout_def, orientation.get('requested'))

        # Give each async job its own exports subdirectory so concurrent jobs
        # for the same layout name never overwrite each other's output files.
        job_exports_dir = os.path.join(settings.EXPORTS_DIR, job_id)
        os.makedirs(job_exports_dir, exist_ok=True)

        engine = LayoutEngine(storage.layouts_dir(), job_exports_dir, layout_definition=layout_def)

        start_time = time.time()

        render_source, image_paths = _resolve_render_inputs(canvas)

        # Extract per-frame transforms saved by EditorRenderView so the engine
        # can reproduce the exact pan / zoom / rotation the user set in the editor.
        frame_transforms = _extract_frame_transforms(render_source)

        # Phase 1 (CALENDAR_FEATURE_PRD.md §5) — extract overlays + the upload
        # map so text/shape/image overlays render server-side. Layouts without
        # overlays return None here and the engine fast-paths past the new code.
        overlays_per_canvas = _extract_overlays_per_canvas(render_source)

        # Phase 2 (WYSIWYG) — per-canvas background + paper colours so the print
        # matches the colours the customer chose (previously hardcoded white).
        backgrounds_per_canvas = _extract_backgrounds_per_canvas(render_source)

        # Phase 4 (Bug B fix) — extract customer-side calendar state. Returns
        # None for non-calendar products; engine then uses the layout's ops
        # defaults. For calendar products the customer's themePreset /
        # calendarType / palette choices override the layout defaults at
        # materialize time; per-canvas cells override at render time.
        calendar_state = _extract_calendar_state(render_source)

        # Uploads the print draws besides frame photos: image overlays and
        # photos placed on calendar dates. Built after calendar_state, which
        # holds the date photos.
        uploaded_files = _build_uploaded_files_map(canvas, overlays_per_canvas, calendar_state)

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
        # restore.json for the uploads archive. Bookkeeping: a failure here
        # must never fail a render whose files are already on disk.
        try:
            job.restore_manifest = _build_restore_manifest(canvas, job_id, getattr(layout_obj, 'version', None))
        except Exception as exc:
            job.restore_manifest = None
            logger.error("Job %s: could not build the restore manifest: %s", job_id, exc)
        job.save(update_fields=['status', 'completed_at', 'generation_time_ms', 'output_paths', 'restore_manifest'])

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
          "export_format": "png" | "pdf",
          "qty_summary":   null | {"ordered_qty", "placed_photos",
                                   "shortfall", "customer_acknowledged_shortfall",
                                   "summary"}
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
        # Null when the session set no qty. See services/order_qty.qty_summary.
        'qty_summary':   (canvas.render_state or {}).get('qty_summary'),
        # Null for a job submitted before orientation existed. Otherwise
        # {requested, applied, reason, orientation}: what the session asked
        # for and whether the print was turned to match.
        'orientation':   (canvas.render_state or {}).get('orientation'),
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

    Runs every 6 hours (00:00, 06:00, 12:00 and 18:00 UTC; see
    product_editor/celery.py). When disk usage exceeds 80 % it uses
    EXPORT_RETENTION_DAYS_UNDER_PRESSURE instead of EXPORT_RETENTION_DAYS (the
    same value unless set lower). Files belonging to orders flagged for manual
    review are skipped even if expired.

    The sweeps live in api/gc_sweeps.py; this task fixes their order (files
    before the CanvasData rows whose cascade would strand them, tombstones
    after the sweeps that create them) and assembles the result.

    Returns:
        dict with deleted_count, deleted_bytes, disk_usage_percent
    """
    from datetime import timedelta
    from api import gc_sweeps

    now = timezone.now()
    usage_percent = gc_sweeps.disk_usage_percent()
    # One constant sets CanvasData.expires_at, the expires_at sent in the
    # completion webhook and this sweep; when they drifted, callers were
    # promised 30 days for files removed at 14.
    retention_days = gc_sweeps.effective_retention_days(usage_percent)
    cutoff_date = now - timedelta(days=retention_days)
    due = gc_sweeps.expiry_filter(
        now, cutoff_date, under_pressure=retention_days < settings.EXPORT_RETENTION_DAYS,
    )

    exports = gc_sweeps.sweep_expired_exports(due)
    uploads = gc_sweeps.sweep_expired_uploads(due)
    async_renders = gc_sweeps.sweep_async_render_files(now)
    canvas_deleted = gc_sweeps.sweep_expired_canvas_data(now)
    tombstones_deleted = gc_sweeps.sweep_tombstones(cutoff_date)
    audit_deleted = gc_sweeps.sweep_audit_trail(now)

    logger.info(
        "GC complete: exports deleted=%d (%.2f MB), skipped=%d manual-review, "
        "uploads deleted=%d (%.2f MB), async render files deleted=%d (%.2f MB), "
        "canvas_data deleted=%d, tombstones=%d, "
        "audit rows=%d, disk=%.1f%%",
        exports['deleted_count'], exports['deleted_bytes'] / 1024 / 1024, exports['skipped_count'],
        uploads['upload_deleted_count'], uploads['upload_deleted_bytes'] / 1024 / 1024,
        async_renders['async_render_files_deleted'],
        async_renders['async_render_bytes_deleted'] / 1024 / 1024,
        canvas_deleted, tombstones_deleted, audit_deleted,
        usage_percent,
    )

    orphan_result = gc_sweeps.sweep_orphan_exports(now)
    chunk_staging_result = gc_sweeps.sweep_chunk_staging(now)
    embed_sessions_deleted = gc_sweeps.sweep_embed_sessions(now)
    ledger_trimmed = gc_sweeps.trim_purge_ledger_entries()

    result = {
        'purge_ledger_trimmed': ledger_trimmed,
        'chunk_staging': chunk_staging_result,
        'orphan_exports': orphan_result,
        **exports,
        **uploads,
        **async_renders,
        'canvas_data_deleted': canvas_deleted,
        'tombstones_deleted': tombstones_deleted,
        'audit_rows_deleted': audit_deleted,
        'embed_sessions_deleted': embed_sessions_deleted,
        'disk_usage_percent': usage_percent,
    }

    # Leave a durable trace that this sweep happened: everything above is
    # otherwise recorded only in the Celery log, which dies with the container,
    # and the tombstone purge removes the very rows that would show it. A GC
    # that silently stops running is invisible until the disk fills (prod hit
    # 89%). Surfaced on /api/celery/monitor/; see services/gc_status.py.
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
# showed the sweep succeeding nightly in 0.19s. Read the worker log for the
# window before theorising about a silent task:
#   docker-compose logs --since 24h celery-worker-standard
# Note these live only in Docker's json-file log (50 MB x 3 per service) and do
# NOT survive container recreation — this repo stopped shipping them to Loki on
# 2026-09-07, when the self-hosted Grafana stack was removed. Grab the log
# BEFORE recreating a container, or ask whoever runs the external collector.
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
