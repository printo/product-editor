"""
Holiday loader for the server-side calendar renderer
(CALENDAR_FEATURE_PRD.md §11.9 + §11.11).

Returns the events list from the `holidays/<locale>/<year>` calendar asset.
Used at render time by `materialize_surfaces`, inside the Celery worker.

Reads through `services.asset_store`, the same function `HolidaysView` GET
uses to feed the editor preview, so preview and print resolve one source:
local disk, or S3 under `STORAGE_BACKEND=s3`. It used to open the local
file directly, which under S3 would have printed stale holidays while the
preview showed the ops edit.

Deliberately uncached. This used to sit behind a per-process
`lru_cache` keyed on path, but the files are rewritten in place by
`HolidaysView` PUT/DELETE (in gunicorn) and `manage.py refresh_holidays`
— neither of which can reach a worker process's memory. Each worker kept
printing the old holidays until it recycled, while the preview (served
through the view's Redis cache, which PUT/DELETE do clear) showed the new
ones. `materialize_surfaces` already loads each year once per render, so
at most two ~2 KB reads per job; the cache saved nothing worth that.

Falls back to an empty list when the asset is missing or deleted, or its
JSON is broken, per PRD §11.9 — calendars rolling to a year without a
holiday file render with no auto-injection and no error. The one exception
is a store that couldn't answer (`CalendarAssetUnavailable`, e.g. an S3
outage): that propagates, so `render_canvas_task` retries and, if S3 stays
down, fails visibly. Degrading it to [] would print a calendar with no
holidays for a year that has them.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from services.asset_store import AssetNotFoundError, CalendarAssetUnavailable, read_asset_json

logger = logging.getLogger(__name__)

# No '.' or '/', so a locale can never step outside holidays/.
_LOCALE_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _asset_name(locale: str, year: int) -> Optional[str]:
    """Return the asset name for (locale, year), or None if inputs are unsafe."""
    if not isinstance(locale, str) or not _LOCALE_RE.fullmatch(locale):
        return None
    if not isinstance(year, int) or not (1900 <= year <= 2100):
        return None
    return f"{locale}/{year}"


def _valid_events(data) -> list[dict]:
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
        Empty list when the asset is missing, corrupt, or `events` is
        not a list.

    Raises:
        CalendarAssetUnavailable: the store couldn't say whether the asset
        exists. Everything else degrades to [].
    """
    name = _asset_name(locale, year)
    if not name:
        return []
    try:
        data = read_asset_json("holidays", name)
    except AssetNotFoundError:
        return []
    except CalendarAssetUnavailable:
        raise
    except Exception as exc:
        logger.warning("Holidays %s unreadable: %s", name, exc)
        return []
    return _valid_events(data)
