"""
Disk-backed holiday loader for the server-side calendar renderer
(CALENDAR_FEATURE_PRD.md §11.9 + §11.11).

Reads `storage/holidays/<locale>/<year>.json` and returns the parsed
events list, with a per-process cache so 12 surfaces in a single render
job don't all read the same file 12 times.

Stays decoupled from Django's REST layer — both `materialize_surfaces`
(at render time, no HTTP) and `HolidaysView` (the public endpoint)
can call into this. The HTTP-layer Redis cache lives in the view; this
module's in-process cache is independent and process-local.

Falls back to an empty list on any disk-read error (file missing, JSON
broken, etc.) per PRD §11.9 — calendars rolling to a year without a
holiday file render with no auto-injection and no error.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from functools import lru_cache
from typing import Optional

from django.conf import settings

logger = logging.getLogger(__name__)

_LOCALE_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_HOLIDAYS_ROOT = os.path.join(settings.STORAGE_ROOT, "holidays")

# Process-local cache. Holiday files are small (10-30 events × ~100 bytes)
# and change at most once a year, so we can hold every (locale, year) we
# touch for the lifetime of the worker. Bounded by the underlying lru_cache.
_CACHE_LOCK = threading.Lock()


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


@lru_cache(maxsize=128)
def _read_holiday_file(path: str) -> tuple:
    """LRU-cached disk read. Returns a tuple so the value is hashable / immutable."""
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Holiday file %s unreadable: %s", path, exc)
        return ()
    events = data.get("events") or []
    if not isinstance(events, list):
        return ()
    # Freeze each event into an immutable dict-like shape (we use a frozenset
    # of items to make tuples hashable, but consumers want dicts back). We
    # serialise to JSON tuples here and rebuild dicts on the way out so the
    # cache stays cheap to lookup.
    out = tuple(
        json.dumps(ev, sort_keys=True) for ev in events
        if isinstance(ev, dict) and ev.get("date") and ev.get("name")
    )
    return out


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
    # The cache stores JSON strings; deserialise per call. JSON-decoding ~20
    # short objects is well under a millisecond — cheaper than holding
    # mutable dicts in the cache and risking external mutation.
    raw = _read_holiday_file(path)
    return [json.loads(s) for s in raw]


def invalidate_cache() -> None:
    """Clear the holiday-file cache. Called after PUT/DELETE in HolidaysView."""
    with _CACHE_LOCK:
        _read_holiday_file.cache_clear()
