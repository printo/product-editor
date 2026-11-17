"""
Customer-controlled sizes are bounded before the worker allocates for them.

An overlay's width, height, stroke and font size come from the browser, and a
photo's pixel count from the file. Unbounded, one crafted submit could make a
render worker allocate gigabytes and be killed, taking the other job in the
same worker with it. These tests pin the bounds; nothing legitimate is near
them.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_render_input_caps
"""
from __future__ import annotations

import io
import os
import tempfile
from unittest import mock

from PIL import Image

CW, CH = 600, 800


def _canvas() -> Image.Image:
    return Image.new("RGBA", (CW, CH), (255, 255, 255, 255))


class _Allocations:
    """Records the largest image any overlay draw asks Pillow for."""

    def __init__(self) -> None:
        self.max_px = 0

    def __enter__(self):
        real_new, real_resize = Image.new, Image.Image.resize
        rec = self

        def new(mode, size, *a, **k):
            rec.max_px = max(rec.max_px, size[0] * size[1])
            return real_new(mode, size, *a, **k)

        def resize(img, size, *a, **k):
            rec.max_px = max(rec.max_px, size[0] * size[1])
            return real_resize(img, size, *a, **k)

        self._patches = [
            mock.patch.object(Image, "new", new),
            mock.patch.object(Image.Image, "resize", resize),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


LIMIT_PX = 4 * CW * CH  # the area bound for this canvas


def test_fit_box_leaves_a_normal_overlay_alone_and_shrinks_a_huge_one():
    from services.overlay_renderer import _fit_box

    assert _fit_box(300.0, 200.0, CW, CH) == (300.0, 200.0)
    assert _fit_box(CW * 1.1, CH * 1.1, CW, CH) == (CW * 1.1, CH * 1.1)  # hangs off the canvas, fine
    w, h = _fit_box(6_000_000.0, 3_000_000.0, CW, CH)
    assert w * h <= LIMIT_PX * 1.001
    assert abs(w / h - 2.0) < 1e-6  # shape kept
    assert _fit_box(0.0, 50.0, CW, CH) == (0.0, 50.0)


def test_a_huge_shape_does_not_allocate_past_the_bound():
    from services.overlay_renderer import render_overlays

    overlay = {"type": "shape", "shapeType": "rect", "x": 0, "y": 0, "width": 5_000_000,
               "height": 5_000_000, "fill": "#ff0000", "strokeWidth": 10_000_000, "stroke": "#000000"}
    with _Allocations() as alloc:
        render_overlays(_canvas(), [overlay], CW, CH)
    assert 0 < alloc.max_px <= LIMIT_PX * 1.6, alloc.max_px  # strip + stroke padding


def test_a_huge_font_size_is_bounded():
    from services.overlay_renderer import render_overlays

    overlay = {"type": "text", "text": "Hi", "x": 10, "y": 10, "fontSize": 10_000_000,
               "color": "#000000", "fontFamily": "Inter", "rotation": 30}
    with _Allocations() as alloc:
        render_overlays(_canvas(), [overlay], CW, CH)
    assert alloc.max_px <= 40 * CW * CH, alloc.max_px  # about 9 MP; unbounded it would be terabytes


def test_a_huge_image_overlay_is_resized_to_the_bound():
    from services.overlay_renderer import render_overlays

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sticker.png")
        Image.new("RGBA", (40, 40), (0, 255, 0, 255)).save(path)
        overlay = {"type": "image", "source": "local", "fileId": "f1", "x": 0, "y": 0,
                   "width": 9_000_000, "height": 9_000_000}
        with _Allocations() as alloc:
            render_overlays(_canvas(), [overlay], CW, CH, {"f1": path})
    assert 0 < alloc.max_px <= LIMIT_PX * 1.001, alloc.max_px


def _png(width: int, height: int) -> io.BytesIO:
    """A 1-bit PNG: huge in pixels, tiny in bytes."""
    buf = io.BytesIO()
    Image.new("1", (width, height)).save(buf, "PNG")
    buf.seek(0)
    buf.name = "photo.png"
    buf.size = len(buf.getvalue())
    return buf


def _jpeg(width: int, height: int) -> io.BytesIO:
    buf = io.BytesIO()
    Image.new("L", (width, height)).save(buf, "JPEG")
    buf.seek(0)
    buf.name = "photo.jpg"
    buf.size = len(buf.getvalue())
    return buf


def _refused(fn) -> str:
    from django.core.exceptions import ValidationError

    try:
        fn()
    except ValidationError as exc:
        return str(exc)
    return ""


def test_upload_validator_refuses_photos_over_the_pixel_cap():
    from api import validators

    # Small stand-in limits so the test holds no big images: 2 MP for formats
    # that are decoded whole at render time, 5 MP for a JPEG.
    with mock.patch.object(validators, "MAX_NON_JPEG_MEGAPIXELS", 2), \
            mock.patch.object(validators, "MAX_IMAGE_MEGAPIXELS", 5):
        validators.validate_image_file(_png(1300, 1300))        # 1.7 MP PNG: under
        validators.validate_image_file(_jpeg(2200, 2200))       # 4.8 MP JPEG: under
        assert "for this format" in _refused(lambda: validators.validate_image_file(_png(1500, 1500)))
        validators.validate_image_file(_jpeg(2200, 1800))       # a JPEG over the PNG limit is fine
        assert "too many pixels" in _refused(lambda: validators.validate_image_file(_jpeg(2400, 2400)))


def test_the_default_limits_suit_phone_cameras():
    from api import validators

    assert validators.MAX_IMAGE_MEGAPIXELS >= 200       # 200 MP phone modes (JPEG)
    assert 100 <= validators.MAX_NON_JPEG_MEGAPIXELS <= validators.MAX_IMAGE_MEGAPIXELS


if __name__ == "__main__":
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
    django.setup()
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  OK — {name}")
    print("All render input cap tests passed.")
