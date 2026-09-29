"""
Annual holiday refresh from Nager.Date (PRD §11.9) — the logic behind
`manage.py refresh_holidays`.

Reads the existing locale/year through `asset_store` and writes through
`get_storage()`, the same path `HolidaysView` PUT uses, so under
STORAGE_BACKEND=s3 the refresh merges into and replaces the S3 object the
preview and the print actually read. It used to be
`scripts/refresh-holidays.py`, which read and wrote `storage/holidays/` on
local disk only. Under S3 that file is just the git-seeded default, so once
ops had PUT a year the refresh was silently ignored for it — and on the prod
host it rewrote git-tracked files. (It also never ran in the container:
the backend image copies `backend/django` only, not `scripts/`.)

Custom entries survive a refresh (Holi, Diwali, Eid and anything ops added
aren't in Nager.Date). That is why existing data that can't be read aborts
the refresh rather than counting as empty: merging into nothing would
overwrite the stored year with the national holidays alone.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Callable
from urllib.error import URLError
from urllib.request import urlopen

from services.asset_store import AssetNotFoundError, CalendarAssetUnavailable, read_asset_json
from services.calendar_holidays import _asset_name
from services.storage import get_storage

NAGER_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"

# Map our internal locale codes → Nager country codes. Add new locales here
# as Printo expands; otherwise pass --country explicitly.
LOCALE_TO_COUNTRY = {
    "en-IN": "IN",
    "en-US": "US",
    "en-GB": "GB",
    "en-AE": "AE",
}

# Default fallback colors per holiday type. Ops can override these in the
# stored JSON — the refresh only fills them in for fetched events.
TYPE_COLOR_DEFAULTS = {
    "national": "#DC2626",
    "religious": "#10B981",
    "observance": "#3B82F6",
    "festival": "#F59E0B",
}

# Process exit codes.
OK = 0
NOTHING_TO_DO = 2       # bad input, no country mapping, or Nager.Date unreachable
EXISTING_UNREADABLE = 3  # refusing to overwrite what we couldn't read


def _stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


def fetch_nager(year: int, country: str) -> list[dict]:
    """Fetch Nager.Date public holidays. Returns [] on network error."""
    url = NAGER_URL.format(year=year, country=country)
    try:
        with urlopen(url, timeout=15) as resp:
            if resp.status == 204:
                # Nager.Date's answer for a country it doesn't cover — India
                # (IN) among them, so en-IN can't be refreshed from here.
                _stderr(f"[refresh-holidays] Nager.Date has no data for country={country} "
                        f"(HTTP 204 — not a supported country).")
                return []
            data = json.loads(resp.read().decode())
    except (URLError, json.JSONDecodeError, TimeoutError) as exc:
        _stderr(f"[refresh-holidays] FAILED to fetch {url}: {exc}")
        return []
    if not isinstance(data, list):
        _stderr(f"[refresh-holidays] Unexpected response shape from {url}")
        return []
    return data


def normalize_nager_event(entry: dict) -> dict | None:
    """Map a Nager.Date event into our schema."""
    date_str = entry.get("date")
    name = entry.get("localName") or entry.get("name")
    if not date_str or not name:
        return None
    # Nager.Date's "types" field is a list; we pick the most specific.
    nager_types = entry.get("types") or []
    if "Public" in nager_types:
        evtype = "national"
    elif "Bank" in nager_types:
        evtype = "observance"
    elif "School" in nager_types:
        evtype = "observance"
    elif "Religious" in nager_types:
        evtype = "religious"
    else:
        evtype = "observance"
    return {
        "date": date_str,
        "name": name,
        "type": evtype,
        "color": TYPE_COLOR_DEFAULTS.get(evtype, "#3B82F6"),
    }


def merge_events(existing: list[dict], fetched: list[dict]) -> list[dict]:
    """
    Merge fetched events into existing, keyed by (date, name).

    Custom existing entries (non-Nager) survive untouched. Fetched entries
    add new dates and refresh the name/type/color of existing matches.
    """
    by_key = {(ev.get("date"), ev.get("name")): ev
              for ev in existing if isinstance(ev, dict) and ev.get("date")}
    for fresh in fetched:
        by_key[(fresh["date"], fresh["name"])] = fresh
    return sorted(by_key.values(), key=lambda e: (e.get("date") or "", e.get("name") or ""))


def refresh(
    locale: str,
    year: int,
    country: str | None = None,
    dry_run: bool = False,
    *,
    fetch: Callable[[int, str], list[dict]] = fetch_nager,
    out: Callable[[str], None] = print,
    err: Callable[[str], None] = _stderr,
) -> int:
    """Refresh one locale/year. Returns a process exit code (see OK etc.)."""
    name = _asset_name(locale, year)
    if not name:
        err(f"[refresh-holidays] Invalid locale/year {locale!r}/{year!r}.")
        return NOTHING_TO_DO

    country = country or LOCALE_TO_COUNTRY.get(locale)
    if not country:
        err(f"[refresh-holidays] No Nager.Date country mapping for locale {locale!r}. "
            f"Pass --country explicitly or add an entry to LOCALE_TO_COUNTRY.")
        return NOTHING_TO_DO

    fetched = [e for e in (normalize_nager_event(r) for r in fetch(year, country)
                           if isinstance(r, dict)) if e]
    if not fetched:
        err(f"[refresh-holidays] Nothing fetched for {name} — aborting.")
        return NOTHING_TO_DO

    try:
        payload = read_asset_json("holidays", name)
    except AssetNotFoundError:
        # Never written, no seed — or deleted by ops. An explicit refresh
        # re-creates it.
        payload = {"year": year, "locale": locale, "events": [], "_meta": {}}
    except (CalendarAssetUnavailable, ValueError) as exc:
        err(f"[refresh-holidays] Can't read the existing {name} ({exc}); not overwriting it — "
            f"its custom entries would be lost. Fix the read and re-run.")
        return EXISTING_UNREADABLE
    if not isinstance(payload, dict) or not isinstance(payload.get("events") or [], list):
        err(f"[refresh-holidays] Existing {name} isn't a holiday file ({{events: [...]}}); "
            f"not overwriting it.")
        return EXISTING_UNREADABLE
    existing_events = list(payload.get("events") or [])

    merged = merge_events(existing_events, fetched)
    out(f"[refresh-holidays] {name}: {len(existing_events)} existing + {len(fetched)} fetched "
        f"→ {len(merged)} total ({len(merged) - len(existing_events):+d}).")

    if dry_run:
        out("[refresh-holidays] --dry-run: skipping write.")
        return OK

    payload["year"] = year
    payload["locale"] = locale
    payload["events"] = merged
    meta = payload.setdefault("_meta", {})
    meta["lastRefreshed"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    meta["source"] = f"Nager.Date pull for country={country}; merged with existing."

    where = get_storage().write_calendar_asset(
        "holidays", name, json.dumps(payload, indent=2, sort_keys=False).encode("utf-8"),
    )
    out(f"[refresh-holidays] wrote {where}")
    return OK
