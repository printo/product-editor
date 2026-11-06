"""
Which characters of a text overlay the print can draw.

The print sets a text overlay in one font file (services.google_fonts) and
nothing else. A browser does more: when the chosen font has no glyph for a
character it borrows one from another font on the device, so an emoji typed
into a Pacifico caption shows in the editor. The print has no such fallback:
Pacifico draws nothing in its place and Inter draws an empty box. Until
2026-11-05 nothing told the customer, and the print went out without it.

`unprintable_chars(family, text)` answers from the font's own character map
(its `cmap` table): the same file `get_overlay_font` loads, so the answer is
the print's, not a guess. The editor asks through `POST /api/text/printable`
and warns before the design is submitted.

Not reported: whitespace, control and format characters (a zero-width joiner
between emoji), and variation selectors, none of which draw anything.

Scripts whose letters join or reorder (Hindi, Tamil, Arabic, ...) are a second
case: Poppins has the Devanagari letters, but drawing them one by one, as
Pillow does without the Raqm shaping library, prints misspelt words. So they
print only in a font that has them, while `shaping_available()` is true, and
only for the scripts in `_SHAPED_FOR_PRINT` (the Indian ones). The rest (Arabic,
Hebrew, Thai, ...) stay unprintable: they have not been proofed, and Arabic and
Hebrew also run right to left, which the editor's text box does not lay out.

`printable_text(family, text)` is what the print draws: the text without the
characters above. Until 2026-11-05 Pillow drew a missing character as the
font's "missing glyph": a gap in Pacifico, an empty box in Inter. The editor
now draws nothing for them either (the blank font after the chosen one,
`overlayFontStack` in lib/overlay-fonts.ts), so all three renderers leave the
same characters out and the lines wrap on the same words.
"""
from __future__ import annotations

import logging
import struct
import threading
import unicodedata
from typing import Optional

from services.google_fonts import print_font_data

logger = logging.getLogger(__name__)

# (platformID, encodingID) of the Unicode character maps, best first: the
# full-range ones before the 16-bit ones, as FreeType picks them.
_FULL_UNICODE = ((3, 10), (0, 6), (0, 4))
_BMP_UNICODE = ((3, 1), (0, 3), (0, 2), (0, 1), (0, 0))
_MAX_CODEPOINT = 0x10FFFF


def cmap_codepoints(data: bytes) -> frozenset[int]:
    """The code points the font file has a glyph for; empty when the file has
    no Unicode character map we can read."""
    try:
        table = _table(data, b"cmap")
        if table is None:
            return frozenset()
        num_subtables = struct.unpack_from(">H", data, table + 2)[0]
        subtables: dict[tuple[int, int], int] = {}
        for i in range(num_subtables):
            platform, encoding, offset = struct.unpack_from(">HHI", data, table + 4 + 8 * i)
            subtables.setdefault((platform, encoding), table + offset)
        for key in (*_FULL_UNICODE, *_BMP_UNICODE):
            start = subtables.get(key)
            if start is None:
                continue
            fmt = struct.unpack_from(">H", data, start)[0]
            if fmt in (12, 13):
                return _format_12(data, start)
            if fmt == 4:
                return _format_4(data, start)
    except struct.error as exc:
        logger.warning("Could not read the font's character map: %s", exc)
    return frozenset()


def _table(data: bytes, wanted: bytes) -> Optional[int]:
    num_tables = struct.unpack_from(">H", data, 4)[0]
    for i in range(num_tables):
        tag, _checksum, offset, _length = struct.unpack_from(">4sIII", data, 12 + 16 * i)
        if tag == wanted:
            return offset
    return None


def _format_12(data: bytes, start: int) -> frozenset[int]:
    num_groups = struct.unpack_from(">I", data, start + 12)[0]
    out: set[int] = set()
    for i in range(num_groups):
        first, last, _glyph = struct.unpack_from(">III", data, start + 16 + 12 * i)
        last = min(last, _MAX_CODEPOINT)
        if first <= last:
            out.update(range(first, last + 1))
    return frozenset(out)


def _format_4(data: bytes, start: int) -> frozenset[int]:
    seg_count = struct.unpack_from(">H", data, start + 6)[0] // 2
    ends = start + 14
    starts = ends + 2 * seg_count + 2
    deltas = starts + 2 * seg_count
    range_offsets = deltas + 2 * seg_count
    out: set[int] = set()
    for i in range(seg_count):
        last = struct.unpack_from(">H", data, ends + 2 * i)[0]
        first = struct.unpack_from(">H", data, starts + 2 * i)[0]
        delta = struct.unpack_from(">h", data, deltas + 2 * i)[0]
        range_offset = struct.unpack_from(">H", data, range_offsets + 2 * i)[0]
        for code in range(first, min(last, 0xFFFE) + 1):
            if range_offset == 0:
                glyph = (code + delta) & 0xFFFF
            else:
                at = range_offsets + 2 * i + range_offset + 2 * (code - first)
                glyph = struct.unpack_from(">H", data, at)[0]
                if glyph:
                    glyph = (glyph + delta) & 0xFFFF
            if glyph:
                out.add(code)
    return frozenset(out)


# Unicode blocks whose text needs a shaping engine to come out right: letters
# that join, stack or change order (Hebrew and Arabic also run right to left).
_SHAPED_BLOCKS = (
    (0x0590, 0x08FF),    # Hebrew, Arabic, Syriac, Thaana, N'Ko and extensions
    (0x0900, 0x0DFF),    # Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Sinhala
    (0x0E00, 0x0FFF),    # Thai, Lao, Tibetan
    (0x1000, 0x109F),    # Myanmar
    (0x1780, 0x17FF),    # Khmer
    (0xA8E0, 0xA8FF),    # Devanagari Extended
    (0xFB1D, 0xFDFF),    # Hebrew and Arabic presentation forms
    (0xFE70, 0xFEFF),    # Arabic presentation forms B
)


def shaping_available() -> bool:
    """Whether Pillow can shape complex scripts (built with Raqm and its
    libraries present). Swapped out by tests."""
    from PIL import features
    return bool(features.check("raqm"))


# The scripts above that print once shaping is available: Devanagari, Bengali,
# Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam.
_SHAPED_FOR_PRINT = (
    (0x0900, 0x0D7F),
    (0xA8E0, 0xA8FF),
)

# Zero-width joiner and non-joiner: they choose a letter's form in these
# scripts, and a font need not list them for the shaper to read them.
_FORM_JOINERS = "‌‍"


def _needs_shaping(ch: str) -> bool:
    code = ord(ch)
    return any(first <= code <= last for first, last in _SHAPED_BLOCKS)


def _shaped_for_print(ch: str) -> bool:
    code = ord(ch)
    return any(first <= code <= last for first, last in _SHAPED_FOR_PRINT)


def _printable(ch: str, covered: frozenset[int], shaped: bool) -> bool:
    if ord(ch) not in covered:
        return False
    return not _needs_shaping(ch) or (shaped and _shaped_for_print(ch))


def text_needs_shaping(text: str) -> bool:
    """Whether the print must lay this text out with Raqm. Asked of the text
    `printable_text` returned, so it is true only where that can work."""
    return any(_needs_shaping(ch) for ch in text)


def _is_mark(ch: str) -> bool:
    """A combining mark that sits on the letter before it. Variation
    selectors are marks by category but only pick a glyph style; the previews
    drop them (`canvasText` in lib/overlay-fonts.ts) and so does the print."""
    code = ord(ch)
    if 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF:
        return False
    return unicodedata.category(ch) in ("Mn", "Mc", "Me")


def _draws_nothing(ch: str) -> bool:
    code = ord(ch)
    if ch.isspace() or 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF:
        return True
    return unicodedata.category(ch) in ("Cc", "Cf")


_COVERAGE: dict[bytes, frozenset[int]] = {}
_COVERAGE_LOCK = threading.Lock()


def _coverage(data: bytes) -> frozenset[int]:
    # Keyed on the font file: google_fonts and fonts hand back the same cached
    # bytes object for a family, so each file is hashed and parsed once.
    with _COVERAGE_LOCK:
        hit = _COVERAGE.get(data)
        if hit is None:
            if len(_COVERAGE) >= 64:
                _COVERAGE.clear()
            hit = _COVERAGE[data] = cmap_codepoints(data)
    return hit


def unprintable_chars(family: Optional[str], text: str, weight: int = 400) -> list[str]:
    """The characters of `text` the print would leave out or draw as an empty
    box in `family`, each once, in the order they first appear.

    Raises FontUnavailable when the family's font file can't be obtained, as
    the print itself would.
    """
    covered = _coverage(print_font_data(family, weight))
    shaped = shaping_available()
    out: list[str] = []
    seen: set[str] = set()
    for ch in text:
        if ch in seen:
            continue
        seen.add(ch)
        if _draws_nothing(ch):
            continue
        if _printable(ch, covered, shaped):
            continue
        out.append(ch)
    return out


def printable_text(family: Optional[str], text: str, weight: int = 400) -> str:
    """`text` as the print draws it: without the characters the font has no
    glyph for, and without the ones it could only draw misspelt. Line breaks
    and tabs stay, since the layout reads them. Raises FontUnavailable."""
    covered = _coverage(print_font_data(family, weight))
    shaped = shaping_available()
    out: list[str] = []
    for ch in text:
        if ch in "\n\r\t" or _printable(ch, covered, shaped):
            out.append(ch)
        elif ch in _FORM_JOINERS and out and _needs_shaping(out[-1]):
            out.append(ch)
        elif _is_mark(ch) and out and not out[-1].isspace():
            # A mark the font lacks (the keycap around "1" in a keycap emoji)
            # takes its letter with it: a browser draws the pair together or
            # not at all, and so do the previews.
            out.pop()
    return "".join(out)
