"""
Tests for services.fonts — the bundled Inter Variable loader every
server-side text element (overlays, calendar grid, captions) draws through.

Pins the variable-axis bug: Inter's fvar order is [opsz, wght], and the
loader used to call set_variation_by_axes([weight]), which wrote the weight
into opsz and left wght at 400. Every weight printed as Regular.

DB-free, no Django.

Run with:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_fonts
"""
from __future__ import annotations

import os
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

from services import fonts
from services.fonts import _FONT_PATH, _axis_values, _read_axis_records, get_font

SAMPLE = "Diwali Holiday 2026"
SIZE_PX = 60


def _render(font: ImageFont.ImageFont) -> Image.Image:
    img = Image.new("L", (900, 120), 255)
    ImageDraw.Draw(img).text((10, 10), SAMPLE, font=font, fill=0)
    return img


def _ink(img: Image.Image) -> int:
    return sum(1 for px in img.getdata() if px < 128)


def _explicit(opsz: float, wght: float) -> ImageFont.ImageFont:
    font = ImageFont.truetype(str(_FONT_PATH), size=SIZE_PX)
    font.set_variation_by_axes([opsz, wght])
    return font


def test_bundled_font_axis_order_is_opsz_then_wght():
    """The fixture the rest of this file relies on. If the bundled .ttf is
    ever replaced, re-check the explicit [opsz, wght] vectors below."""
    tags = [tag for tag, *_ in _read_axis_records(str(_FONT_PATH))]
    assert tags == ["opsz", "wght"], tags


def test_each_weight_matches_explicit_axis_vector():
    """wght gets the weight, opsz stays at its default (14) — which is what
    the Google Fonts Inter in the editor preview renders."""
    for weight in (400, 500, 600, 700):
        got = _render(get_font(SIZE_PX, weight=weight)).tobytes()
        want = _render(_explicit(14, weight)).tobytes()
        assert got == want, f"weight {weight} did not land on the wght axis at opsz 14"


def test_bold_has_more_ink_than_regular():
    """The user-visible symptom: before the fix all four weights rendered
    pixel-identical."""
    inks = [_ink(_render(get_font(SIZE_PX, weight=w))) for w in (400, 500, 600, 700)]
    assert inks == sorted(inks) and len(set(inks)) == 4, inks
    assert inks[3] > inks[0] * 1.2, inks


def test_axis_values_sets_wght_by_tag_not_position():
    records = (("opsz", 14.0, 14.0, 32.0), ("wght", 100.0, 400.0, 900.0))
    assert _axis_values(records, 700) == [14.0, 700.0]
    assert _axis_values(tuple(reversed(records)), 700) == [700.0, 14.0]


def test_axis_values_clamps_weight_to_axis_range():
    records = (("wght", 300.0, 400.0, 600.0),)
    assert _axis_values(records, 700) == [600.0]
    assert _axis_values(records, 100) == [300.0]


def test_axis_values_none_without_weight_axis():
    assert _axis_values((), 700) is None
    assert _axis_values((("opsz", 14.0, 14.0, 32.0),), 700) is None


def test_unparseable_font_file_yields_no_axes():
    with tempfile.NamedTemporaryFile(suffix=".ttf", delete=False) as tmp:
        tmp.write(b"not a font")
    try:
        assert _read_axis_records(tmp.name) == ()
    finally:
        os.unlink(tmp.name)


def test_disallowed_weight_snaps_to_nearest_allowed():
    fonts._FONT_CACHE.clear()
    assert get_font(SIZE_PX, weight=680) is get_font(SIZE_PX, weight=700)


if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} fonts tests …")
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
    print(f"\nAll {len(tests)} fonts tests passed.")
