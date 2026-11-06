"""
A photo placed on a calendar date: fill or fit, quarter turns, blurred sides.

Until 2026-11-06 the print always centre-cropped the photo to fill the cell
and the customer had no say. The date editor now stores `fit`, `rotation`
and `blur` on the cell's image entry; an entry without them prints as before.

The reading of those keys and the box the photo is fitted into are pinned
against the fixture the editor uses (storage/parity-fixtures/
calendar-cell-image.json, read by frontend/nextjs/src/lib/__tests__/
calendar.parity.test.ts). The pixel tests draw real cells.

Run stand-alone:
    cd backend/django && python -m services.tests.test_calendar_cell_image
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402
from PIL import Image  # noqa: E402

from services.calendar_renderer import (  # noqa: E402
    _draw_cell_image,
    cell_image_box,
    cell_image_placement,
)

RED = (220, 30, 30, 255)
BLUE = (30, 30, 220, 255)
BOX = 200  # a square cell box, no padding


def _fixture() -> dict:
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "calendar-cell-image.json")
    with open(path) as f:
        return json.load(f)


def _photo(tmp: str, w: int, h: int, split: str) -> str:
    """A two-colour photo: red then blue, left to right ('lr') or top to bottom ('tb')."""
    img = Image.new("RGB", (w, h), RED[:3])
    if split == "lr":
        img.paste(BLUE[:3], (w // 2, 0, w, h))
    else:
        img.paste(BLUE[:3], (0, h // 2, w, h))
    path = os.path.join(tmp, f"photo_{w}x{h}_{split}.png")
    img.save(path)
    return path


def _draw(path: str, **placement) -> Image.Image:
    strip = Image.new("RGBA", (BOX, BOX), (0, 0, 0, 0))
    _draw_cell_image(
        strip, {"type": "image", "uploadId": "u1", **placement},
        cx0=0, cy0=0, cx1=BOX, cy1=BOX, pad=0, uploaded_files={"u1": path},
    )
    return strip


def _close(px, colour, tol=12) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px[:3], colour[:3]))


def test_placement_matches_fixture():
    for case in _fixture()["placements"]:
        assert cell_image_placement(case["entry"]) == case["expected"], case["name"]


def test_box_matches_fixture():
    for case in _fixture()["boxes"]:
        got = cell_image_box(case["width"], case["height"], case["rows"], case["heading"])
        assert all(abs(g - e) < 1e-9 for g, e in zip(got, case["expected"])), (case["name"], got)


def test_default_is_the_old_centre_crop():
    with tempfile.TemporaryDirectory() as tmp:
        wide = _photo(tmp, 800, 200, "lr")
        plain = _draw(wide)
        explicit = _draw(wide, fit="cover", rotation=0, blur=False, panX=0, panY=0)
        assert plain.tobytes() == explicit.tobytes()
        # A 4:1 photo fills a square cell: opaque to every edge, sides cropped away.
        assert plain.getpixel((2, 2))[3] == 255 and plain.getpixel((BOX - 3, BOX - 3))[3] == 255
        assert _close(plain.getpixel((10, 100)), RED) and _close(plain.getpixel((190, 100)), BLUE)


def test_fit_shows_the_whole_photo_and_leaves_the_sides_empty():
    with tempfile.TemporaryDirectory() as tmp:
        out = _draw(_photo(tmp, 800, 200, "lr"), fit="contain")
        # 800x200 fitted into 200x200 is a 200x50 band across the middle.
        assert out.getpixel((100, 20))[3] == 0 and out.getpixel((100, 180))[3] == 0
        assert _close(out.getpixel((5, 100)), RED) and _close(out.getpixel((195, 100)), BLUE)
        assert out.getpixel((5, 100))[3] == 255


def test_blur_fills_the_sides_of_a_fitted_photo():
    with tempfile.TemporaryDirectory() as tmp:
        out = _draw(_photo(tmp, 800, 200, "lr"), fit="contain", blur=True)
        top_left, top_right = out.getpixel((10, 10)), out.getpixel((190, 10))
        assert top_left[3] == 255 and top_right[3] == 255
        assert top_left[0] > top_left[2] and top_right[2] > top_right[0]
        # The photo itself stays sharp on top.
        assert _close(out.getpixel((5, 100)), RED)


def test_blur_is_ignored_on_a_filled_cell():
    with tempfile.TemporaryDirectory() as tmp:
        wide = _photo(tmp, 800, 200, "lr")
        assert _draw(wide, blur=True).tobytes() == _draw(wide).tobytes()


def test_a_quarter_turn_is_clockwise():
    with tempfile.TemporaryDirectory() as tmp:
        # Red on top, blue below. Turned clockwise the top goes to the right.
        tall = _photo(tmp, 200, 200, "tb")
        once = _draw(tall, rotation=90)
        assert _close(once.getpixel((190, 100)), RED) and _close(once.getpixel((10, 100)), BLUE)
        thrice = _draw(tall, rotation=270)
        assert _close(thrice.getpixel((10, 100)), RED) and _close(thrice.getpixel((190, 100)), BLUE)
        twice = _draw(tall, rotation=180)
        assert _close(twice.getpixel((100, 190)), RED) and _close(twice.getpixel((100, 10)), BLUE)


def test_a_move_shows_the_side_the_photo_was_moved_towards():
    with tempfile.TemporaryDirectory() as tmp:
        wide = _photo(tmp, 800, 200, "lr")   # red left half, blue right half
        # Moved fully right: the photo's left end is in the cell.
        right = _draw(wide, panX=1)
        assert _close(right.getpixel((10, 100)), RED) and _close(right.getpixel((190, 100)), RED)
        # Moved fully left: its right end.
        left = _draw(wide, panX=-1)
        assert _close(left.getpixel((10, 100)), BLUE) and _close(left.getpixel((190, 100)), BLUE)
        # A wide photo fills the height exactly, so up and down change nothing.
        assert _draw(wide, panY=1).tobytes() == _draw(wide).tobytes()
        tall = _photo(tmp, 200, 800, "tb")   # red top half, blue bottom half
        down = _draw(tall, panY=1)
        assert _close(down.getpixel((100, 10)), RED) and _close(down.getpixel((100, 190)), RED)
        up = _draw(tall, panY=-1)
        assert _close(up.getpixel((100, 10)), BLUE) and _close(up.getpixel((100, 190)), BLUE)


def test_a_move_is_read_on_the_page_after_the_turn():
    with tempfile.TemporaryDirectory() as tmp:
        # Red left, blue right; a quarter turn clockwise puts red on top.
        wide = _photo(tmp, 800, 200, "lr")
        down = _draw(wide, rotation=90, panY=1)
        assert _close(down.getpixel((100, 10)), RED) and _close(down.getpixel((100, 190)), RED)
        up = _draw(wide, rotation=90, panY=-1)
        assert _close(up.getpixel((100, 10)), BLUE) and _close(up.getpixel((100, 190)), BLUE)


def test_a_whole_photo_does_not_move():
    with tempfile.TemporaryDirectory() as tmp:
        wide = _photo(tmp, 800, 200, "lr")
        assert _draw(wide, fit="contain", panX=1, panY=1).tobytes() == _draw(wide, fit="contain").tobytes()


def test_a_turn_changes_what_fit_leaves_empty():
    with tempfile.TemporaryDirectory() as tmp:
        out = _draw(_photo(tmp, 800, 200, "lr"), fit="contain", rotation=90)
        # Now a 50x200 band down the middle: the left and right are empty.
        assert out.getpixel((20, 100))[3] == 0 and out.getpixel((180, 100))[3] == 0
        assert _close(out.getpixel((100, 5)), RED) and _close(out.getpixel((100, 195)), BLUE)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    sys.exit(1 if failures else 0)
