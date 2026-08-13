"""
Durable record of the last garbage-collector sweep.

Why this exists: on 2026-08-13 the GC had not swept for over a week and nobody
noticed until the production disk hit 89%. 22 GB of expired exports and 17 GB of
uploads had accumulated, and establishing *that it had not run* took three
separate database queries — because there is no trace of a sweep anywhere:

  * The rich counters `garbage_collector_task` returns go only to the Celery log,
    which is discarded every time the container is recreated (three times in one
    afternoon during that incident).
  * The database keeps no evidence either, and misleadingly so: the sweep flags
    rows `is_deleted=True` and then hard-deletes those same tombstones later in
    the *same* run, so `ExportedResult.objects.filter(is_deleted=True).count()`
    reads 0 both before a run and after one. It looks like a "did it run?"
    signal and is not one.

So the sweep records itself here instead. One small JSON file, read back by
`CeleryMonitoringView`, which turns "has the GC run?" into a single ops call.

Deliberately a file under STORAGE_ROOT rather than a DB row:
  * `./storage` is bind-mounted, so it survives container recreation — the exact
    failure mode that lost the log evidence.
  * No migration, so this can ship to a production box with no schema risk.
  * Matches the existing on-disk-config convention (see `sku_layouts.json` in
    api/views.py): write `*.tmp`, then `os.replace` for an atomic swap.

Only *successful* runs are recorded. A crashed sweep writes nothing, so its
absence shows up as staleness — which is the condition an operator cares about.
Recording failures too would mean wrapping the task body and risking a change to
its retry semantics, for a weaker signal.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)

STATUS_FILENAME = "gc_last_run.json"


def status_path() -> str:
    """Resolved at call time, not import time, so tests can point STORAGE_ROOT elsewhere."""
    return os.path.join(settings.STORAGE_ROOT, STATUS_FILENAME)


def _stale_after_hours() -> int:
    return int(getattr(settings, "GC_STALE_AFTER_HOURS", 36))


def record_gc_run(stats: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Persist the timestamp + counters of a completed sweep. Returns True on write.

    Never raises. An audit record that can fail the sweep it is describing would
    be worse than no record at all — the same reasoning as the API audit
    middleware (see `api/middleware.py`).
    """
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    payload = {"last_run_at": stamp, "stats": stats}
    path = status_path()
    tmp_path = None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # NamedTemporaryFile in the SAME directory: os.replace is only atomic
        # within one filesystem, and /tmp is frequently a different mount.
        with tempfile.NamedTemporaryFile(
            mode="w", dir=os.path.dirname(path), prefix=f".{STATUS_FILENAME}.", suffix=".tmp", delete=False
        ) as fh:
            tmp_path = fh.name
            json.dump(payload, fh, indent=2, default=str)
        os.replace(tmp_path, path)
        return True
    except Exception as exc:
        logger.warning("Could not record GC run status at %s: %s", path, exc)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        return False


def read_gc_status(*, now: datetime | None = None) -> dict[str, Any]:
    """Report on the last recorded sweep, for the ops monitoring endpoint.

    `stale` is the field to alert on. It is True when no sweep has ever been
    recorded, when the record is unreadable, AND when the last one is older than
    GC_STALE_AFTER_HOURS — an unreadable record is not evidence of health.
    """
    threshold = _stale_after_hours()
    base: dict[str, Any] = {
        "last_run_at": None,
        "age_hours": None,
        "stale": True,
        "stale_after_hours": threshold,
        "stats": None,
    }

    path = status_path()
    try:
        with open(path, "r") as fh:
            payload = json.load(fh)
    except FileNotFoundError:
        base["detail"] = "No sweep has been recorded yet."
        return base
    except Exception as exc:
        base["detail"] = f"Status file unreadable: {exc}"
        return base

    raw = (payload or {}).get("last_run_at")
    try:
        last_run = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        base["detail"] = "Status file has no valid last_run_at."
        return base

    # A naive stamp would blow up the subtraction below; treat it as UTC, which
    # is what record_gc_run always writes.
    if last_run.tzinfo is None:
        last_run = last_run.replace(tzinfo=timezone.utc)

    age_hours = ((now or datetime.now(timezone.utc)) - last_run).total_seconds() / 3600.0
    return {
        "last_run_at": last_run.isoformat(),
        # Clamp the floor at 0: a clock skew between writer and reader should not
        # surface as a negative age that reads like corruption.
        "age_hours": round(max(age_hours, 0.0), 2),
        "stale": age_hours > threshold,
        "stale_after_hours": threshold,
        "stats": (payload or {}).get("stats"),
    }
