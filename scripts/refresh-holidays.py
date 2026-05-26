#!/usr/bin/env python3
"""
Refresh holiday data from Nager.Date for the upcoming year(s).

Annual ops task (PRD §11.9). Pulls public holidays from https://date.nager.at/
and writes them to storage/holidays/<locale>/<year>.json. Preserves any
custom non-fixed dates already in the file (e.g. Holi, Diwali, Eid for
en-IN) — only the fixed national holidays get refreshed.

Usage:
    # Refresh the next year for en-IN (default behavior)
    python scripts/refresh-holidays.py

    # Refresh a specific year
    python scripts/refresh-holidays.py --year 2031

    # Refresh a different locale (Nager.Date country code, e.g. US, GB, AE)
    python scripts/refresh-holidays.py --locale en-IN --country IN

    # Dry-run (print what would change without writing)
    python scripts/refresh-holidays.py --dry-run

Run inside the backend container:
    docker-compose exec backend python /app/scripts/refresh-holidays.py

The Nager.Date API has no auth; rate limit is generous (no documented cap).
If the API is unreachable, the script exits with code 2 — re-run when the
network is up. Existing files are never deleted, only updated in-place.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError


# ── Paths ───────────────────────────────────────────────────────────────────

# Discover STORAGE_ROOT the same way Django settings does: look for an
# explicit env var, then fall back to repo-root/storage.
def _find_storage_root() -> Path:
    env = os.environ.get("STORAGE_ROOT")
    if env:
        return Path(env)
    here = Path(__file__).resolve().parent
    # repo root = scripts/.. (or /app/.. inside the container)
    candidates = [here.parent / "storage", Path("/app/storage")]
    for c in candidates:
        if c.is_dir():
            return c
    raise FileNotFoundError(
        "Could not locate the storage/ dir. Set STORAGE_ROOT or run from the repo root."
    )


STORAGE_ROOT = _find_storage_root()
HOLIDAYS_ROOT = STORAGE_ROOT / "holidays"


# ── Nager.Date pull ─────────────────────────────────────────────────────────

NAGER_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"

# Map our internal locale codes → Nager country codes. Add new locales here
# as Printo expands; the script falls back to using the locale verbatim if
# missing.
LOCALE_TO_COUNTRY = {
    "en-IN": "IN",
    "en-US": "US",
    "en-GB": "GB",
    "en-AE": "AE",
}

# Default fallback colors per holiday type. Ops can override these in the
# JSON file directly — the script only fills them in for newly-added events.
TYPE_COLOR_DEFAULTS = {
    "national": "#DC2626",
    "religious": "#10B981",
    "observance": "#3B82F6",
    "festival": "#F59E0B",
}


def fetch_nager(year: int, country: str) -> list[dict]:
    """Fetch Nager.Date public holidays. Returns [] on network error."""
    url = NAGER_URL.format(year=year, country=country)
    try:
        with urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except (URLError, json.JSONDecodeError, TimeoutError) as exc:
        print(f"[refresh-holidays] FAILED to fetch {url}: {exc}", file=sys.stderr)
        return []
    if not isinstance(data, list):
        print(f"[refresh-holidays] Unexpected response shape from {url}", file=sys.stderr)
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


# ── Merge ───────────────────────────────────────────────────────────────────

def merge_events(existing: list[dict], fetched: list[dict]) -> list[dict]:
    """
    Merge fetched events into existing, keyed by (date, name).

    Custom existing entries (non-Nager) survive untouched. Fetched entries
    add new dates and refresh the name/type/color of existing matches.
    """
    by_key = {(ev.get("date"), ev.get("name")): ev for ev in existing if ev.get("date")}
    for fresh in fetched:
        key = (fresh["date"], fresh["name"])
        by_key[key] = fresh
    return sorted(by_key.values(), key=lambda e: (e.get("date") or "", e.get("name") or ""))


# ── Main ────────────────────────────────────────────────────────────────────

def refresh(locale: str, year: int, country: str | None, dry_run: bool) -> int:
    country = country or LOCALE_TO_COUNTRY.get(locale)
    if not country:
        print(
            f"[refresh-holidays] No Nager.Date country mapping for locale {locale!r}. "
            f"Pass --country explicitly or add an entry to LOCALE_TO_COUNTRY.",
            file=sys.stderr,
        )
        return 2

    fetched_raw = fetch_nager(year, country)
    if not fetched_raw:
        print(f"[refresh-holidays] Nothing fetched for {locale}/{year} — aborting.", file=sys.stderr)
        return 2

    fetched = [e for e in (normalize_nager_event(r) for r in fetched_raw) if e]

    target_path = HOLIDAYS_ROOT / locale / f"{year}.json"
    target_path.parent.mkdir(parents=True, exist_ok=True)

    if target_path.exists():
        with open(target_path) as f:
            existing_payload = json.load(f)
        existing_events = list(existing_payload.get("events") or [])
    else:
        existing_payload = {"year": year, "locale": locale, "events": [], "_meta": {}}
        existing_events = []

    merged = merge_events(existing_events, fetched)

    new_count = len(merged) - len(existing_events)
    print(f"[refresh-holidays] {locale}/{year}: {len(existing_events)} existing + "
          f"{len(fetched)} fetched → {len(merged)} total ({new_count:+d}).")

    if dry_run:
        print("[refresh-holidays] --dry-run: skipping write.")
        return 0

    existing_payload["year"] = year
    existing_payload["locale"] = locale
    existing_payload["events"] = merged
    existing_payload.setdefault("_meta", {})
    existing_payload["_meta"]["lastRefreshed"] = datetime.utcnow().isoformat() + "Z"
    existing_payload["_meta"]["source"] = f"Nager.Date pull for country={country}; merged with existing."

    tmp_path = target_path.with_suffix(".json.tmp")
    with open(tmp_path, "w") as f:
        json.dump(existing_payload, f, indent=2, sort_keys=False)
    tmp_path.replace(target_path)
    print(f"[refresh-holidays] wrote {target_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Refresh holiday data from Nager.Date.")
    ap.add_argument("--locale", default="en-IN",
                    help="Our internal locale code (default: en-IN).")
    ap.add_argument("--country", default=None,
                    help="Nager.Date country code (e.g. IN). Auto-resolved from --locale by default.")
    ap.add_argument("--year", type=int, default=None,
                    help="Year to refresh. Defaults to next calendar year.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would change without writing the file.")
    args = ap.parse_args(argv)

    year = args.year or (date.today().year + 1)
    return refresh(args.locale, year, args.country, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
