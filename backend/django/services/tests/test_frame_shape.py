"""
Tests for frame-shape clipping + contain-mode bleed in
layout_engine.engine._composite_canvas (Phase-2 WYSIWYG parity).

Guards two engine-only fixes:
  1. Rounded/circular frames (borderRadiusMm) are clipped to shape, so circle
     products (e.g. circle_48mm magnets) print round instead of as a white-
     cornered square. Radius matches the browser preview:
     min(w/2, h/2, borderRadiusMm * canvas_w_px / canvas_w_mm).
  2. Contain-mode frames are clipped to the frame box, so a zoomed/panned image
     can no longer bleed into a neighbouring frame.

Run stand-alone:
    cd backend/django && python -m services.tests.test_frame_shape
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


def _engine(work: str) -> LayoutEngine:
    return LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))


def test_circle_frame_clips_corners_to_background():
    """A full-circle frame (borderRadiusMm big enough) is RED at the centre and
    WHITE (background) at the corners."""
    work = tempfile.mkdtemp(prefix="pe-shape-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    # 300px canvas == 300mm -> px_per_mm = 1. borderRadiusMm=150 -> radius=150=w/2 -> circle.
    surface = {
        "canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
        "frames": [{"x": 0, "y": 0, "width": 300, "height": 300, "borderRadiusMm": 150}],
    }
    canvas = _engine(work)._composite_canvas(surface, [red], "cover", None, frame_transforms=[{}])

    assert _near(canvas.getpixel((150, 150)), (255, 0, 0)), "centre should be RED (inside circle)"
    for corner in [(3, 3), (296, 3), (3, 296), (296, 296)]:
        assert _near(canvas.getpixel(corner), (255, 255, 255)), \
            f"corner {corner} should be WHITE (clipped outside the circle)"


def test_square_frame_is_unaffected_by_shape_mask():
    """borderRadiusMm=0 -> no clipping; corners stay RED (regression guard for
    the common square-frame path)."""
    work = tempfile.mkdtemp(prefix="pe-shape-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    surface = {
        "canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
        "frames": [{"x": 0, "y": 0, "width": 300, "height": 300, "borderRadiusMm": 0}],
    }
    canvas = _engine(work)._composite_canvas(surface, [red], "cover", None, frame_transforms=[{}])

    assert _near(canvas.getpixel((150, 150)), (255, 0, 0)), "centre should be RED"
    assert _near(canvas.getpixel((3, 3)), (255, 0, 0)), "corner should stay RED (no clip on square)"


def test_contain_zoom_does_not_bleed_into_neighbour():
    """A contain-mode image zoomed past its frame must not paint into the
    neighbouring frame's region."""
    work = tempfile.mkdtemp(prefix="pe-shape-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    # Two side-by-side 100x100 frames on a 200x100 canvas.
    surface = {
        "canvas": {"width": 200, "height": 100, "widthMm": 200, "dpi": 300},
        "frames": [
            {"x": 0,   "y": 0, "width": 100, "height": 100},
            {"x": 100, "y": 0, "width": 100, "height": 100},
        ],
    }
    # Frame 0: contain + scale 3 (image overflows its box). Frame 1: empty.
    canvas = _engine(work)._composite_canvas(
        surface, [red, ""], "cover", None,
        frame_transforms=[{"fit_mode": "contain", "scale": 3.0}, {}],
    )
    assert _near(canvas.getpixel((50, 50)), (255, 0, 0)), "frame 0 should contain RED"
    assert _near(canvas.getpixel((150, 50)), (255, 255, 255)), \
        "frame 1 should be BLANK — the zoomed image bled across the frame boundary"


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
    print(f"All {len(funcs)} frame-shape tests passed.")


if __name__ == "__main__":
    _run_all()
