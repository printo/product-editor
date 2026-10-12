"""
Tests that a layout mask with Mask on Export reaches the print under
STORAGE_BACKEND=s3.

The ops upload writes a mask to S3 (`masks/<file>`) and MaskDownloadView serves
the preview from the same key, but the render looked only on local disk —
which on an S3 deployment holds no masks. The preview showed the frame; the
render then crashed on `None.size`, so the job failed after three retries
instead of printing. The render now reads through storage, and never prints
without a mask the layout asks for.

S3 is the in-memory stand-in from fake_s3 — no network, no credentials.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_mask_loading
"""
from __future__ import annotations

import io
import os
import tempfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.conf import settings
from PIL import Image

from layout_engine.engine import LayoutEngine
from services import storage as storage_mod
from services.tests.fake_s3 import FakeClientError, S3Backend

BROWN = (120, 70, 36)
RED = (255, 0, 0)


def _frame_png(size=(100, 150), border=20, color=BROWN) -> bytes:
    """An opaque border with a transparent window — the shape of a photo frame."""
    w, h = size
    img = Image.new("RGBA", size, color + (255,))
    img.paste((0, 0, 0, 0), (border, border, w - border, h - border))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _engine(work: str) -> LayoutEngine:
    return LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))


def _near(a, b, tol=8):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def test_reads_the_mask_from_s3_when_local_disk_has_none():
    work = tempfile.mkdtemp(prefix="pe-mask-")
    with S3Backend() as s3:
        s3.client.put_object(Bucket=s3.storage.bucket, Key="masks/frame_mask.png", Body=_frame_png())
        mask = _engine(work)._load_mask("/api/layouts/masks/frame_mask.png")
    assert mask.mode == "RGBA" and mask.size == (100, 150)
    assert mask.getpixel((5, 5))[:3] == BROWN
    assert mask.getpixel((50, 75))[3] == 0, "the window must stay transparent"
    assert "masks/frame_mask.png" in s3.client.reads


def test_a_mask_on_local_disk_still_wins():
    work = tempfile.mkdtemp(prefix="pe-mask-")
    os.makedirs(os.path.join(work, "masks"))
    with open(os.path.join(work, "masks", "frame_mask.png"), "wb") as f:
        f.write(_frame_png(color=(0, 0, 255)))
    with S3Backend() as s3:
        s3.client.put_object(Bucket=s3.storage.bucket, Key="masks/frame_mask.png", Body=_frame_png())
        mask = _engine(work)._load_mask("/api/layouts/masks/frame_mask.png")
    assert mask.getpixel((5, 5))[:3] == (0, 0, 255)
    assert s3.client.reads == [], "S3 should not be asked when the file is local"


def test_a_mask_missing_everywhere_raises_with_its_name():
    work = tempfile.mkdtemp(prefix="pe-mask-")
    with S3Backend():
        try:
            _engine(work)._load_mask("/api/layouts/masks/gone_mask.png")
        except FileNotFoundError as exc:
            assert "gone_mask.png" in str(exc)
        else:
            raise AssertionError("a missing mask must not print as no mask")


def test_access_denied_counts_as_missing():
    # S3 answers 403 for a missing key when the caller lacks s3:ListBucket.
    work = tempfile.mkdtemp(prefix="pe-mask-")
    with S3Backend() as s3:
        s3.client.get_error = FakeClientError("AccessDenied", 403)
        try:
            _engine(work)._load_mask("/api/layouts/masks/frame_mask.png")
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("AccessDenied should read as a missing mask")


def test_an_s3_outage_raises_mask_unavailable_so_the_render_retries():
    work = tempfile.mkdtemp(prefix="pe-mask-")
    with S3Backend() as s3:
        s3.client.get_error = FakeClientError("InternalError", 500)
        try:
            _engine(work)._load_mask("/api/layouts/masks/frame_mask.png")
        except storage_mod.MaskUnavailable:
            pass
        else:
            raise AssertionError("an outage must not print as no mask")


def test_the_key_ignores_any_path_in_the_mask_url():
    work = tempfile.mkdtemp(prefix="pe-mask-")
    with S3Backend() as s3:
        s3.client.put_object(Bucket=s3.storage.bucket, Key="masks/frame_mask.png", Body=_frame_png())
        _engine(work)._load_mask("/api/layouts/masks/../../secret/frame_mask.png")
    assert s3.client.reads == ["masks/frame_mask.png"]


def test_local_storage_reads_from_its_masks_dir():
    root = tempfile.mkdtemp(prefix="pe-mask-local-")
    prev = settings.LAYOUTS_DIR
    settings.LAYOUTS_DIR = os.path.join(root, "layouts")
    try:
        local = storage_mod.LocalStorage()
        with open(os.path.join(local.masks_dir(), "frame_mask.png"), "wb") as f:
            f.write(_frame_png())
        assert local.read_mask("frame_mask.png") == _frame_png()
        try:
            local.read_mask("other_mask.png")
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("LocalStorage must raise for a missing mask")
    finally:
        settings.LAYOUTS_DIR = prev


def test_an_s3_only_mask_is_printed_over_the_photo():
    """End to end through generate(): the border pixels in the output file are
    the mask's, and the window shows the photo."""
    work = tempfile.mkdtemp(prefix="pe-mask-")
    photo = os.path.join(work, "red.png")
    Image.new("RGB", (400, 600), RED).save(photo)
    layout = {
        "name": "mask_test",
        "canvas": {"width": 100, "height": 150, "dpi": 300},
        "frames": [{"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}],
        "maskUrl": "/api/layouts/masks/mask_test_mask.png",
        "maskOnExport": True,
    }
    with S3Backend() as s3:
        s3.client.put_object(Bucket=s3.storage.bucket, Key="masks/mask_test_mask.png", Body=_frame_png())
        engine = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"),
                              layout_definition=layout)
        outputs = engine.generate("mask_test", [photo])
    assert len(outputs) == 1
    with Image.open(outputs[0]) as out:
        rgb = out.convert("RGB")
        assert _near(rgb.getpixel((5, 5)), BROWN), f"border should be the frame, got {rgb.getpixel((5, 5))}"
        assert _near(rgb.getpixel((50, 75)), RED), f"window should show the photo, got {rgb.getpixel((50, 75))}"


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
