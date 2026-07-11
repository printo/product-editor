"""
Tests for services.image_loader — the colour-managed source loader
(Phase 2 item 3, ICC → sRGB colour management).

The Display-P3 profile used here is synthesized in-test (a minimal but valid
ICC v2 RGB matrix-shaper profile, D50-adapted P3 primaries + 2.2 gamma) so no
third-party binary fixture needs to be committed or licensed.

Run stand-alone:
    cd backend/django && python -m services.tests.test_image_loader
"""
from __future__ import annotations

import logging
import os
import struct
import sys
import tempfile

from PIL import Image

from layout_engine.engine import LayoutEngine
from services.image_loader import open_source_rgba, srgb_profile_bytes


# ─── Minimal Display-P3 ICC v2 profile builder ──────────────────────────────

def _s15f16(v: float) -> bytes:
    return struct.pack(">i", int(round(v * 65536)))


def _xyz_tag(x: float, y: float, z: float) -> bytes:
    return b"XYZ " + b"\x00" * 4 + _s15f16(x) + _s15f16(y) + _s15f16(z)


def _curv_gamma(g: float) -> bytes:
    return b"curv" + b"\x00" * 4 + struct.pack(">I", 1) + struct.pack(">H", int(round(g * 256)))


def _desc_tag(text: str) -> bytes:
    ascii_bytes = text.encode("ascii") + b"\x00"
    return (
        b"desc" + b"\x00" * 4
        + struct.pack(">I", len(ascii_bytes)) + ascii_bytes
        + b"\x00" * 4          # unicode language code
        + b"\x00" * 4          # unicode count
        + b"\x00" * 2          # scriptcode
        + b"\x00" * 1          # mac count
        + b"\x00" * 67         # mac description
    )


def _text_tag(text: str) -> bytes:
    return b"text" + b"\x00" * 4 + text.encode("ascii") + b"\x00"


def make_display_p3_icc() -> bytes:
    """Build a valid ICC v2 matrix-shaper profile with Display-P3 primaries."""
    # Bradford D65→D50-adapted Display-P3 primaries (columns sum to D50).
    tags = {
        b"desc": _desc_tag("Synthetic Display P3"),
        b"cprt": _text_tag("public domain test profile"),
        b"wtpt": _xyz_tag(0.9642, 1.0000, 0.8249),
        b"rXYZ": _xyz_tag(0.5151, 0.2412, -0.0011),
        b"gXYZ": _xyz_tag(0.2920, 0.6922, 0.0419),
        b"bXYZ": _xyz_tag(0.1571, 0.0666, 0.7841),
        b"rTRC": _curv_gamma(2.2),
        b"gTRC": _curv_gamma(2.2),
        b"bTRC": _curv_gamma(2.2),
    }

    tag_table = struct.pack(">I", len(tags))
    offset = 128 + 4 + 12 * len(tags)
    body = b""
    for sig, data in tags.items():
        padded = data + b"\x00" * ((4 - len(data) % 4) % 4)
        tag_table += sig + struct.pack(">II", offset, len(data))
        body += padded
        offset += len(padded)

    size = 128 + 4 + 12 * len(tags) + len(body)
    header = struct.pack(
        ">I4sI4s4s4s12s4s",
        size, b"lcms", 0x02400000, b"mntr", b"RGB ", b"XYZ ",
        b"\x00" * 12, b"acsp",
    )
    header += b"\x00" * 24                                   # platform..attrs
    header += struct.pack(">I", 1)                           # rendering intent
    header += _s15f16(0.9642) + _s15f16(1.0) + _s15f16(0.8249)  # PCS illuminant
    header += b"\x00" * (128 - len(header))
    return header + tag_table + body


# ─── Fixture helpers ─────────────────────────────────────────────────────────

def _save(tmpdir: str, name: str, color, icc: bytes | None = None,
          exif_orientation: int | None = None, size=(64, 48)) -> str:
    path = os.path.join(tmpdir, name)
    img = Image.new("RGB", size, color)
    kwargs = {}
    if icc is not None:
        kwargs["icc_profile"] = icc
    if exif_orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        kwargs["exif"] = exif
    img.save(path, "PNG", **kwargs)
    return path


# ─── Tests ───────────────────────────────────────────────────────────────────

def test_untagged_image_passes_through():
    with tempfile.TemporaryDirectory() as d:
        path = _save(d, "plain.png", (200, 30, 90))
        out = open_source_rgba(path)
        assert out.mode == "RGBA"
        assert out.getpixel((5, 5)) == (200, 30, 90, 255)


def test_srgb_tagged_image_fast_paths():
    with tempfile.TemporaryDirectory() as d:
        path = _save(d, "srgb.png", (200, 30, 90), icc=srgb_profile_bytes())
        out = open_source_rgba(path)
        assert out.getpixel((5, 5)) == (200, 30, 90, 255), \
            "sRGB-tagged sources must not be transformed"


def test_p3_orange_converts_toward_srgb():
    """P3(200,100,50) ≈ sRGB(215,92,21) — the same numbers mean a different
    colour in each space, so the transform must visibly re-encode them.
    (Pure P3 red is a bad probe: it clips to exactly sRGB (255,0,0).)"""
    with tempfile.TemporaryDirectory() as d:
        path = _save(d, "p3.png", (200, 100, 50), icc=make_display_p3_icc())
        out = open_source_rgba(path)
        r, g, b, a = out.getpixel((5, 5))
        assert a == 255
        assert (r, g, b) != (200, 100, 50), "P3-tagged source must be transformed"
        assert 205 <= r <= 225, f"expected r≈215, got {(r, g, b)}"
        assert 80 <= g <= 105, f"expected g≈92, got {(r, g, b)}"
        assert 5 <= b <= 35, f"expected b≈21, got {(r, g, b)}"


def test_p3_gray_stays_gray():
    """P3 and sRGB share the white point — grays must survive nearly unchanged."""
    with tempfile.TemporaryDirectory() as d:
        path = _save(d, "p3gray.png", (128, 128, 128), icc=make_display_p3_icc())
        out = open_source_rgba(path)
        r, g, b, _ = out.getpixel((5, 5))
        assert all(abs(c - 128) <= 10 for c in (r, g, b)), (r, g, b)
        assert abs(r - g) <= 4 and abs(g - b) <= 4, f"gray must stay neutral, got {(r, g, b)}"


def test_malformed_profile_fails_open():
    records = []
    handler = logging.Handler()
    handler.emit = lambda rec: records.append(rec)
    logger = logging.getLogger("services.image_loader")
    logger.addHandler(handler)
    try:
        with tempfile.TemporaryDirectory() as d:
            path = _save(d, "bad.png", (10, 220, 40), icc=b"definitely-not-an-icc-profile")
            out = open_source_rgba(path)
            assert out.getpixel((5, 5)) == (10, 220, 40, 255), \
                "malformed profile must fail open with untransformed pixels"
        assert any("ICC conversion failed" in r.getMessage() for r in records), \
            "fail-open path must log a warning"
    finally:
        logger.removeHandler(handler)


def test_cmyk_tagged_image_stays_opaque():
    """Regression: lcms fills the alpha of a CMYK→RGBA transform with 0 —
    the photo would print fully transparent. The loader must request RGB
    for non-alpha sources and add alpha afterwards."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "cmyk.jpg")
        # A CMYK image with an (RGB-spaced) embedded tag exercises the CMYK
        # branch: lcms either transforms (must stay opaque via the RGB
        # out_mode) or raises on the space mismatch (must fail open opaque).
        # Either way a transparent result is the regression this test pins.
        Image.new("CMYK", (32, 32), (0, 255, 255, 0)).save(
            path, "JPEG", icc_profile=make_display_p3_icc(),
        )
        out = open_source_rgba(path)
        assert out.mode == "RGBA"
        alpha = out.getchannel("A").getextrema()
        assert alpha[0] == 255, f"CMYK-tagged source must stay opaque, alpha extrema {alpha}"


def test_exif_orientation_applied():
    with tempfile.TemporaryDirectory() as d:
        # Orientation 6 = rotate 90° CW to display upright → dimensions swap.
        path = _save(d, "exif.png", (1, 2, 3), exif_orientation=6, size=(64, 48))
        out = open_source_rgba(path)
        assert out.size == (48, 64), f"EXIF orientation 6 must transpose, got {out.size}"


def test_output_png_is_tagged_srgb():
    with tempfile.TemporaryDirectory() as d:
        eng = LayoutEngine(layouts_dir=d, exports_dir=d)
        img = Image.new("RGB", (32, 32), (255, 255, 255))
        out_path = os.path.join(d, "out.png")
        eng._write_output_atomic(img, out_path)
        with Image.open(out_path) as reread:
            icc = reread.info.get("icc_profile")
        assert icc, "output PNGs must carry an explicit sRGB profile"


def test_synthetic_profile_is_valid():
    """The in-test P3 builder must produce a profile lcms can actually parse."""
    import io
    from PIL import ImageCms
    profile = ImageCms.ImageCmsProfile(io.BytesIO(make_display_p3_icc()))
    desc = ImageCms.getProfileDescription(profile)
    assert "P3" in desc, desc


# ─── Test runner ─────────────────────────────────────────────────────────────

def _run_all():
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"  OK  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print()
    if failed:
        print(f"{failed} test(s) failed.")
        sys.exit(1)
    print(f"All {len(funcs)} image-loader tests passed.")


if __name__ == "__main__":
    _run_all()
