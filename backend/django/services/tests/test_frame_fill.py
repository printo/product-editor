"""
The blurred fill behind a photo in Fit, through the real engine: it covers the
whole frame wherever the photo does not reach, whether the gap comes from the
photo's shape, from making it smaller, from moving it or from turning it to an
angle that is not a quarter turn.

Needs Pillow and Django settings (run in the backend container).

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_frame_fill
"""
from __future__ import annotations

import os
import tempfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from PIL import Image

from layout_engine.engine import LayoutEngine

RED = (255, 0, 0)
W, H = 400, 600


def _reddish(px) -> bool:
    r, g, b = px[:3]
    return r > 200 and g < 60 and b < 60


def _layout() -> dict:
    return {
        "name": "fill_test",
        "canvas": {"width": W, "height": H, "widthMm": 40, "heightMm": 60, "dpi": 254},
        "frames": [{"id": "a", "x": 0, "y": 0, "width": 1, "height": 1,
                    "xMm": 0, "yMm": 0, "widthMm": 40, "heightMm": 60}],
    }


def _render(photo_size, **transform) -> Image.Image:
    work = tempfile.mkdtemp(prefix="pe-fill-")
    exports = os.path.join(work, "exports", "job")
    os.makedirs(exports, exist_ok=True)
    photo = os.path.join(work, "red.png")
    Image.new("RGB", photo_size, RED).save(photo)
    engine = LayoutEngine(os.path.join(work, "layouts"), exports, layout_definition=_layout())
    outputs = engine.generate(
        "fill_test", [photo],
        frame_transforms=[{"fit_mode": "contain", **transform}],
    )
    assert len(outputs) == 1, outputs
    img = Image.open(outputs[0]).convert("RGB")
    assert img.size == (W, H), img.size
    return img


CORNERS = [(3, 3), (W - 4, 3), (3, H - 4), (W - 4, H - 4)]


def test_a_photo_turned_to_an_odd_angle_gets_a_fill_into_every_corner():
    out = _render((300, 300), rotation=30, fill_style="blur")
    for xy in CORNERS:
        assert _reddish(out.getpixel(xy)), (xy, out.getpixel(xy))


def test_without_a_fill_style_the_corners_stay_paper():
    out = _render((300, 300), rotation=30)
    for xy in CORNERS:
        assert not _reddish(out.getpixel(xy)), (xy, out.getpixel(xy))


def test_a_photo_of_the_frames_shape_made_smaller_is_filled_around():
    out = _render((200, 300), scale=0.5, fill_style="blur")
    for xy in CORNERS:
        assert _reddish(out.getpixel(xy)), (xy, out.getpixel(xy))


def test_a_photo_moved_aside_is_filled_where_it_left():
    out = _render((200, 300), offset_x=150, fill_style="blur")
    assert _reddish(out.getpixel((5, H // 2))), out.getpixel((5, H // 2))


def test_a_photo_covering_the_frame_prints_the_same_with_or_without_the_fill():
    plain = _render((200, 300))
    filled = _render((200, 300), fill_style="blur")
    assert plain.tobytes() == filled.tobytes()


def test_the_nearest_quarter_turn_rounds_a_tie_up():
    q = LayoutEngine._nearest_quarter_turn
    assert [q(a) for a in (0, 44, 45, 89, 135, 160, 314, 315, 359, 360, -30, -46)] == \
        [0, 0, 90, 90, 180, 180, 270, 0, 0, 0, 0, 270]


if __name__ == "__main__":
    import sys
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {exc!r}")
    sys.exit(1 if failed else 0)
