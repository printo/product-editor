"""
On-demand data erasure for a single order (Phase 4 — DPDP right-to-erasure).

The only deletion path before this was the retention-timer garbage collector
(14–30 days). A DPDP erasure request must be honourable immediately, so this
hard-deletes everything tied to an order_id: uploads, exports, CanvasData
(cascades RenderJobs), and EmbedSessions — rows AND files.

Invoked by OrderDataPurgeView (ops-only). Runs inline; per-order file counts
are small. DB deletes happen in one transaction; disk deletes are best-effort
and collected into an errors[] list rather than aborting the erasure.
"""
from __future__ import annotations

import logging
import os
import shutil

from django.conf import settings
from django.db import transaction

logger = logging.getLogger(__name__)


def _delete_files(paths) -> tuple[int, int, list[str]]:
    """Delete each file path; return (deleted_count, freed_bytes, errors)."""
    deleted = 0
    freed = 0
    errors: list[str] = []
    for p in paths:
        if not p:
            continue
        try:
            if os.path.isfile(p):
                freed += os.path.getsize(p)
                os.remove(p)
                deleted += 1
        except OSError as exc:
            errors.append(f"{p}: {exc}")
    return deleted, freed, errors


def purge_order_data(order_id: str, api_key=None, force: bool = False) -> dict:
    """
    Hard-delete all data for `order_id`. When `api_key` is given, scope to that
    tenant; otherwise purge across all keys (an ops-initiated DPDP erasure must
    be complete). `force` overrides the in-flight-render guard.

    Returns a summary dict: matched rows, deleted files/rows per artifact, the
    api_key names touched, any in-flight blockers, and best-effort file errors.
    """
    from api.models import CanvasData, RenderJob, EmbedSession, UploadedFile, ExportedResult

    canvas_qs = CanvasData.objects.filter(order_id=order_id)
    embed_qs = EmbedSession.objects.filter(order_id=order_id)
    if api_key is not None:
        canvas_qs = canvas_qs.filter(api_key=api_key)
        embed_qs = embed_qs.filter(api_key=api_key)

    canvases = list(canvas_qs.select_related('api_key'))
    if not canvases and not embed_qs.exists():
        return {'matched': 0, 'detail': 'No data found for this order.'}

    # In-flight guard: don't yank files from under a running render.
    in_flight = RenderJob.objects.filter(
        canvas_data__in=canvases, status__in=('queued', 'processing'),
    )
    if in_flight.exists() and not force:
        return {
            'matched': len(canvases),
            'blocked': True,
            'detail': 'A render is still queued/processing for this order. '
                      'Retry with force=true to purge anyway.',
        }

    errors: list[str] = []
    files_deleted = 0
    freed_bytes = 0
    keys_touched: dict[str, int] = {}

    # Upload paths still referenced by a DIFFERENT, non-purged CanvasData of
    # the same key must not be deleted (shared originals).
    purged_ids = {c.id for c in canvases}
    keep_paths: set[str] = set()
    for other in CanvasData.objects.exclude(id__in=purged_ids):
        for p in (other.image_paths or []):
            if p:
                keep_paths.add(p)
        rs = other.render_state or {}
        for p in (rs.get('image_paths') or []):
            if p:
                keep_paths.add(p)

    # Every path we intend to remove, so the sweep after the transaction can
    # confirm each one actually went. Deleting is not the same as having
    # deleted: an rmtree can fail on a permission error, a file can be
    # re-created by an in-flight write, and both previously passed silently.
    attempted_paths: set[str] = set()
    attempted_dirs: set[str] = set()

    with transaction.atomic():
        for canvas in canvases:
            key_name = getattr(canvas.api_key, 'name', 'unknown')
            keys_touched[key_name] = keys_touched.get(key_name, 0) + 1

            # 1. Export files + dirs for each render job.
            jobs = list(RenderJob.objects.filter(canvas_data=canvas))
            for job in jobs:
                attempted_paths.update(p for p in (job.output_paths or []) if p)
                d, f, e = _delete_files(job.output_paths or [])
                files_deleted += d; freed_bytes += f; errors += e
                job_dir = os.path.join(settings.EXPORTS_DIR, str(job.id))
                attempted_dirs.add(job_dir)
                if os.path.isdir(job_dir):
                    try:
                        shutil.rmtree(job_dir)
                    except OSError as exc:
                        errors.append(f"{job_dir}: {exc}")

            # 2. Upload files not shared with a surviving order.
            upload_paths = set(canvas.image_paths or [])
            rs = canvas.render_state or {}
            upload_paths |= set(rs.get('image_paths') or [])
            deletable = [p for p in upload_paths if p and p not in keep_paths]
            attempted_paths.update(deletable)
            d, f, e = _delete_files(deletable)
            files_deleted += d; freed_bytes += f; errors += e

            # HARD-delete the UploadedFile rows (original_filename is personal
            # data — DPDP erasure, not the GC's is_deleted soft-delete).
            UploadedFile.objects.filter(file_path__in=deletable).delete()

            # Chunk-staging leftovers keyed by upload_session_id.
            for sess in UploadedFile.objects.filter(
                api_key=canvas.api_key,
            ).values_list('upload_session_id', flat=True):
                if not sess:
                    continue
                sd = os.path.join(settings.UPLOADS_DIR, '.chunks', str(sess))
                if os.path.isdir(sd):
                    shutil.rmtree(sd, ignore_errors=True)

            # 3. ExportedResult rows/files under a purged job dir.
            for job in jobs:
                job_dir = os.path.join(settings.EXPORTS_DIR, str(job.id))
                stragglers = ExportedResult.objects.filter(export_file_path__startswith=job_dir)
                d, f, e = _delete_files(stragglers.values_list('export_file_path', flat=True))
                files_deleted += d; freed_bytes += f; errors += e
                stragglers.delete()

        # 2b. Uploads linked directly to the order.
        #
        # Everything above reaches files only via CanvasData.image_paths /
        # render_state['image_paths']. Autosave blanks image_paths every 2s, and
        # a file uploaded but never placed in a canvas appears in neither — so
        # this used to delete the rows, report files_deleted: 0, and leave the
        # photographs on disk. UploadedFile.order_id (migration 0011) closes
        # that: ask the upload table directly who owns the file.
        #
        # Still honours the shared-original rule via keep_paths.
        order_uploads = UploadedFile.objects.filter(order_id=order_id)
        if api_key is not None:
            order_uploads = order_uploads.filter(api_key=api_key)
        linked_paths = [
            p for p in order_uploads.values_list('file_path', flat=True)
            if p and p not in keep_paths
        ]
        if linked_paths:
            attempted_paths.update(linked_paths)
            d, f, e = _delete_files(linked_paths)
            files_deleted += d; freed_bytes += f; errors += e
            UploadedFile.objects.filter(file_path__in=linked_paths).delete()

        # 4. CanvasData.delete() cascades RenderJob rows.
        canvas_rows = len(canvases)
        canvas_qs.filter(id__in=purged_ids).delete()

        # 5. EmbedSession rows for the same order.
        embed_rows = embed_qs.count()
        embed_qs.delete()

    # ── Verification sweep (PRD phase 4) ─────────────────────────────────────
    #
    # Runs AFTER the transaction commits, so it sees the real post-purge state.
    # Re-checks every path and directory we tried to remove and retries once,
    # then reports whatever is still there.
    #
    # Scope, stated honestly: this verifies that everything we KNEW about is
    # gone. It cannot discover unknown upload files for the order, because
    # uploads are stored flat under UPLOADS_DIR with a random filename prefix —
    # nothing in the path identifies the owner. UploadedFile.order_id
    # (migration 0011) is what makes ownership knowable; this sweep is the
    # check that the deletion driven by it actually took effect.
    residual_files: list[str] = []
    for path in sorted(attempted_paths):
        if not os.path.exists(path):
            continue
        try:                       # one retry — transient locks, slow unlinks
            os.remove(path)
            files_deleted += 1
        except OSError as exc:
            residual_files.append(path)
            errors.append(f"{path}: still present after purge ({exc})")

    residual_dirs: list[str] = []
    for d_path in sorted(attempted_dirs):
        if not os.path.isdir(d_path):
            continue
        try:
            shutil.rmtree(d_path)
        except OSError as exc:
            residual_dirs.append(d_path)
            errors.append(f"{d_path}: still present after purge ({exc})")

    if residual_files or residual_dirs:
        logger.error(
            "Order %s: %d file(s) and %d dir(s) survived the purge — %s",
            order_id, len(residual_files), len(residual_dirs),
            (residual_files + residual_dirs)[:5],
        )

    # Did we actually erase anything? A purge that removes rows but no files is
    # NOT a completed erasure, and previously reported `files_deleted: 0` with
    # no other signal — indistinguishable from an order that genuinely had no
    # files. Callers (and auditors) need to tell those apart.
    #
    # unlocated_rows: upload rows we deleted without finding a file to go with
    # them. Non-zero means bytes may still be on disk somewhere we could not
    # resolve — worth investigating rather than reporting success.
    unlocated_rows = UploadedFile.objects.filter(order_id=order_id).count()
    # Complete means: no upload row left claiming this order, nothing we tried
    # to delete survived, and no file error along the way.
    erasure_complete = (
        unlocated_rows == 0
        and not residual_files
        and not residual_dirs
        and not errors
    )

    logger.info(
        "Purged order %s: %d canvas rows, %d embed rows, %d files (%.1f MB), "
        "keys=%s, errors=%d, unlocated=%d, complete=%s",
        order_id, canvas_rows, embed_rows, files_deleted, freed_bytes / (1024 * 1024),
        list(keys_touched.keys()), len(errors), unlocated_rows, erasure_complete,
    )
    if not erasure_complete:
        logger.warning(
            "Order %s erasure INCOMPLETE: %d upload row(s) unresolved, %d file error(s). "
            "Files may remain on disk; see docs/DPDP_ERASURE_GAP_PRD.md.",
            order_id, unlocated_rows, len(errors),
        )
    return {
        'matched': canvas_rows,
        'canvas_rows_deleted': canvas_rows,
        'embed_rows_deleted': embed_rows,
        'files_deleted': files_deleted,
        'bytes_freed': freed_bytes,
        # Erasure honesty (see the warning logged above): `files_deleted: 0` on
        # its own reads as success. These two say whether the erasure can
        # actually be claimed as complete.
        'unlocated_upload_rows': unlocated_rows,
        'residual_files': residual_files,
        'residual_dirs': residual_dirs,
        'erasure_complete': erasure_complete,
        'api_keys_touched': keys_touched,
        'errors': errors,
    }
