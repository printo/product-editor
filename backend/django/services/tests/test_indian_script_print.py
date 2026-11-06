"""
Hindi, Tamil and the other Indian scripts print correctly spelt, in a font that
has them, and nothing else about the print moves.

These scripts need a shaping engine: letters join, stack and change places. The
image installs libfribidi0, which switches on the Raqm library Pillow's wheel
carries. Raqm also kerns, which would move every existing line of English, so
it is used only for overlays that hold an Indian script (2026-11-06). These
pin: the reordering and joining really happen in the print path, English stays
on Pillow's basic layout, a font without the letters still leaves them out, and
the scripts nobody has proofed stay off.

No network, no database: two small samples of OFL fonts stand in for Google
(`fixtures/README.md`). The checks that need Raqm say so and skip without it.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_indian_script_print
"""
from __future__ import annotations

import io
import os
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from PIL import Image, ImageChops, ImageDraw, ImageFont, features

from services import google_fonts as gf
from services import text_coverage as tc
from services.fonts import get_font
from services.overlay_renderer import render_overlays

FIXTURES = Path(__file__).parent / "fixtures"
DEVANAGARI = (FIXTURES / "Devanagari-Sample.ttf").read_bytes()
TAMIL = (FIXTURES / "Tamil-Sample.ttf").read_bytes()
HINDI_WORD = "नमस्ते"
TAMIL_WORD = "வணக்கம்"
HAS_RAQM = features.check("raqm")


def _with_fonts():
    gf.clear_caches()
    tc._COVERAGE.clear()
    gf.allowed_families = lambda: ["Sample Devanagari", "Sample Tamil", gf.DEFAULT_FONT]
    gf._BYTES_CACHE[gf.cache_name("Sample Devanagari", 400)] = DEVANAGARI
    gf._BYTES_CACHE[gf.cache_name("Sample Tamil", 400)] = TAMIL


def _restore():
    gf.allowed_families = gf._ops_fonts
    gf.clear_caches()
    tc._COVERAGE.clear()


def _overlay(canvas, text, family, **over):
    render_overlays(canvas, [{
        "type": "text", "text": text, "x": 50, "y": 50, "fontSize": 120, "color": "#000000",
        "fontFamily": family, "textAlign": "center", "rotation": 0, "width": 100, **over,
    }], canvas.width, canvas.height, {})


def _ink_share_that_differs(a, b):
    """How much of the ink in `a` and `b` is not shared, 0 to 1."""
    diff = ImageChops.difference(a.convert("L"), b.convert("L")).point(lambda v: 255 if v > 96 else 0)
    ink = ImageChops.lighter(ImageChops.invert(a.convert("L")), ImageChops.invert(b.convert("L")))
    ink = ink.point(lambda v: 255 if v > 96 else 0)
    return sum(diff.getdata()) / max(1, sum(ink.getdata()))


def test_english_never_uses_raqm():
    """Raqm kerns: with it, 'AVATAR To You' at 100 px is 47 px narrower. So the
    two ways of getting a font stay on basic layout unless they are asked."""
    _with_fonts()
    try:
        assert gf.get_overlay_font("Sample Devanagari", 80).layout_engine == ImageFont.Layout.BASIC
        assert get_font(80).layout_engine == ImageFont.Layout.BASIC
        assert get_font(80, weight=700).layout_engine == ImageFont.Layout.BASIC
    finally:
        _restore()


def test_the_print_asks_for_shaping_only_for_an_indian_script():
    from services import overlay_renderer as or_module

    _with_fonts()
    asked = []
    real = or_module.get_overlay_font
    or_module.get_overlay_font = lambda *a, **k: (asked.append(k.get("shaped")), real(*a, **k))[1]
    original_shaping = tc.shaping_available
    tc.shaping_available = lambda: True
    try:
        canvas = Image.new("RGB", (1000, 400), "white")
        _overlay(canvas, "Hello", "Sample Devanagari")
        _overlay(canvas, f"Hello {HINDI_WORD}", "Sample Devanagari")
        # The Tamil is left out of this font, so what remains is plain English.
        _overlay(canvas, f"Hello {TAMIL_WORD}", "Sample Devanagari")
        assert asked == [False, True, False], asked
    finally:
        or_module.get_overlay_font = real
        tc.shaping_available = original_shaping
        _restore()


def test_tamil_vowel_parts_go_round_their_letter():
    """கொ is stored as the letter then one vowel sign, and printed as one part
    left of the letter and one right of it. Drawn in stored order it is wrong."""
    if not HAS_RAQM:
        print("  (skipped: no Raqm in this image)")
        return
    _with_fonts()
    try:
        canvas = Image.new("RGB", (900, 400), "white")
        _overlay(canvas, "கொ", "Sample Tamil", fontSize=200)
        shaped = canvas.convert("L")

        plain = gf.get_overlay_font("Sample Tamil", 200)
        by_hand = Image.new("L", shaped.size, 255)
        drawn = "ெ" + "க" + "ா"  # the same three parts in the order they should print
        ImageDraw.Draw(by_hand).text((450, 200), drawn, font=plain, fill=0, anchor="mm")
        stored_order = Image.new("L", shaped.size, 255)
        ImageDraw.Draw(stored_order).text((450, 200), "கொ", font=plain, fill=0, anchor="mm")

        def ink_box(img):
            return ImageChops.invert(img).point(lambda v: 255 if v > 96 else 0).getbbox()

        def aligned(img):
            return img.crop(ink_box(img)).resize((400, 200))

        assert _ink_share_that_differs(aligned(shaped), aligned(by_hand)) < 0.12
        assert _ink_share_that_differs(aligned(shaped), aligned(stored_order)) > 0.25
    finally:
        _restore()


def test_hindi_letters_join_in_the_print():
    """श्री is three letters and a joining mark, and prints as one shape,
    narrower than the letters and the visible mark side by side."""
    if not HAS_RAQM:
        print("  (skipped: no Raqm in this image)")
        return
    _with_fonts()
    try:
        shaped_font = gf.get_overlay_font("Sample Devanagari", 120, shaped=True)
        plain_font = gf.get_overlay_font("Sample Devanagari", 120)
        for word in ("श्री", "कृष्ण", "प्रिय", HINDI_WORD):
            assert shaped_font.getlength(word) < plain_font.getlength(word), word

        canvas = Image.new("RGB", (1200, 300), "white")
        _overlay(canvas, HINDI_WORD, "Sample Devanagari")
        assert canvas.getbbox() is not None
        unshaped = Image.new("RGB", (1200, 300), "white")
        ImageDraw.Draw(unshaped).text((600, 150), HINDI_WORD, font=plain_font, fill="#000000", anchor="mm")
        assert ImageChops.difference(canvas, unshaped).getbbox() is not None
    finally:
        _restore()


def test_rotated_indian_text_prints():
    if not HAS_RAQM:
        print("  (skipped: no Raqm in this image)")
        return
    _with_fonts()
    try:
        canvas = Image.new("RGB", (1000, 1000), "white")
        _overlay(canvas, HINDI_WORD, "Sample Devanagari", rotation=30)
        assert ImageChops.difference(canvas, Image.new("RGB", (1000, 1000), "white")).getbbox() is not None
    finally:
        _restore()


def test_bold_is_bold_when_shaped():
    """The weight is set on the same font object Raqm reads."""
    if not HAS_RAQM:
        print("  (skipped: no Raqm in this image)")
        return
    from services import fonts as fonts_module

    data = fonts_module._FONT_PATH.read_bytes()
    gf.clear_caches()
    gf.allowed_families = lambda: ["Sample Variable", gf.DEFAULT_FONT]
    for weight in (400, 700):
        gf._BYTES_CACHE[gf.cache_name("Sample Variable", weight)] = data
    try:
        regular = gf.get_overlay_font("Sample Variable", 100, weight=400, shaped=True)
        bold = gf.get_overlay_font("Sample Variable", 100, weight=700, shaped=True)
        assert regular is not bold
        assert bold.getlength("Hello there") > regular.getlength("Hello there")
    finally:
        _restore()


def test_a_font_without_the_letters_still_leaves_them_out():
    _with_fonts()
    original_shaping = tc.shaping_available
    tc.shaping_available = lambda: True
    try:
        assert set(tc.unprintable_chars("Sample Devanagari", TAMIL_WORD)) == set(TAMIL_WORD)
        assert tc.printable_text("Sample Devanagari", f"Hi {TAMIL_WORD}") == "Hi "
        assert tc.unprintable_chars("Sample Tamil", TAMIL_WORD) == []
        assert tc.printable_text("Sample Tamil", TAMIL_WORD) == TAMIL_WORD
        assert tc.unprintable_chars("Sample Devanagari", HINDI_WORD) == []
        assert set(tc.unprintable_chars("Inter", HINDI_WORD)) == set(HINDI_WORD)
    finally:
        tc.shaping_available = original_shaping
        _restore()


def test_the_scripts_nobody_has_proofed_stay_off():
    """Even in a font that has them. Arabic and Hebrew also run right to left,
    which the editor's text box does not lay out."""
    gf.clear_caches()
    original_coverage, original_shaping = tc._coverage, tc.shaping_available
    tc._coverage = lambda data: frozenset(range(0x20, 0x7F)) | frozenset(range(0x0590, 0x1100))
    tc.shaping_available = lambda: True
    try:
        for label, word in (
            ("Hebrew", "שלום"), ("Arabic", "مرحبا"), ("Thai", "สวัสดี"), ("Sinhala", "ආයුබෝවන්"),
        ):
            assert set(tc.unprintable_chars("Inter", word)) == set(word), label
            assert tc.printable_text("Inter", word) == "", label
        assert tc.unprintable_chars("Inter", HINDI_WORD) == []
    finally:
        tc._coverage, tc.shaping_available = original_coverage, original_shaping
        gf.clear_caches()


def test_a_joiner_stays_with_its_indian_letter_and_goes_with_an_emoji():
    """The zero-width joiner picks a letter's form; most fonts do not list it,
    and the shaper reads it anyway. Between emoji it has nothing left to join."""
    _with_fonts()
    original_coverage, original_shaping = tc._coverage, tc.shaping_available
    tc._coverage = lambda data: frozenset(range(0x20, 0x7F)) | frozenset(range(0x0900, 0x0980))
    tc.shaping_available = lambda: True
    try:
        half_form = "क्‍ष"
        assert tc.printable_text("Inter", half_form) == half_form
        assert tc.printable_text("Inter", "\U0001F468‍\U0001F469") == ""
        tc.shaping_available = lambda: False
        assert tc.printable_text("Inter", half_form) == ""
    finally:
        tc._coverage, tc.shaping_available = original_coverage, original_shaping
        _restore()


def test_a_font_is_labelled_with_the_languages_its_file_has():
    """The picker's label comes from the font itself, so a font ops add later
    is labelled without anyone writing it down."""
    _with_fonts()
    original_shaping = tc.shaping_available
    tc.shaping_available = lambda: True
    try:
        assert tc.font_languages("Sample Devanagari") == ["Hindi"]
        assert tc.font_languages("Sample Tamil") == ["Tamil"]
        assert tc.font_languages("Inter") == []
        tc.shaping_available = lambda: False
        assert tc.font_languages("Sample Tamil") == []
    finally:
        tc.shaping_available = original_shaping
        _restore()


def test_the_samples_are_what_they_claim():
    for data, word in ((DEVANAGARI, HINDI_WORD), (TAMIL, TAMIL_WORD)):
        covered = tc.cmap_codepoints(data)
        assert all(ord(c) in covered for c in word)
        assert ImageFont.truetype(io.BytesIO(data), 40).getlength("Hello") > 0


if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL {t.__name__}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
