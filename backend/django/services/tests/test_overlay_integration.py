"""
Integration test for overlays flowing through the compositor
(layout_engine.engine._composite_canvas -> services.overlay_renderer).

This is the backend half of the Phase-2 "overlays into the print" fix: the
frontend now includes text/shape/image overlays in the render payload, which
land in editor_state and reach _composite_canvas via `overlays`. This test
proves that when overlays ARE present they render onto the 300 DPI canvas.

Run stand-alone:
    cd backend/django && python -m services.tests.test_overlay_integration
"""
from __future__ import annotations

import os
import sys
import tempfile

from PIL import Image

from layout_engine.engine import LayoutEngine


def _solid(path: str, color: tuple) -> str:
    Image.new("RGB", (400, 400), color).save(path)
    return path


def _near(px, target, tol: int = 40) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px[:3], target))


def _full_frame_surface() -> dict:
    # One frame filling the whole 300x300 canvas, so overlays draw over a known
    # white photo background.
    return {
        "canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
        "frames": [{"x": 0, "y": 0, "width": 300, "height": 300}],
    }


def test_shape_overlay_renders_onto_canvas():
    work = tempfile.mkdtemp(prefix="pe-ovl-")
    white = _solid(os.path.join(work, "white.png"), (255, 255, 255))
    surface = _full_frame_surface()
    # Red rectangle at 10%,10% sized 30%x30% -> covers px (30,30)..(120,120).
    overlays = [{
        "type": "shape", "shapeType": "rect",
        "x": 10, "y": 10, "width": 30, "height": 30,
        "fill": "#ff0000", "stroke": "rgba(0,0,0,0)", "strokeWidth": 0,
        "opacity": 1, "rotation": 0,
    }]
    canvas = LayoutEngine(os.path.join(work, "l"), os.path.join(work, "e"))._composite_canvas(
        surface, [white], "cover", None, frame_transforms=[{}], overlays=overlays,
    )
    assert _near(canvas.getpixel((60, 60)), (255, 0, 0)), "shape overlay should paint red"
    assert _near(canvas.getpixel((280, 280)), (255, 255, 255)), "area outside the shape stays white"


def test_image_overlay_renders_from_uploaded_files():
    work = tempfile.mkdtemp(prefix="pe-ovl-")
    white = _solid(os.path.join(work, "white.png"), (255, 255, 255))
    green = _solid(os.path.join(work, "green.png"), (0, 200, 0))
    surface = _full_frame_surface()
    overlays = [{
        "type": "image", "source": "local", "fileId": "UP123",
        "x": 40, "y": 40, "width": 30, "height": 30, "rotation": 0, "opacity": 1,
    }]
    canvas = LayoutEngine(os.path.join(work, "l"), os.path.join(work, "e"))._composite_canvas(
        surface, [white], "cover", None, frame_transforms=[{}],
        overlays=overlays, uploaded_files={"UP123": green},
    )
    # Overlay covers px (120,120)..(210,210); centre ~ (165,165) should be green.
    assert _near(canvas.getpixel((165, 165)), (0, 200, 0)), "image overlay should paint green"
    assert _near(canvas.getpixel((10, 10)), (255, 255, 255)), "outside the overlay stays white"


def test_text_overlay_marks_the_canvas():
    """Text should leave dark pixels where it's drawn. Tolerant of font
    fallback — we only assert that *some* non-white pixels appear in the text
    band, not exact glyphs."""
    work = tempfile.mkdtemp(prefix="pe-ovl-")
    white = _solid(os.path.join(work, "white.png"), (255, 255, 255))
    surface = _full_frame_surface()
    overlays = [{
        "type": "text", "text": "HELLO", "x": 5, "y": 40,
        "fontSize": 80, "color": "#000000", "textAlign": "left", "rotation": 0,
    }]
    canvas = LayoutEngine(os.path.join(work, "l"), os.path.join(work, "e"))._composite_canvas(
        surface, [white], "cover", None, frame_transforms=[{}], overlays=overlays,
    )
    # Scan a horizontal band around y=40% (~px 120) for any dark pixel.
    dark = 0
    for y in range(110, 170):
        for x in range(0, 300):
            r, g, b = canvas.getpixel((x, y))[:3]
            if r < 128 and g < 128 and b < 128:
                dark += 1
    assert dark > 0, "text overlay left no visible marks on the canvas"


def test_no_overlays_leaves_canvas_clean():
    work = tempfile.mkdtemp(prefix="pe-ovl-")
    white = _solid(os.path.join(work, "white.png"), (255, 255, 255))
    surface = _full_frame_surface()
    canvas = LayoutEngine(os.path.join(work, "l"), os.path.join(work, "e"))._composite_canvas(
        surface, [white], "cover", None, frame_transforms=[{}], overlays=None,
    )
    assert _near(canvas.getpixel((150, 150)), (255, 255, 255))


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
    print(f"All {len(funcs)} overlay-integration tests passed.")


if __name__ == "__main__":
    _run_all()
