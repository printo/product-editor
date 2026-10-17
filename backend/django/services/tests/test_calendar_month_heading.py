"""
The month name ("January 2026") printed above each calendar block's grid.

Until 2026-10-17 the print had no month name at all: render_calendar drew
only the weekday row and the dates, while the customer's month tiles
labelled each month, so a printed page never said which month it was.

The on/off rule and the label are pinned against the same fixture the
customer preview uses (storage/parity-fixtures/calendar-month-heading.json,
read by frontend/nextjs/src/lib/__tests__/calendar.parity.test.ts).

Run stand-alone:
    cd backend/django && python -m services.tests.test_calendar_month_heading
"""
from __future__ import annotations

import json
import os
import sys

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402
from PIL import Image  # noqa: E402

from services.calendar_renderer import (  # noqa: E402
    MONTH_HEADING_FRACTION,
    month_heading_enabled,
    month_heading_text,
    render_calendar,
)


def _fixture() -> dict:
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "calendar-month-heading.json")
    with open(path) as f:
        return json.load(f)


BLOCK = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
SIZE = 1200


def _render(style: dict) -> Image.Image:
    canvas = Image.new("RGB", (SIZE, SIZE), "white")
    return render_calendar(canvas, BLOCK, year=2026, month=1, style=style)


def _dark_pixels(img: Image.Image, box: tuple[int, int, int, int]) -> int:
    """Count near-black pixels (the default monthText is #18181B)."""
    region = img.crop(box).convert("L")
    return sum(1 for v in region.getdata() if v < 80)


def test_enabled_rule_matches_fixture():
    for c in _fixture()["cases"]:
        assert month_heading_enabled(c["calendar"]) is c["expected"], c["name"]


def test_label_matches_fixture():
    for c in _fixture()["labels"]:
        assert month_heading_text(c["year"], c["month"]) == c["text"]


def test_heading_prints_in_the_top_band_by_default():
    band = int(SIZE * MONTH_HEADING_FRACTION)
    dark = _dark_pixels(_render({}), (0, 0, SIZE, band))
    assert dark > 500, f"expected the month name in the top band, found {dark} dark pixels"


def test_heading_is_centred():
    band = int(SIZE * MONTH_HEADING_FRACTION)
    img = _render({})
    left = _dark_pixels(img, (0, 0, SIZE // 2, band))
    right = _dark_pixels(img, (SIZE // 2, 0, SIZE, band))
    assert left and right and 0.6 < left / right < 1.6, (left, right)


def test_switched_off_leaves_the_top_band_for_the_weekday_row():
    # Without a heading the weekday row sits in the top 10%, so nothing
    # black is drawn there (weekday labels are grey #71717A).
    weekday_band = int(SIZE * 0.10) - 2
    off = _render({"showMonthName": False})
    assert _dark_pixels(off, (0, 0, SIZE, weekday_band)) == 0


def test_grid_moves_down_to_make_room():
    band = int(SIZE * MONTH_HEADING_FRACTION)
    header_h = int(SIZE * 0.10)
    on = _render({}).convert("L")
    off = _render({"showMonthName": False}).convert("L")
    # The header underline (grid colour #E5E5E5) sits one pixel above the grid.
    assert on.getpixel((SIZE // 2, band + header_h - 1)) < 250
    assert off.getpixel((SIZE // 2, header_h - 1)) < 250


def test_monthtitle_overlay_layouts_do_not_double_print():
    img = _render({"monthTitle": {"enabled": True}})
    assert _dark_pixels(img, (0, 0, SIZE, int(SIZE * 0.10) - 2)) == 0


if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} calendar_month_heading tests …")
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
    print(f"\nAll {len(tests)} calendar_month_heading tests passed.")
