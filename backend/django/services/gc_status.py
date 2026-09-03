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
  * Matches the existing on-disk-config convention (see `fonts.json` in
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


MAX_ERROR_CHARS = 500


def _read_payload() -> dict[str, Any]:
    """Current record, or {} when absent/unreadable. Never raises."""
    try:
        with open(status_path(), "r") as fh:
            payload = json.load(fh)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _write_payload(payload: dict[str, Any]) -> bool:
    """Atomically replace the record. Never raises; returns True on write."""
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
        logger.warning("Could not write GC status at %s: %s", path, exc)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        return False


def record_gc_run(stats: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Persist the timestamp + counters of a COMPLETED sweep. Returns True on write.

    Merges rather than overwrites, so a previous failure's error survives a later
    success. An operator wants to see "succeeded an hour ago, but failed at 02:00
    with this error" — overwriting would hide the pattern that matters.

    Never raises. An audit record that can fail the sweep it is describing would
    be worse than no record at all — the same reasoning as the API audit
    middleware (see `api/middleware.py`).
    """
    payload = _read_payload()
    payload["last_run_at"] = (now or datetime.now(timezone.utc)).isoformat()
    payload["stats"] = stats
    return _write_payload(payload)


def record_gc_failure(error: BaseException | str, *, now: datetime | None = None) -> bool:
    """Persist that a sweep ATTEMPT failed, and why.

    The first version of this module recorded only successful runs, on the
    reasoning that a crash would surface as growing staleness. It does — but
    staleness cannot tell you *why*, and it reads identically to "never ran".

    That ambiguity is expensive. On 2026-08-14 it let two successive wrong root
    causes stand for two days — first "beat is not firing", then "the task dies
    on a stale DB connection" — when the sweep had in fact run and succeeded in
    0.19s each night, and the real issue was that 02:00 UTC lands just *before*
    the daily expiry wave. Every one of those wrong turns was a guess made
    because the failure path recorded nothing to read.

    Wired via the task_failure signal in api/tasks.py rather than a try/except
    around the sweep body, so the task's own retry semantics are untouched.
    """
    if isinstance(error, BaseException):
        detail = f"{type(error).__name__}: {error}"
    else:
        detail = str(error)
    payload = _read_payload()
    payload["last_failure_at"] = (now or datetime.now(timezone.utc)).isoformat()
    payload["last_error"] = detail[:MAX_ERROR_CHARS]
    return _write_payload(payload)


def _parse_stamp(raw: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    # A naive stamp would blow up the subtractions below; treat it as UTC, which
    # is what this module always writes.
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def read_gc_status(*, now: datetime | None = None) -> dict[str, Any]:
    """Report on the last recorded sweep, for the ops monitoring endpoint.

    Two fields to alert on, and they answer different questions:

      stale   — no SUCCESSFUL sweep recently. True when none has ever been
                recorded, when the record is unreadable, and when the last one is
                older than GC_STALE_AFTER_HOURS. An unreadable record is not
                evidence of health.
      failing — the most recent attempt FAILED, with `last_error` saying how.
                Distinguishes "the sweep is broken" from "the sweep is not being
                scheduled", which took hours to tell apart on 2026-08-14 because
                only successes were recorded.

    A sweep can be `failing` while not yet `stale` (it broke a few hours ago but
    succeeded within the window), so alert on either.
    """
    threshold = _stale_after_hours()
    base: dict[str, Any] = {
        "last_run_at": None,
        "age_hours": None,
        "stale": True,
        "stale_after_hours": threshold,
        "stats": None,
        "last_failure_at": None,
        "last_error": None,
        "failing": False,
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

    payload = payload if isinstance(payload, dict) else {}
    last_run = _parse_stamp(payload.get("last_run_at"))
    last_failure = _parse_stamp(payload.get("last_failure_at"))

    result = dict(base)
    if last_failure is not None:
        result["last_failure_at"] = last_failure.isoformat()
        result["last_error"] = payload.get("last_error")

    if last_run is None:
        # A failure recorded with no successful run is the "broken from the
        # start" case — report the error rather than the bare no-record message.
        result["detail"] = (
            "Sweeps are failing; none has ever completed." if last_failure is not None
            else "Status file has no valid last_run_at."
        )
        result["failing"] = last_failure is not None
        return result

    reference = now or datetime.now(timezone.utc)
    age_hours = (reference - last_run).total_seconds() / 3600.0
    result.update({
        "last_run_at": last_run.isoformat(),
        # Clamp the floor at 0: a clock skew between writer and reader should not
        # surface as a negative age that reads like corruption.
        "age_hours": round(max(age_hours, 0.0), 2),
        "stale": age_hours > threshold,
        "stats": payload.get("stats"),
        # Most recent event was a failure — the sweep is broken right now even if
        # an earlier success is still inside the staleness window.
        "failing": last_failure is not None and last_failure > last_run,
    })
    return result
