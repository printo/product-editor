"""
Disk-backed holiday loader for the server-side calendar renderer
(CALENDAR_FEATURE_PRD.md §11.9 + §11.11).

Reads `storage/holidays/<locale>/<year>.json` and returns the parsed
events list. Used at render time by `materialize_surfaces`, inside the
Celery worker.

Deliberately uncached. This used to sit behind a per-process
`lru_cache` keyed on path, but the files are rewritten in place by
`HolidaysView` PUT/DELETE (in gunicorn) and `scripts/refresh-holidays.py`
— neither of which can reach a worker process's memory. Each worker kept
printing the old holidays until it recycled, while the preview (served
through the view's Redis cache, which PUT/DELETE do clear) showed the new
ones. `materialize_surfaces` already loads each year once per render, so
at most two ~2 KB reads per job; the cache saved nothing worth that.

Falls back to an empty list on any disk-read error (file missing, JSON
broken, etc.) per PRD §11.9 — calendars rolling to a year without a
holiday file render with no auto-injection and no error.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Optional

from django.conf import settings

logger = logging.getLogger(__name__)

_LOCALE_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_HOLIDAYS_ROOT = os.path.join(settings.STORAGE_ROOT, "holidays")


def _safe_path(locale: str, year: int) -> Optional[str]:
    """Return the on-disk path for (locale, year), or None if inputs are unsafe."""
    if not isinstance(locale, str) or not _LOCALE_RE.fullmatch(locale):
        return None
    if not isinstance(year, int) or not (1900 <= year <= 2100):
        return None
    candidate = os.path.join(_HOLIDAYS_ROOT, locale, f"{year}.json")
    # Belt-and-braces: confirm the resolved path still lives under the
    # holidays root (the regex above already filters traversal chars).
    if not os.path.realpath(candidate).startswith(os.path.realpath(_HOLIDAYS_ROOT)):
        return None
    return candidate


def _read_holiday_file(path: str) -> list[dict]:
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Holiday file %s unreadable: %s", path, exc)
        return []
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        return []
    return [
        ev for ev in events
        if isinstance(ev, dict) and ev.get("date") and ev.get("name")
    ]


def load_holidays_for_year(locale: str, year: int) -> list[dict]:
    """
    Public API: return the events list for (locale, year), or [] on miss.

    Args:
        locale: e.g. "en-IN" or "generic". Validated for path safety.
        year:   1900..2100.

    Returns:
        A list of holiday dicts: { date, name, type?, color? }.
        Empty list when the file is missing, unreadable, or `events` is
        not a list. Never raises.
    """
    path = _safe_path(locale, year)
    if not path or not os.path.exists(path):
        return []
    return _read_holiday_file(path)
