"""
TS ↔ Python parity for whether a calendar product carries holidays, and
which locale's.

The print decides in materialize_surfaces (holidaySource must be an object
with a truthy `enabled`; a missing locale means "generic"); the customer
preview decides with printedHolidayLocale in frontend/nextjs/src/lib/calendar.ts.
Both sides assert against the same fixture,
storage/parity-fixtures/calendar-holidays.json — until 2026-09-29 the
customer preview showed holidays for every calendar, including ones whose
print carried none.

Run stand-alone:
    cd backend/django && python -m services.tests.test_calendar_holidays_parity
"""
from __future__ import annotations

import json
import os
import sys
from unittest import mock

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402

from services import calendar_holidays  # noqa: E402
from services.calendar_layout import materialize_surfaces  # noqa: E402


def _cases() -> list[dict]:
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "calendar-holidays.json")
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Parity fixtures missing at {path}. Both this module and "
            "frontend/nextjs/src/lib/__tests__/calendar.parity.test.ts load from it."
        )
    with open(path) as f:
        return json.load(f)["cases"]


def _layout(calendar) -> dict:
    layout = {
        "name": "holiday_parity",
        "productType": "calendar",
        "canvas": {"width": 600, "height": 840, "dpi": 300},
        "frames": [{"id": "top", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.40}],
        "calendars": [{"x": 0.05, "y": 0.55, "width": 0.9, "height": 0.40}],
        "monthRange": {"count": 12, "defaultYear": 2027},
    }
    if calendar is not None:
        layout["calendar"] = calendar
    return layout


def _materialize(calendar) -> tuple[list[str], list[dict]]:
    """Run the print's materializer, recording which locales it loaded."""
    loaded: list[str] = []

    def fake_load(locale, year):
        loaded.append(locale)
        return [{"date": f"{year}-01-26", "name": f"{locale} holiday"}]

    with mock.patch.object(calendar_holidays, "load_holidays_for_year", side_effect=fake_load):
        surfaces = materialize_surfaces(_layout(calendar))
    return loaded, surfaces


def test_fixture_has_cases():
    assert len(_cases()) > 0


def test_print_holiday_gate_matches_fixture():
    for c in _cases():
        loaded, surfaces = _materialize(c["calendar"])
        carried = [h for s in surfaces for h in s["holidays"]]
        if c["expectedLocale"] is None:
            assert loaded == [], f"{c['name']}: loaded {loaded}, expected none"
            assert carried == [], f"{c['name']}: print carries {len(carried)} holidays"
        else:
            assert loaded and set(loaded) == {c["expectedLocale"]}, (
                f"{c['name']}: loaded {loaded}, expected {c['expectedLocale']}"
            )
            assert carried, f"{c['name']}: print carries no holidays"


if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} calendar_holidays_parity tests …")
    for name, fn in tests:
        try:
            fn()
            print(f"  OK  {name}")
        except Exception as e:
            print(f"  FAIL {name}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed} test(s) FAILED")
        sys.exit(1)
    print(f"\nAll {len(tests)} calendar_holidays_parity tests passed.")
