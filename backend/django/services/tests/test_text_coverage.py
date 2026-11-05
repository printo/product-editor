"""
Tests for services.text_coverage — which characters of a text overlay the
print can draw.

A browser borrows a glyph from another font when the chosen one lacks it, so
an emoji typed into a caption shows in the editor; the print draws from one
font file and left it out (complaint, printo job 6795066, 2026-11-05). These
pin: the answer comes from the font file the print loads; it agrees with what
FreeType actually draws; emoji and Indian scripts are reported for the Latin
fonts; characters that draw nothing are not; and both character-map formats
are read.

No network, no database: the bundled Inter Variable and the Parisienne
fixture stand in for Google.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_text_coverage
"""
from __future__ import annotations

import os
import struct
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from PIL import ImageFont

from services import google_fonts as gf
from services import text_coverage as tc
from services.fonts import _FONT_PATH

PARISIENNE = (Path(__file__).parent / "fixtures" / "Parisienne-Regular.ttf").read_bytes()
MAN_DANCING = "\U0001F57A"
MUSICAL_NOTES = "\U0001F3B6"


def _with_fonts(listed: dict[str, bytes]):
    """Put `listed` on the fonts list and serve its files without a network."""
    gf.clear_caches()
    tc._COVERAGE.clear()
    gf.allowed_families = lambda: [*listed, gf.DEFAULT_FONT]
    for family, data in listed.items():
        gf._BYTES_CACHE[gf.cache_name(family, 400)] = data


def _restore():
    gf.allowed_families = gf._ops_fonts
    gf.clear_caches()
    tc._COVERAGE.clear()


def _freetype_draws(font_path_or_bytes, ch: str) -> bool:
    """Whether FreeType has a real glyph for `ch`: its drawing differs from
    the missing-glyph box, or its advance does."""
    import io
    src = io.BytesIO(font_path_or_bytes) if isinstance(font_path_or_bytes, bytes) else str(font_path_or_bytes)
    font = ImageFont.truetype(src, size=64)
    missing = "\U0010FFFF"
    return (
        font.getmask(ch).getbbox() != font.getmask(missing).getbbox()
        or font.getlength(ch) != font.getlength(missing)
    )


def test_latin_caption_is_printable_in_inter():
    _with_fonts({})
    try:
        assert tc.unprintable_chars("Inter", "Won the argument, still love her!") == []
        assert tc.unprintable_chars(None, "Café déjà vu") == []
    finally:
        _restore()


def test_emoji_are_reported_in_order_and_once():
    _with_fonts({})
    try:
        text = f"Won {MAN_DANCING} the {MUSICAL_NOTES} argument {MAN_DANCING}"
        assert tc.unprintable_chars("Inter", text) == [MAN_DANCING, MUSICAL_NOTES]
    finally:
        _restore()


def test_indian_scripts_are_reported_for_a_latin_font():
    _with_fonts({})
    try:
        hindi, tamil = "नमस्ते", "வணக்கம்"
        assert set(tc.unprintable_chars("Inter", hindi)) == set(hindi)
        assert set(tc.unprintable_chars("Inter", tamil)) == set(tamil)
    finally:
        _restore()


def test_characters_that_draw_nothing_are_not_reported():
    _with_fonts({})
    try:
        # Newline, tab, zero-width joiner, variation selector 16.
        assert tc.unprintable_chars("Inter", "a\nb\tc‍️ d") == []
        # A joined emoji reports its visible parts, not the joiner.
        family = "\U0001F468‍\U0001F469"
        assert tc.unprintable_chars("Inter", family) == ["\U0001F468", "\U0001F469"]
    finally:
        _restore()


def test_the_listed_family_is_checked_not_inter():
    """Parisienne has no Greek; Inter does. The answer must follow the family."""
    _with_fonts({"Parisienne": PARISIENNE})
    try:
        omega = "Ω"
        assert _freetype_draws(_FONT_PATH, omega) and not _freetype_draws(PARISIENNE, omega)
        assert tc.unprintable_chars("Inter", omega) == []
        assert tc.unprintable_chars("Parisienne", omega) == [omega]
    finally:
        _restore()


def test_an_unlisted_family_is_checked_against_inter_as_the_print_draws_it():
    _with_fonts({})
    try:
        assert tc.unprintable_chars("Not A Real Font", "Ω") == []
        assert tc.unprintable_chars("Not A Real Font", MAN_DANCING) == [MAN_DANCING]
    finally:
        _restore()


def test_character_map_agrees_with_what_freetype_draws():
    """The table reader against the renderer itself, over a spread of
    characters, for both fonts."""
    sample = (
        "AZaz09 !?&@#%€£₹¥©®™°±×÷½àéîõüñçßøåžšłđ"
        "ΑΩαω ДЖдж אב عر नम தமி ಕನ 中文 ひら 한글 "
        "←→↑↓♥♦♪★☆✓✗ " + MAN_DANCING + MUSICAL_NOTES + "\U0001F600❤"
    )
    for label, data in (("Inter", _FONT_PATH.read_bytes()), ("Parisienne", PARISIENNE)):
        covered = tc.cmap_codepoints(data)
        assert covered, f"{label}: no character map read"
        for ch in sample:
            if ch.isspace():
                continue
            assert (ord(ch) in covered) == _freetype_draws(data, ch), f"{label}: disagree on U+{ord(ch):04X}"


def test_the_print_text_leaves_out_what_the_font_lacks_and_keeps_the_line_breaks():
    _with_fonts({})
    try:
        text = f"Won the argument\n{MAN_DANCING} {MUSICAL_NOTES}\tx \u2764\ufe0f"
        printed = tc.printable_text("Inter", text)
        assert MAN_DANCING not in printed and MUSICAL_NOTES not in printed and "\ufe0f" not in printed
        assert printed.startswith("Won the argument\n") and "\tx " in printed
        assert tc.printable_text("Inter", "Café ₹500") == "Café ₹500"
        # A keycap emoji is "1", a hidden selector and an enclosing mark: the
        # mark the font lacks takes the 1 with it, the selector alone does not.
        assert tc.printable_text("Inter", "No. 1\ufe0f\u20e3 dad") == "No.  dad"
        assert tc.printable_text("Inter", "A\ufe0f B") == "A B"
    finally:
        _restore()


def test_the_print_draws_a_caption_with_emoji_exactly_as_the_caption_without_them():
    """No missing-glyph boxes, no gap: the same pixels as if the emoji had
    never been typed, which is what the editor now shows too."""
    from PIL import Image, ImageChops
    from services.overlay_renderer import render_overlays

    _with_fonts({})
    try:
        def draw(text):
            canvas = Image.new("RGB", (1050, 1260), "white")
            render_overlays(canvas, [{
                "type": "text", "text": text, "x": 50, "y": 88, "fontSize": 60, "color": "#000000",
                "fontFamily": "Inter", "textAlign": "center", "rotation": 0,
            }], 1050, 1260, {})
            return canvas

        with_emoji = draw(f"Won the argument {MAN_DANCING}{MUSICAL_NOTES}\n{MAN_DANCING} {MUSICAL_NOTES}")
        without = draw("Won the argument \n ")
        assert without.getbbox() is not None
        assert ImageChops.difference(with_emoji, without).getbbox() is None
        only_emoji = draw(f"{MAN_DANCING} {MUSICAL_NOTES}")
        assert ImageChops.difference(only_emoji, Image.new("RGB", (1050, 1260), "white")).getbbox() is None
    finally:
        _restore()


def test_a_script_that_needs_shaping_is_unprintable_until_the_print_can_shape_it():
    """Poppins has the Devanagari letters; drawn one by one they print
    misspelt, so without the shaping library they are left out and reported."""
    hindi = "नमस्ते"
    _with_fonts({})
    original_coverage, original_shaping = tc._coverage, tc.shaping_available
    tc._coverage = lambda data: frozenset(range(0x20, 0x7F)) | frozenset(range(0x0900, 0x0980))
    try:
        tc.shaping_available = lambda: False
        assert set(tc.unprintable_chars("Inter", f"Hi {hindi}")) == set(hindi)
        assert tc.printable_text("Inter", f"Hi {hindi}!") == "Hi !"
        tc.shaping_available = lambda: True
        assert tc.unprintable_chars("Inter", f"Hi {hindi}") == []
        assert tc.printable_text("Inter", f"Hi {hindi}!") == f"Hi {hindi}!"
    finally:
        tc._coverage, tc.shaping_available = original_coverage, original_shaping
        _restore()


def _font_with_cmap(subtable: bytes, platform: int, encoding: int) -> bytes:
    """A minimal sfnt holding only a cmap table with one subtable."""
    cmap = struct.pack(">HH", 0, 1) + struct.pack(">HHI", platform, encoding, 12) + subtable
    header = struct.pack(">IHHHH", 0x00010000, 1, 0, 0, 0)
    record = struct.pack(">4sIII", b"cmap", 0, 12 + 16, len(cmap))
    return header + record + cmap


def test_reads_a_16_bit_character_map():
    # Two segments: A..C mapped by delta, then the 0xFFFF terminator.
    seg_count = 2
    body = struct.pack(">HHHH", seg_count * 2, 0, 0, 0)
    body += struct.pack(">HH", 0x43, 0xFFFF) + struct.pack(">H", 0)        # endCode, pad
    body += struct.pack(">HH", 0x41, 0xFFFF)                                # startCode
    body += struct.pack(">hh", -0x40, 1)                                    # idDelta
    body += struct.pack(">HH", 0, 0)                                        # idRangeOffset
    subtable = struct.pack(">HHH", 4, 6 + len(body), 0) + body
    covered = tc.cmap_codepoints(_font_with_cmap(subtable, 3, 1))
    assert covered == frozenset({0x41, 0x42, 0x43})


def test_reads_a_full_range_character_map():
    groups = struct.pack(">III", 0x41, 0x42, 1) + struct.pack(">III", 0x1F57A, 0x1F57A, 3)
    subtable = struct.pack(">HHIII", 12, 0, 16 + len(groups), 0, 2) + groups
    covered = tc.cmap_codepoints(_font_with_cmap(subtable, 3, 10))
    assert covered == frozenset({0x41, 0x42, 0x1F57A})


def test_an_unreadable_file_covers_nothing_and_does_not_raise():
    assert tc.cmap_codepoints(b"") == frozenset()
    assert tc.cmap_codepoints(b"\x00\x01\x00\x00\x00\x05") == frozenset()


def test_a_font_that_cannot_be_fetched_raises_font_unavailable():
    """As the print does: unknown, never 'printable'."""
    gf.clear_caches()
    tc._COVERAGE.clear()
    gf.allowed_families = lambda: ["Parisienne", gf.DEFAULT_FONT]
    original_read, original_get = gf._read_cached, gf.http_get

    def offline(url, max_bytes):
        raise OSError("no network")

    gf._read_cached = lambda name: None
    gf.http_get = offline
    try:
        try:
            tc.unprintable_chars("Parisienne", "abc")
        except gf.FontUnavailable:
            pass
        else:
            raise AssertionError("expected FontUnavailable")
    finally:
        gf._read_cached, gf.http_get = original_read, original_get
        _restore()


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
