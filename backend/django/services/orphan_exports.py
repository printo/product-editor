"""
Path-based reclamation of export directories the database has lost track of.

Every other sweep in `garbage_collector_task` starts from a database row and
follows it to a file. That cannot reclaim a file whose row is gone — and on
2026-08-13 production held 62 such directories (54 MB), each with no RenderJob
and no ExportedResult referencing it. They were invisible to every query-driven
sweep, permanently.

They formed because the async-render cleanup used to require
`status='completed'`: a job killed mid-render (worker OOM, SIGKILL, container
recreate) never reached that state, so its files were skipped; later its
CanvasData expired, the cascade removed the RenderJob, and the only pointer to
the files went with it. That hole is closed in tasks.py — this module cleans up
what fell through it before the fix.

So this sweep works the other way round: enumerate the directories on disk and
delete only those nothing in the database can account for.

That inversion is inherently more dangerous than the row-driven sweeps. Deleting
on *absence* of evidence means a subtly wrong query destroys live print files
rather than merely missing some. Hence:

  * It is off by default. `GC_ORPHAN_SWEEP=dry_run` reports without deleting;
    only `delete` removes anything. Run it in dry_run for a night and read the
    numbers before arming it.
  * Five independent conditions must ALL hold before a directory is touched
    (see `_classify`), and any one of them failing keeps the directory.
  * An age floor of retention + 1 day keeps in-flight and just-finished renders
    entirely out of scope.
"""
from __future__ import annotations

import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from django.conf import settings
from django.utils import timezone as dj_timezone

logger = logging.getLogger(__name__)

# How many example paths to include in the result for an operator to eyeball.
# The full list can be hundreds of entries; the point is a spot-check, not a
# manifest.
SAMPLE_LIMIT = 10


def _is_uuid(name: str) -> bool:
    try:
        uuid.UUID(name)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _dir_size_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for fname in files:
            try:
                total += os.path.getsize(os.path.join(root, fname))
            except OSError:
                pass
    return total


def _known_export_dir_names() -> tuple[set[str], set[str], set[str]]:
    """Everything the database can account for, in three bulk queries.

    Per-directory queries would mean one round trip per directory (811 of them
    on production). These three sets are built once and tested against in memory.
    """
    from api.models import CanvasData, ExportedResult, RenderJob

    job_ids = {str(v) for v in RenderJob.objects.values_list("id", flat=True)}

    # ExportedResult stores a full file path; the export directory is its parent.
    exported_dirs = set()
    for path in ExportedResult.objects.values_list("export_file_path", flat=True):
        if path:
            exported_dirs.add(os.path.basename(os.path.dirname(path)))

    # Export directories are named by job id, but the GC's manual-review check
    # cross-references EXPORTS_DIR/<order_id>/ too, so both conventions exist in
    # this tree. A partner order_id could legitimately be UUID-shaped, so treat
    # any live order_id as off-limits regardless of shape.
    order_ids = {str(v) for v in CanvasData.objects.values_list("order_id", flat=True) if v}

    return job_ids, exported_dirs, order_ids


def _classify(
    entry_path: str,
    name: str,
    *,
    age_floor: datetime,
    job_ids: set[str],
    exported_dirs: set[str],
    order_ids: set[str],
) -> str | None:
    """Return a keep-reason, or None when the directory is a reclaimable orphan.

    Every branch here is a reason NOT to delete. Adding a new export-directory
    naming convention without adding it here would make those directories look
    like orphans.
    """
    if not _is_uuid(name):
        # Not a job directory. Could be an order_id-named tree or something an
        # operator put here by hand — either way, not ours to remove.
        return "not-a-uuid"
    if name in job_ids:
        return "live-renderjob"
    if name in exported_dirs:
        return "referenced-by-exportedresult"
    if name in order_ids:
        return "live-canvasdata-order"
    try:
        mtime = datetime.fromtimestamp(os.path.getmtime(entry_path), tz=timezone.utc)
    except OSError:
        return "unstattable"
    if mtime >= age_floor:
        # Young enough to belong to an in-flight or recently-finished render.
        return "too-recent"
    return None


def reconcile_orphan_exports(*, mode: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Find (and in `delete` mode remove) export dirs no DB row accounts for.

    mode: 'off' | 'dry_run' | 'delete'. Defaults to settings.GC_ORPHAN_SWEEP.
    Never raises — a reclamation pass must not be able to fail the GC sweep it
    runs inside.
    """
    mode = (mode or getattr(settings, "GC_ORPHAN_SWEEP", "dry_run") or "dry_run").strip().lower()
    result: dict[str, Any] = {
        "mode": mode,
        "orphan_dirs": 0,
        "orphan_bytes": 0,
        "deleted_dirs": 0,
        "deleted_bytes": 0,
        "scanned": 0,
        "kept": {},
        "samples": [],
    }
    if mode == "off":
        return result

    exports_dir = settings.EXPORTS_DIR
    if not os.path.isdir(exports_dir):
        return result

    now = now or dj_timezone.now()
    # Retention plus a full day of margin. The margin is what makes this safe to
    # run alongside live traffic: nothing a render is still touching can qualify.
    age_floor = now - timedelta(days=settings.EXPORT_RETENTION_DAYS + 1)

    try:
        job_ids, exported_dirs, order_ids = _known_export_dir_names()
    except Exception as exc:
        # Without the database sets every directory would look like an orphan.
        # Bail out rather than proceed on a partial picture.
        logger.error("Orphan export sweep: could not read DB state, skipping: %s", exc)
        result["error"] = str(exc)
        return result

    kept: dict[str, int] = {}
    try:
        entries = sorted(os.listdir(exports_dir))
    except OSError as exc:
        logger.error("Orphan export sweep: cannot list %s: %s", exports_dir, exc)
        result["error"] = str(exc)
        return result

    for name in entries:
        entry_path = os.path.join(exports_dir, name)
        if not os.path.isdir(entry_path):
            continue
        result["scanned"] += 1

        reason = _classify(
            entry_path, name,
            age_floor=age_floor, job_ids=job_ids,
            exported_dirs=exported_dirs, order_ids=order_ids,
        )
        if reason is not None:
            kept[reason] = kept.get(reason, 0) + 1
            continue

        size = _dir_size_bytes(entry_path)
        result["orphan_dirs"] += 1
        result["orphan_bytes"] += size
        if len(result["samples"]) < SAMPLE_LIMIT:
            result["samples"].append({"dir": name, "bytes": size})

        if mode == "delete":
            try:
                shutil.rmtree(entry_path)
                result["deleted_dirs"] += 1
                result["deleted_bytes"] += size
                logger.info("Orphan export sweep: removed %s (%d bytes)", entry_path, size)
            except Exception as exc:
                logger.error("Orphan export sweep: failed to remove %s: %s", entry_path, exc)

    result["kept"] = kept
    logger.info(
        "Orphan export sweep (%s): scanned=%d orphans=%d (%.2f MB) deleted=%d (%.2f MB) kept=%s",
        mode, result["scanned"], result["orphan_dirs"], result["orphan_bytes"] / 1024 / 1024,
        result["deleted_dirs"], result["deleted_bytes"] / 1024 / 1024, kept,
    )
    return result
