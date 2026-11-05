#!/usr/bin/env python3
"""
Build `frontend/nextjs/public/fonts/pe-blank.ttf`: a font that has a glyph for
every Unicode character, and every one of them is empty and zero wide.

Why it exists: the print draws a text overlay from one font file and nothing
else, while a browser borrows a glyph from another font on the device when the
chosen font has none (an emoji in a Pacifico caption). The editor lists this
font right after the chosen one (`overlayFontStack` in lib/overlay-fonts.ts),
so the browser finds an empty glyph here and never reaches the device's fonts:
the editor then shows exactly the characters the print can draw.

Two glyphs: .notdef (never shown, since every character is mapped) and one
empty glyph that a format 13 character map points all of U+0000..U+10FFFF at.
No dependencies; rerun and commit the output if this file changes.

    python3 scripts/make-blank-font.py
"""
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "frontend/nextjs/public/fonts/pe-blank.ttf"
FAMILY = "PE Blank"
UNITS_PER_EM = 1000
ASCENT, DESCENT = 800, -200


def pad4(data: bytes) -> bytes:
    return data + b"\0" * (-len(data) % 4)


def checksum(data: bytes) -> int:
    data = pad4(data)
    return sum(struct.unpack(f">{len(data) // 4}I", data)) & 0xFFFFFFFF


def glyf_and_loca() -> tuple[bytes, bytes]:
    # .notdef: one 100-unit square, so the glyf table is not empty (some font
    # sanitizers refuse an empty table). Glyph 1, the one every character
    # maps to, has no outline at all.
    notdef = struct.pack(">hhhhh", 1, 0, 0, 100, 100)          # contours, bbox
    notdef += struct.pack(">H", 3)                              # last point of the contour
    notdef += struct.pack(">H", 0)                              # no instructions
    notdef += bytes([0x01] * 4)                                 # four on-curve points
    notdef += struct.pack(">hhhh", 0, 100, 0, -100)             # x deltas
    notdef += struct.pack(">hhhh", 0, 0, 100, 0)                # y deltas
    assert len(notdef) % 2 == 0
    loca = struct.pack(">HHH", 0, len(notdef) // 2, len(notdef) // 2)
    return notdef, loca


def cmap() -> bytes:
    # Format 13 (many characters to one glyph): the whole of Unicode to glyph 1.
    subtable = struct.pack(">HHIII", 13, 0, 16 + 12, 0, 1) + struct.pack(">III", 0x0, 0x10FFFF, 1)
    header = struct.pack(">HH", 0, 2)
    offset = 4 + 8 * 2
    records = struct.pack(">HHI", 0, 6, offset) + struct.pack(">HHI", 3, 10, offset)
    return header + records + subtable


def name() -> bytes:
    strings = {1: FAMILY, 2: "Regular", 3: f"{FAMILY} Regular 1.0", 4: FAMILY, 5: "Version 1.0", 6: "PEBlank-Regular"}
    storage = b""
    records = b""
    for name_id, value in sorted(strings.items()):
        encoded = value.encode("utf-16-be")
        records += struct.pack(">HHHHHH", 3, 1, 0x409, name_id, len(encoded), len(storage))
        storage += encoded
    return struct.pack(">HHH", 0, len(strings), 6 + 12 * len(strings)) + records + storage


def os2() -> bytes:
    data = struct.pack(">HhHHH", 4, 0, 400, 5, 0)
    data += struct.pack(">10h", 650, 600, 0, 75, 650, 600, 0, 350, 50, 300)   # sub/superscript, strikeout
    data += struct.pack(">h", 0) + bytes(10)                                    # family class, panose
    data += struct.pack(">4I", 0, 0, 0, 0)                                      # unicode ranges
    data += b"PEBL"
    data += struct.pack(">HHH", 0x0040, 0, 0xFFFF)                              # regular; first, last char
    data += struct.pack(">hhhHH", ASCENT, DESCENT, 0, ASCENT, -DESCENT)
    data += struct.pack(">2I", 0, 0)                                            # code page ranges
    data += struct.pack(">hhHHH", 0, 0, 0, 32, 0)                               # x height, cap height, default, break, context
    assert len(data) == 96
    return data


def build() -> bytes:
    glyf, loca = glyf_and_loca()
    head = struct.pack(
        ">IIIIHHqqhhhhHHhhh",
        0x00010000, 0x00010000, 0, 0x5F0F3CF5, 0x0003, UNITS_PER_EM,
        0, 0, 0, 0, 100, 100, 0, 3, 2, 0, 0,
    )
    hhea = struct.pack(">IhhhHhhhhhhhhhhhH", 0x00010000, ASCENT, DESCENT, 0, 500, 0, 0, 100, 1, 0, 0, 0, 0, 0, 0, 0, 2)
    maxp = struct.pack(">IHHHHHHHHHHHHHH", 0x00010000, 2, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
    hmtx = struct.pack(">HhHh", 500, 0, 0, 0)
    post = struct.pack(">IIhhIIIII", 0x00030000, 0, -75, 50, 0, 0, 0, 0, 0)
    tables = {
        b"OS/2": os2(), b"cmap": cmap(), b"glyf": glyf, b"head": head, b"hhea": hhea,
        b"hmtx": hmtx, b"loca": loca, b"maxp": maxp, b"name": name(), b"post": post,
    }
    assert len(head) == 54 and len(hhea) == 36 and len(maxp) == 32 and len(post) == 32

    count = len(tables)
    entry_selector = count.bit_length() - 1
    search_range = (1 << entry_selector) * 16
    header = struct.pack(">IHHHH", 0x00010000, count, search_range, entry_selector, count * 16 - search_range)
    offset = 12 + 16 * count
    directory = b""
    body = b""
    for tag in sorted(tables):
        data = tables[tag]
        directory += struct.pack(">4sIII", tag, checksum(data), offset + len(body), len(data))
        body += pad4(data)
    font = bytearray(header + directory + body)

    # head.checkSumAdjustment makes the whole file sum to 0xB1B0AFBA.
    head_offset = 12 + 16 * sorted(tables).index(b"head")
    head_start = struct.unpack_from(">I", font, head_offset + 8)[0]
    struct.pack_into(">I", font, head_start + 8, (0xB1B0AFBA - checksum(bytes(font))) & 0xFFFFFFFF)
    return bytes(font)


if __name__ == "__main__":
    data = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"wrote {OUT} ({len(data)} bytes)")
