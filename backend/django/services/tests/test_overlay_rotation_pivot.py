"""
Pins the point a rotated overlay turns around in the print
(services/overlay_renderer.py) to the point both editor previews turn it
around (FabricEditor.tsx and fabric-renderer.ts):

    image                  top-left corner, which stays at (x, y)
    text                   its anchor: left / centre / right edge by
                           textAlign, vertically centred, at (x, y)
    rect and other shapes  top-left corner, at (x, y)
    circle / ellipse       the centre of its box

Until 2026-10-13 the print rotated each overlay and then pasted the rotated
bounding box's top-left at (x, y). A sticker rotated 45 degrees in a 5x5
print landed 27 mm right of where the customer put it.

Each test predicts where the overlay's ink centre must land from the
rotation alone, so it fails if the pivot or the direction of turn is wrong.

Run stand-alone:
    cd backend/django && python -m services.tests.test_overlay_rotation_pivot
"""
from __future__ import annotations

import math
import os
import tempfile

from PIL import Image, ImageDraw

from services.overlay_renderer import render_overlays

SIZE = 400  # canvas px; overlay x/y/width/height below are % of this
TOL = 2.0   # px — BICUBIC resampling and integer paste offsets


def _render(overlay: dict, uploaded_files: dict | None = None) -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    render_overlays(canvas, [overlay], SIZE, SIZE, uploaded_files)
    return canvas


def _ink_centre(img: Image.Image) -> tuple[float, float]:
    """Alpha-weighted centre of everything drawn on a transparent canvas."""
    alpha = img.getchannel("A")
    w = img.width
    total = sx = sy = 0
    for i, a in enumerate(alpha.getdata()):
        if a:
            total += a
            sx += a * (i % w)
            sy += a * (i // w)
    assert total, "the overlay drew nothing"
    # +0.5: a pixel's centre, so a box from 0 to n has its centre at n/2.
    return sx / total + 0.5, sy / total + 0.5


def _turn(dx: float, dy: float, degrees: float) -> tuple[float, float]:
    """Rotate a vector clockwise on screen (y down), as Fabric's `angle` does."""
    a = math.radians(degrees)
    return dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)


def _assert_near(got, want, what):
    assert math.dist(got, want) <= TOL, f"{what}: centre at {got}, expected {want}"


def _sticker(w: int = 300, h: int = 150) -> str:
    """Opaque sticker with a blue top-left quarter, so orientation is visible."""
    path = os.path.join(tempfile.mkdtemp(prefix="pe-pivot-"), "sticker.png")
    img = Image.new("RGBA", (w, h), (220, 30, 30, 255))
    ImageDraw.Draw(img).rectangle((0, 0, w // 2 - 1, h // 2 - 1), fill=(30, 60, 220, 255))
    img.save(path)
    return path


def _image_overlay(rotation: float, x: float = 40, y: float = 30) -> dict:
    # 30% x 15% of 400 px = a 120 x 60 px box, deliberately not square.
    return {
        "type": "image", "source": "local", "fileId": "UP",
        "x": x, "y": y, "width": 30, "height": 15,
        "rotation": rotation, "opacity": 1,
    }


def test_image_turns_around_its_top_left_corner():
    files = {"UP": _sticker()}
    x, y, w, h = 160.0, 120.0, 120.0, 60.0
    for rotation in (0, 30, 45, 90, 135, 180, -60, 270):
        dx, dy = _turn(w / 2, h / 2, rotation)
        _assert_near(
            _ink_centre(_render(_image_overlay(rotation), files)),
            (x + dx, y + dy),
            f"image rotated {rotation}°",
        )


def test_image_at_45_degrees_matches_the_editor_preview():
    """The case reported from the editor: the sticker's top-left corner stays
    on (x, y) and it fans out evenly either side of it, rather than starting
    at x and running right."""
    canvas = _render(_image_overlay(45), {"UP": _sticker(200, 200)})
    left, top, right, _ = canvas.getchannel("A").getbbox()
    reach = 120 * math.cos(math.radians(45)) + 60 * math.sin(math.radians(45))
    assert abs(top - 120) <= TOL, f"top edge at {top}, expected the corner's y (120)"
    assert abs(right - (160 + 120 * math.cos(math.radians(45)))) <= TOL, f"right edge at {right}"
    assert abs(left - (160 - 60 * math.sin(math.radians(45)))) <= TOL, f"left edge at {left}"
    assert abs((right - left) - reach) <= TOL


def test_image_turns_clockwise():
    # The blue top-left quarter of a 120 x 60 box turned 90° clockwise about
    # its corner (160, 120) ends up left of the corner and below it.
    canvas = _render(_image_overlay(90), {"UP": _sticker()})
    r, g, b, a = canvas.getpixel((160 - 15, 120 + 30))
    assert a and b > 150 and r < 100, f"expected the blue quarter there, got {(r, g, b, a)}"


def test_image_hanging_off_the_top_left_edge_still_prints():
    # Turned about a corner at (0, 0), half the sticker sits at negative x.
    # It must be clipped, not skipped.
    canvas = _render(_image_overlay(45, x=0, y=0), {"UP": _sticker()})
    assert canvas.getpixel((10, 60))[3] == 255, "the on-canvas part of the sticker is missing"


def _text(rotation: float, align: str) -> dict:
    return {
        "type": "text", "text": "PIVOT TEST", "x": 50, "y": 50,
        "fontSize": 60, "color": "#000000", "textAlign": align, "rotation": rotation,
    }


def test_text_turns_around_its_anchor():
    anchor = (200.0, 200.0)
    for align in ("left", "center", "right"):
        flat = _ink_centre(_render(_text(0, align)))
        for rotation in (30, -45, 90):
            dx, dy = _turn(flat[0] - anchor[0], flat[1] - anchor[1], rotation)
            _assert_near(
                _ink_centre(_render(_text(rotation, align))),
                (anchor[0] + dx, anchor[1] + dy),
                f"{align}-aligned text rotated {rotation}°",
            )


def _shape(shape_type: str, rotation: float) -> dict:
    return {
        "type": "shape", "shapeType": shape_type,
        "x": 40, "y": 30, "width": 30, "height": 15,
        "fill": "#ff0000", "stroke": "rgba(0,0,0,0)", "strokeWidth": 0,
        "opacity": 1, "rotation": rotation,
    }


def test_rect_turns_around_its_top_left_corner():
    for rotation in (30, 90, -60):
        dx, dy = _turn(60, 30, rotation)
        _assert_near(
            _ink_centre(_render(_shape("rect", rotation))),
            (160 + dx, 120 + dy),
            f"rect rotated {rotation}°",
        )


def test_ellipse_turns_around_its_centre():
    for rotation in (0, 30, 90):
        _assert_near(
            _ink_centre(_render(_shape("ellipse", rotation))),
            (220.0, 150.0),
            f"ellipse rotated {rotation}°",
        )


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} overlay rotation-pivot tests passed.")
