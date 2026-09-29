"""
TS ↔ Python parity for the calendar's year: monthRange.defaultYear +
calendarType + today → which months the product covers.

The print resolves it here (resolve_default_year via materialize_surfaces,
whose displayLabel names the ZIP files); the customer preview, the leap-day
toast and the ops editor resolve it with resolveDefaultYear / yearOfMonth in
frontend/nextjs/src/lib/calendar.ts. Both sides assert against the same
fixture, storage/parity-fixtures/calendar-year.json — until 2026-09-29 the
preview ignored a year ops pinned and showed today's instead.

Run stand-alone:
    cd backend/django && python -m services.tests.test_calendar_year_parity
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date
from unittest import mock

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402

from services import calendar_layout  # noqa: E402
from services.calendar_layout import materialize_surfaces, resolve_default_year  # noqa: E402


def _cases() -> list[dict]:
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "calendar-year.json")
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Parity fixtures missing at {path}. Both this module and "
            "frontend/nextjs/src/lib/__tests__/calendar.parity.test.ts load from it."
        )
    with open(path) as f:
        return json.load(f)["cases"]


def _layout(default_year) -> dict:
    return {
        "name": "year_parity",
        "productType": "calendar",
        "canvas": {"width": 600, "height": 840, "dpi": 300},
        "frames": [{"id": "top", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.40}],
        "calendars": [{"x": 0.05, "y": 0.55, "width": 0.9, "height": 0.40}],
        "calendar": {"themePreset": "modern-minimalist", "calendarType": "english", "weekStart": "sunday"},
        "monthRange": {"count": 12, "defaultYear": default_year},
    }


def test_fixture_has_cases():
    assert len(_cases()) > 0


def test_resolve_default_year_matches_fixture():
    for c in _cases():
        got = resolve_default_year(c["defaultYear"], c["calendarType"], date.fromisoformat(c["today"]))
        assert got == c["expectedBaseYear"], f"{c['name']}: {got} != {c['expectedBaseYear']}"


def test_print_month_labels_match_fixture():
    # The print path: materialize_surfaces reads today from today_ist(), so pin it.
    for c in _cases():
        with mock.patch.object(calendar_layout, "today_ist", return_value=date.fromisoformat(c["today"])):
            surfaces = materialize_surfaces(
                _layout(c["defaultYear"]), calendar_type_override=c["calendarType"],
            )
        labels = [s["displayLabel"] for s in surfaces]
        february = next(s["displayLabel"] for s in surfaces if s["month"] == 2)
        assert labels[0] == c["expectedFirstLabel"], f"{c['name']}: first {labels[0]}"
        assert labels[-1] == c["expectedLastLabel"], f"{c['name']}: last {labels[-1]}"
        assert february == c["expectedFebruaryLabel"], f"{c['name']}: February {february}"


if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} calendar_year_parity tests …")
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
    print(f"\nAll {len(tests)} calendar_year_parity tests passed.")
