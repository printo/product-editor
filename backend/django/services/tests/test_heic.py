"""
Tests for services/heic.py — the server-side HEIC/HEIF decoder.

This is the backstop for iPhone photos the browser cannot read. The in-editor
decoder (heic2any) bundles a 2021 libheif that fails outright on the `tmap`
gain-map HDR structure current iPhones write, and Chrome/Firefox ship no HEIC
codec to fall back on — so if this module regresses, those customers lose the
ability to use their photos entirely, with no client-side path left.

No fixture file is committed: a multi-megabyte binary in the repo for one test
is a poor trade, and pillow-heif can encode a HEIC at test time. That does mean
these tests cover the decode/JPEG/ICC/limits contract rather than the exact
`tmap` container — that specific file was verified by hand (IMG_1258.HEIC,
5712x4284, iOS 18 gain-map HDR) against pillow-heif 0.22.0 / libheif 1.19.7.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_heic
"""
from __future__ import annotations

import io
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from PIL import Image  # noqa: E402

from services.heic import (  # noqa: E402
    HeicDecodeError,
    HeicUnavailableError,
    decode_heic_to_jpeg,
)

try:
    import pillow_heif
    HAVE_HEIF = True
except ImportError:  # pragma: no cover - only when the wheel is absent
    HAVE_HEIF = False


def _make_heic(width: int = 64, height: int = 48, color=(200, 90, 30)) -> bytes:
    """Encode a small HEIC in memory so no binary fixture is needed."""
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    heif = pillow_heif.from_pillow(img)
    heif.save(buf, format="HEIF", quality=90)
    return buf.getvalue()


def test_decodes_heic_to_valid_jpeg():
    jpeg, w, h = decode_heic_to_jpeg(_make_heic(64, 48))
    assert (w, h) == (64, 48), (w, h)
    with Image.open(io.BytesIO(jpeg)) as out:
        assert out.format == "JPEG", out.format
        assert out.size == (64, 48), out.size
        assert out.mode == "RGB", out.mode


def test_output_carries_no_exif_orientation():
    """libheif applies the container's rotation while decoding, so the pixels
    are already upright. Re-attaching the source EXIF would make
    image_loader's exif_transpose rotate a second time — see services/heic.py.
    """
    jpeg, _, _ = decode_heic_to_jpeg(_make_heic())
    with Image.open(io.BytesIO(jpeg)) as out:
        exif = out.getexif()
        assert exif.get(0x0112) in (None, 1), f"unexpected orientation {exif.get(0x0112)}"


def test_non_square_dimensions_are_not_transposed():
    """Guards against a silent width/height swap in the decode path."""
    jpeg, w, h = decode_heic_to_jpeg(_make_heic(80, 40))
    assert (w, h) == (80, 40), (w, h)
    with Image.open(io.BytesIO(jpeg)) as out:
        assert out.size == (80, 40), out.size


def test_garbage_bytes_raise_decode_error():
    try:
        decode_heic_to_jpeg(b"definitely not a heic file")
    except HeicDecodeError:
        return
    except HeicUnavailableError:  # pragma: no cover
        raise AssertionError("pillow-heif missing; cannot assert decode failure")
    raise AssertionError("expected HeicDecodeError for garbage input")


def test_empty_payload_raises_decode_error():
    try:
        decode_heic_to_jpeg(b"")
    except HeicDecodeError:
        return
    raise AssertionError("expected HeicDecodeError for empty input")


def test_oversize_image_is_rejected_before_decode():
    """The dimension cap must be enforced from the header, not after the full
    RGB buffer is allocated — a hostile HEIC can declare huge dimensions in a
    few hundred bytes.
    """
    from django.test import override_settings

    with override_settings(MAX_IMAGE_DIMENSION_PX=32):
        try:
            decode_heic_to_jpeg(_make_heic(64, 48))
        except HeicDecodeError as exc:
            assert "limit" in str(exc).lower(), str(exc)
            return
    raise AssertionError("expected HeicDecodeError for an over-limit image")


if __name__ == "__main__":
    if not HAVE_HEIF:
        print("pillow-heif not installed — skipping HEIC decoder tests.")
        raise SystemExit(0)
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} HEIC decoder tests passed.")
