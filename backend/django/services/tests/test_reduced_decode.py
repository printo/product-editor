"""
A very large JPEG is decoded at reduced size; nothing else changes.

services.image_loader.open_source_rgba(path, fit_to=...) reads a JPEG over
REDUCED_DECODE_MIN_PIXELS at 1/2, 1/4 or 1/8 size, never below `fit_to` on
either side. Everything below that threshold, and every non-JPEG, is decoded
whole exactly as before, so ordinary prints are byte-for-byte unchanged.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_reduced_decode
"""
from __future__ import annotations

import os
import tempfile
from unittest import mock

from PIL import Image

from services import image_loader
from services.image_loader import open_source_rgba


def _gradient(width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height))
    px = img.load()
    for x in range(0, width, 7):
        for y in range(0, height, 7):
            px[x, y] = (x * 255 // width, y * 255 // height, (x + y) % 256)
    return img


def _save(tmp: str, name: str, img: Image.Image, **kw) -> str:
    path = os.path.join(tmp, name)
    img.save(path, **kw)
    return path


def _bytes(img: Image.Image) -> bytes:
    return img.convert("RGBA").tobytes()


def test_below_the_threshold_the_photo_is_decoded_whole_and_identical():
    with tempfile.TemporaryDirectory() as tmp:
        path = _save(tmp, "a.jpg", _gradient(2000, 1500), quality=90)
        whole = open_source_rgba(path)
        asked = open_source_rgba(path, fit_to=(300, 300))
        assert asked.size == (2000, 1500)
        assert _bytes(asked) == _bytes(whole)


def test_above_the_threshold_a_jpeg_is_read_smaller_but_never_below_fit_to():
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(image_loader, "REDUCED_DECODE_MIN_PIXELS", 1_000_000):
        path = _save(tmp, "big.jpg", _gradient(4000, 3000), quality=90)
        img = open_source_rgba(path, fit_to=(600, 500))
        assert img.size[0] < 4000 and img.size[1] < 3000       # reduced
        assert img.size[0] >= 600 and img.size[1] >= 600       # the longer side is asked of both
        assert abs(img.size[0] / img.size[1] - 4 / 3) < 0.01   # same shape
        assert img.mode == "RGBA"


def test_a_request_close_to_the_full_size_keeps_the_full_size():
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(image_loader, "REDUCED_DECODE_MIN_PIXELS", 1_000_000):
        path = _save(tmp, "big.jpg", _gradient(4000, 3000), quality=90)
        assert open_source_rgba(path, fit_to=(3500, 2500)).size == (4000, 3000)


def test_without_fit_to_the_photo_is_always_decoded_whole():
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(image_loader, "REDUCED_DECODE_MIN_PIXELS", 1_000_000):
        path = _save(tmp, "big.jpg", _gradient(4000, 3000), quality=90)
        assert open_source_rgba(path).size == (4000, 3000)


def test_a_png_is_never_reduced_whatever_its_size():
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(image_loader, "REDUCED_DECODE_MIN_PIXELS", 1_000_000):
        path = _save(tmp, "big.png", _gradient(2000, 1500))
        assert open_source_rgba(path, fit_to=(100, 100)).size == (2000, 1500)


def test_exif_orientation_still_turns_a_reduced_photo():
    # Stored 4000 x 3000 with orientation 6: shown 3000 x 4000 (a quarter turn).
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(image_loader, "REDUCED_DECODE_MIN_PIXELS", 1_000_000):
        img = _gradient(4000, 3000)
        exif = Image.Exif()
        exif[0x0112] = 6
        path = _save(tmp, "turned.jpg", img, quality=90, exif=exif)
        out = open_source_rgba(path, fit_to=(500, 700))
        assert out.size[1] > out.size[0]                        # displayed upright, portrait
        assert out.size[0] >= 700 and out.size[1] >= 700


def test_the_reduced_picture_looks_like_the_whole_one():
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(image_loader, "REDUCED_DECODE_MIN_PIXELS", 1_000_000):
        path = _save(tmp, "big.jpg", _gradient(4000, 3000), quality=95)
        whole = open_source_rgba(path)
        small = open_source_rgba(path, fit_to=(500, 500))
        back = whole.resize(small.size, Image.Resampling.BOX)
        a, b = _bytes(small), _bytes(back)
        diff = sum(abs(x - y) for x, y in zip(a[::4096], b[::4096])) / len(a[::4096])
        assert diff < 6, diff   # mean level difference on a 0-255 scale


if __name__ == "__main__":
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
    django.setup()
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  OK — {name}")
    print("All reduced-decode tests passed.")
