"""
Annual holiday refresh (PRD §11.9) — the logic behind
`manage.py refresh_holidays`.

Source: the `holidays` package's offline public-holiday tables. It used to
be the Nager.Date API, which does not cover India (it answers HTTP 204 for
IN), so the en-IN refresh — the only locale that matters — never fetched a
single event. The 2027-2030 en-IN seeds were therefore left with fixed-date
holidays only: no Holi, Diwali, Good Friday or Eid.

Reads the existing locale/year through `asset_store` and writes through
`get_storage()`, the same path `HolidaysView` PUT uses, so under
STORAGE_BACKEND=s3 the refresh merges into and replaces the S3 object the
preview and the print actually read. The old `scripts/refresh-holidays.py`
read and wrote `storage/holidays/` on local disk only — under S3 that file
is just the git-seeded default, so the refresh was silently ignored, and on
the prod host it rewrote git-tracked files. (It also never ran in the
container: the backend image copies `backend/django` only, not `scripts/`.)

Custom entries survive a refresh (Pongal, New Year, anything ops added).
That is why existing data that can't be read aborts the refresh rather than
counting as empty: merging into nothing would overwrite the stored year
with the public holidays alone.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from typing import Callable

from services.asset_store import AssetNotFoundError, CalendarAssetUnavailable, read_asset_json
from services.calendar_holidays import _asset_name
from services.storage import get_storage

# Our internal locale codes → ISO country codes the `holidays` package knows.
# Add new locales here as Printo expands; otherwise pass --country explicitly.
LOCALE_TO_COUNTRY = {
    "en-IN": "IN",
    "en-US": "US",
    "en-GB": "GB",
    "en-AE": "AE",
}

# Default colors per holiday type. Ops can override these in the stored JSON —
# the refresh only sets them on the events it produces.
TYPE_COLOR_DEFAULTS = {
    "national": "#DC2626",
    "religious": "#10B981",
    "observance": "#3B82F6",
    "festival": "#F59E0B",
}

# The package's names → ours. Where the seeds already name a holiday, the
# names must match or a refresh adds a second pill on the same day ("Gandhi
# Jayanti" next to "Mahatma Gandhi's Jayanti"); the rest drop qualifiers that
# only crowd a calendar pill.
NAME_ALIASES = {
    "en-IN": {
        "Mahatma Gandhi's Jayanti": "Gandhi Jayanti",
        "Diwali (Deepavali)": "Diwali",
        "Id-ul-Zuha (Bakrid)": "Bakrid",
        "Janmashtami (Vaishnava)": "Janmashtami",
        "Guru Nanak's Jayanti": "Guru Nanak Jayanti",
        "Dr. B. R. Ambedkar's Jayanti": "Ambedkar Jayanti",
    },
}

# Holiday type by (aliased) name. Every event the package returns is a public
# holiday, so anything not listed is "national".
HOLIDAY_TYPES = {
    "en-IN": {
        "Ambedkar Jayanti": "observance",
        **dict.fromkeys(("Holi", "Diwali", "Dussehra", "Janmashtami", "Ram Navami",
                         "Maha Shivaratri"), "festival"),
        **dict.fromkeys(("Good Friday", "Christmas", "Id-ul-Fitr", "Bakrid", "Muharram",
                         "Milad-un-Nabi", "Mahavir Jayanti", "Buddha Purnima",
                         "Guru Nanak Jayanti"), "religious"),
    },
}

# The package's suffix on an Islamic holiday whose date depends on a future
# moon sighting. Dropped from the printed name; kept as `estimated: true`.
_ESTIMATED = re.compile(r"\s*\(estimated\)$")

# Process exit codes.
OK = 0
NOTHING_TO_DO = 2        # bad input, no country mapping, or no data for it
EXISTING_UNREADABLE = 3  # refusing to overwrite what we couldn't read


def _stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


def fetch_public_holidays(year: int, country: str, locale: str) -> list[dict]:
    """
    Public holidays for one country/year in our event schema
    ({date, name, type, color[, estimated]}). Returns [] for a country the
    package doesn't cover.
    """
    import holidays

    try:
        country_cls = holidays.country_holidays(country).__class__
    except NotImplementedError:
        _stderr(f"[refresh-holidays] No holiday data for country={country}.")
        return []
    languages = getattr(country_cls, "supported_languages", ()) or ()
    language = next((c for c in (locale.replace("-", "_"), "en_US") if c in languages), None)
    table = holidays.country_holidays(country, years=year, language=language)

    aliases = NAME_ALIASES.get(locale, {})
    types = HOLIDAY_TYPES.get(locale, {})
    events = []
    for day in sorted(table):
        # One entry per holiday — the package joins same-day names with "; ".
        for raw in table.get_list(day):
            name = _ESTIMATED.sub("", raw)
            name = aliases.get(name, name)
            evtype = types.get(name, "national")
            event = {
                "date": day.isoformat(),
                "name": name,
                "type": evtype,
                "color": TYPE_COLOR_DEFAULTS[evtype],
            }
            if _ESTIMATED.search(raw):
                event["estimated"] = True
            events.append(event)
    return events


def merge_events(existing: list[dict], fetched: list[dict]) -> list[dict]:
    """
    Merge fetched events into existing, keyed by (date, name).

    Custom existing entries survive untouched. Fetched entries add new dates
    and refresh the type/color of existing matches.
    """
    by_key = {(ev.get("date"), ev.get("name")): ev
              for ev in existing if isinstance(ev, dict) and ev.get("date")}
    for fresh in fetched:
        by_key[(fresh["date"], fresh["name"])] = fresh
    return sorted(by_key.values(), key=lambda e: (e.get("date") or "", e.get("name") or ""))


def _date_conflicts(existing: list[dict], fetched: list[dict]) -> list[str]:
    """Names the stored year has on a day the source doesn't — usually a
    wrong date (the 2026 seed puts Diwali on Nov 4; it's Nov 8). Both are
    kept, since the stored one may be deliberate; ops resolves it."""
    fetched_days: dict[str, set[str]] = {}
    for ev in fetched:
        fetched_days.setdefault(ev["name"], set()).add(ev["date"])
    return [
        f"{ev['name']}: stored on {ev['date']}, source says {', '.join(sorted(fetched_days[ev['name']]))}"
        for ev in existing
        if isinstance(ev, dict) and ev.get("name") in fetched_days
        and ev.get("date") not in fetched_days[ev["name"]]
    ]


def refresh(
    locale: str,
    year: int,
    country: str | None = None,
    dry_run: bool = False,
    *,
    fetch: Callable[[int, str, str], list[dict]] = fetch_public_holidays,
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
        err(f"[refresh-holidays] No country mapping for locale {locale!r}. "
            f"Pass --country explicitly or add an entry to LOCALE_TO_COUNTRY.")
        return NOTHING_TO_DO

    fetched = fetch(year, country, locale)
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
    for conflict in _date_conflicts(existing_events, fetched):
        err(f"[refresh-holidays] WARNING {conflict} — kept both; remove the wrong one "
            f"via PUT /api/ops/holidays/{name}.")

    if dry_run:
        for ev in merged:
            out(f"    {ev.get('date')}  {ev.get('name')}"
                f"{'  (estimated)' if ev.get('estimated') else ''}")
        out("[refresh-holidays] --dry-run: skipping write.")
        return OK

    import holidays

    payload["year"] = year
    payload["locale"] = locale
    payload["events"] = merged
    meta = payload.setdefault("_meta", {})
    meta["lastRefreshed"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    meta["source"] = (f"holidays {holidays.__version__} public holidays for country={country}; "
                      f"merged with existing.")

    where = get_storage().write_calendar_asset(
        "holidays", name, json.dumps(payload, indent=2, sort_keys=False).encode("utf-8"),
    )
    out(f"[refresh-holidays] wrote {where}")
    return OK
