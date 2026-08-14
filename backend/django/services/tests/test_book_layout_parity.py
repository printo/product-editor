"""
TS<->Python parity test for the book/booklet layout math
(BOOK_LAYOUT_PRD.md §5.3).

Loads the same fixtures file that
frontend/nextjs/src/lib/__tests__/book-layout.parity.test.ts asserts
against. If either side drifts from the shared ground truth, exactly one
of the two suites fails and you know which.

Run with:
    cd backend/django && python -m services.tests.test_book_layout_parity
"""
from __future__ import annotations

import json
import os
import sys

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from services.book_layout import (  # noqa: E402
    display_label_for,
    gutter_shift_fraction,
    gutter_side_for,
    resolve_page_count,
    spine_width_mm,
)

# Fixtures live under storage/parity-fixtures/ — resolved via
# settings.STORAGE_ROOT (same technique as test_calendar_renderer.py) so
# this works both on the host and inside Docker, where ./storage is
# volume-mounted at /app/storage.

def _load_fixtures() -> dict:
    from django.conf import settings
    path = os.path.join(settings.STORAGE_ROOT, 'parity-fixtures', 'book-layout.json')
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"Parity fixtures missing at {path}. Both this test and "
            "src/lib/__tests__/book-layout.parity.test.ts load from this "
            "path — re-add the file before running."
        )
    with open(path, 'r') as f:
        return json.load(f)


def _layout_for(case: dict) -> dict:
    return {
        "productType": "book",
        "book": {
            "pageCount": {
                "min": case["min"], "max": case["max"],
                "step": case["step"], "default": case["default"],
            },
        },
    }


def test_page_count_cases_match_fixtures():
    fixtures = _load_fixtures()
    for case in fixtures["pageCountCases"]:
        got = resolve_page_count(_layout_for(case), case["requested"])
        assert got == case["expected"], f"{case['name']}: got {got}, expected {case['expected']}"


def test_gutter_side_cases_match_fixtures():
    fixtures = _load_fixtures()
    for case in fixtures["gutterSideCases"]:
        got = gutter_side_for(case["pageIndex"])
        assert got == case["expected"], f"page {case['pageIndex']}: got {got}, expected {case['expected']}"


def test_gutter_shift_cases_match_fixtures():
    fixtures = _load_fixtures()
    for case in fixtures["gutterShiftCases"]:
        got = gutter_shift_fraction(
            case["frames"], case["overlays"], case["gutterMm"],
            case["canvasWidthMm"], case["gutterSide"],
        )
        assert abs(got - case["expectedShift"]) < 1e-9, (
            f"{case['name']}: got {got}, expected {case['expectedShift']}"
        )


def test_spine_width_cases_match_fixtures():
    fixtures = _load_fixtures()
    for case in fixtures["spineWidthCases"]:
        got = spine_width_mm(case["pageCount"], case["paperThicknessMm"], case["coverThicknessMm"])
        assert abs(got - case["expected"]) < 1e-9, f"{case['name']}: got {got}, expected {case['expected']}"


def test_display_label_cases_match_fixtures():
    fixtures = _load_fixtures()
    for case in fixtures["displayLabelCases"]:
        got = display_label_for(case["role"], case["pageIndex"], case["ordinal"], case["total"])
        assert got == case["expected"], f"got {got!r}, expected {case['expected']!r}"


# ── Stand-alone runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} book_layout parity tests …")
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
    print(f"\nAll {len(tests)} book_layout parity tests passed.")
