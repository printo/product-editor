"""
Reclamation of chunked-upload staging directories that were never completed.

`POST /upload/init` creates `UPLOADS_DIR/.chunks/<upload_id>/` and each
`PUT /upload/<id>/chunk` drops a `<n>.part` file into it. `assemble_chunks`
rmtree's the directory once `/complete` succeeds, so a NORMAL upload cleans up
after itself and never reaches this module.

An upload that never completes does not. Close the tab mid-upload, lose the
connection, let the embed token expire — the parts stay on disk forever. No
sweep in `garbage_collector_task` looked at them, because every other sweep
starts from a database row and a half-finished upload has no `UploadedFile`
row to start from. Production held 93 such directories on 2026-08-25.

Two reasons this is worth reclaiming despite being small (384 KB at discovery):
it grows without bound, and `.part` files are fragments of customer photos, so
they outlive the `EXPORT_RETENTION_DAYS` window that is the stated promise
about how long customer data is kept.

Unlike `orphan_exports`, this sweep DELETES BY DEFAULT. That difference is
deliberate and worth understanding before copying either module:

  * `orphan_exports` infers garbage from the ABSENCE of a database row, so a
    subtly wrong query would destroy live print files. It is gated behind
    GC_ORPHAN_SWEEP for that reason.
  * A stale staging directory needs no inference. Its contents are `.part`
    fragments that are unusable without the `/complete` call that would have
    consumed and removed them. Past the age floor there is no state in which
    they are wanted.

Safety still comes from three conditions, all of which must hold:
  1. the directory sits directly under `.chunks/`;
  2. its name parses as a UUID — the same guard the upload endpoints apply
     before opening any request-derived path;
  3. nothing inside it has been touched for CHUNK_STAGING_MAX_AGE_HOURS.

(3) is what makes it safe to run beside live traffic: each chunk written
updates the directory's mtime, so an upload in progress is never a candidate.
The check takes the NEWEST timestamp of the directory and its contents, so a
slow client that has been uploading for hours is still protected.
"""
from __future__ import annotations

import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone as dj_timezone

logger = logging.getLogger(__name__)

# Enough example paths for an operator to spot-check; not a manifest.
SAMPLE_LIMIT = 10

# An upload session realistically completes in minutes, and an embed token only
# lives 2 hours. A full day is generous enough that no legitimate in-flight
# upload can qualify, while still bounding growth.
DEFAULT_MAX_AGE_HOURS = 24


def _is_uuid(name: str) -> bool:
    try:
        uuid.UUID(name)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _newest_mtime(path: str) -> float:
    """Newest mtime of a directory or anything inside it.

    Taking the max rather than the directory's own mtime protects a slow
    upload: the directory's timestamp changes when entries are added or
    removed, but rewriting a part file in place would not touch it.
    """
    newest = os.path.getmtime(path)
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, name)))
            except OSError:
                continue
    return newest


def _dir_size_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def sweep_stale_chunk_staging(
    *,
    max_age_hours: int | None = None,
    dry_run: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Remove `.chunks/<uuid>/` directories abandoned before the age floor.

    Never raises: a reclamation pass must not be able to fail the GC sweep it
    runs inside. Errors are recorded in the result and logged.
    """
    if max_age_hours is None:
        max_age_hours = getattr(
            settings, "CHUNK_STAGING_MAX_AGE_HOURS", DEFAULT_MAX_AGE_HOURS
        )

    result: dict[str, Any] = {
        "scanned": 0,
        "stale_dirs": 0,
        "stale_bytes": 0,
        "deleted_dirs": 0,
        "deleted_bytes": 0,
        "kept": {},
        "samples": [],
        "max_age_hours": max_age_hours,
        "dry_run": dry_run,
    }

    chunks_root = os.path.join(settings.UPLOADS_DIR, ".chunks")
    if not os.path.isdir(chunks_root):
        return result

    now = now or dj_timezone.now()
    cutoff = (now - timedelta(hours=max_age_hours)).timestamp()

    kept: dict[str, int] = {}

    def _keep(reason: str) -> None:
        kept[reason] = kept.get(reason, 0) + 1

    try:
        entries = sorted(os.listdir(chunks_root))
    except OSError as exc:
        logger.error("Chunk staging sweep: cannot list %s: %s", chunks_root, exc)
        result["error"] = str(exc)
        return result

    for name in entries:
        path = os.path.join(chunks_root, name)
        if not os.path.isdir(path):
            _keep("not_a_directory")
            continue

        result["scanned"] += 1

        if not _is_uuid(name):
            # Same guard the chunk endpoints apply before touching a
            # request-derived path. Anything else here was not put there by the
            # upload flow, so it is not ours to remove.
            _keep("name_not_uuid")
            continue

        try:
            newest = _newest_mtime(path)
        except OSError as exc:
            logger.warning("Chunk staging sweep: cannot stat %s: %s", path, exc)
            _keep("stat_failed")
            continue

        if newest >= cutoff:
            _keep("still_recent")
            continue

        size = _dir_size_bytes(path)
        result["stale_dirs"] += 1
        result["stale_bytes"] += size
        if len(result["samples"]) < SAMPLE_LIMIT:
            result["samples"].append(name)

        if dry_run:
            continue

        try:
            shutil.rmtree(path)
        except OSError as exc:
            logger.warning("Chunk staging sweep: cannot remove %s: %s", path, exc)
            _keep("remove_failed")
            continue

        result["deleted_dirs"] += 1
        result["deleted_bytes"] += size

    result["kept"] = kept
    if result["deleted_dirs"]:
        logger.info(
            "Chunk staging sweep: removed %d abandoned dir(s), %d bytes",
            result["deleted_dirs"], result["deleted_bytes"],
        )
    return result
