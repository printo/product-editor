"""
End to end through the real engine: a landscape layout asked for in portrait
prints a portrait file with each photo in the turned frame, and the mask is
turned with it.

Needs Pillow and Django settings (run in the backend container).

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_orientation_render
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
from services.layout_orientation import apply_orientation

RED, BLUE, BLACK = (255, 0, 0), (0, 0, 255), (0, 0, 0)


def _near(a, b, tol=12):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b))


def _layout(mask: bool) -> dict:
    return {
        "name": "two_up_test",
        "canvas": {"width": 600, "height": 400, "widthMm": 60, "heightMm": 40, "dpi": 254},
        "frames": [
            {"id": "a", "x": 0.05, "y": 0.1, "width": 0.4, "height": 0.8,
             "xMm": 3, "yMm": 4, "widthMm": 24, "heightMm": 32},
            {"id": "b", "x": 0.55, "y": 0.1, "width": 0.4, "height": 0.8,
             "xMm": 33, "yMm": 4, "widthMm": 24, "heightMm": 32},
        ],
        "maskUrl": "/api/layouts/masks/corner_mask.png" if mask else None,
        "maskOnExport": mask,
    }


def _solid(path: str, color) -> str:
    Image.new("RGB", (300, 300), color).save(path)
    return path


def _render(work: str, definition: dict) -> Image.Image:
    exports = os.path.join(work, "exports", "job")
    os.makedirs(exports, exist_ok=True)
    engine = LayoutEngine(os.path.join(work, "layouts"), exports, layout_definition=definition)
    paths = [_solid(os.path.join(work, "red.png"), RED), _solid(os.path.join(work, "blue.png"), BLUE)]
    outputs = engine.generate("two_up_test", paths)
    assert len(outputs) == 1, outputs
    return Image.open(outputs[0]).convert("RGB")


def test_portrait_request_prints_a_portrait_file_with_photos_in_the_turned_frames():
    work = tempfile.mkdtemp(prefix="pe-orient-")
    authored = _render(work, _layout(mask=False))
    assert authored.size == (600, 400)
    # authored: red on the left, blue on the right
    assert _near(authored.getpixel((150, 200)), RED) and _near(authored.getpixel((450, 200)), BLUE)

    turned_def, report = apply_orientation(_layout(mask=False), "portrait")
    assert report["applied"] is True
    turned = _render(work, turned_def)
    assert turned.size == (400, 600)
    # a quarter turn clockwise: left becomes top, right becomes bottom
    assert _near(turned.getpixel((200, 150)), RED), turned.getpixel((200, 150))
    assert _near(turned.getpixel((200, 450)), BLUE), turned.getpixel((200, 450))


def test_the_mask_is_turned_with_the_layout():
    work = tempfile.mkdtemp(prefix="pe-orient-")
    os.makedirs(os.path.join(work, "masks"))
    mask = Image.new("RGBA", (600, 400), (0, 0, 0, 0))
    mask.paste((0, 0, 0, 255), (0, 0, 80, 80))  # opaque black block, top-left of the authored canvas
    mask.save(os.path.join(work, "masks", "corner_mask.png"))

    authored = _render(work, _layout(mask=True))
    assert _near(authored.getpixel((20, 20)), BLACK)

    turned_def, report = apply_orientation(_layout(mask=True), "portrait")
    assert report["applied"] is True and turned_def["maskRotate"] == 90
    turned = _render(work, turned_def)
    # top-left turned clockwise ends up top-right of the portrait canvas
    assert _near(turned.getpixel((380, 20)), BLACK), turned.getpixel((380, 20))
    assert not _near(turned.getpixel((20, 20)), BLACK)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    raise SystemExit(1 if failures else 0)
