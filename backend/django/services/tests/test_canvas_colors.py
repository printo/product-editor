"""
Tests for canvas background + paper-mat colour rendering in
layout_engine.engine._composite_canvas (Phase-2 WYSIWYG).

Guards that the customer's chosen colours reach the print:
  - bgColor fills the canvas (shown beneath frames / through transparent areas)
    instead of the hardcoded white.
  - paperColor paints a mat around the frames, with frame-shaped holes, so the
    photo shows through and the mat surrounds it.
  - The all-white default is byte-identical to the previous behaviour.

Run stand-alone:
    cd backend/django && python -m services.tests.test_canvas_colors
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


def _near(px, target, tol: int = 30) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px[:3], target))


def _engine(work: str) -> LayoutEngine:
    return LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))


def _one_small_frame_surface() -> dict:
    # A single 100x100 frame centred in a 300x300 canvas, so there is plenty of
    # background/mat area around it to sample.
    return {
        "canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
        "frames": [{"x": 100, "y": 100, "width": 100, "height": 100}],
    }


# ─── _parse_hex_color ─────────────────────────────────────────────────────────

def test_parse_hex_color_variants():
    p = LayoutEngine._parse_hex_color
    assert p("#ff0000") == (255, 0, 0)
    assert p("00ff00") == (0, 255, 0)
    assert p("#00f") == (0, 0, 255)          # short form expands
    assert p(None) == (255, 255, 255)         # default white
    assert p("not-a-color") == (255, 255, 255)
    assert p("#12345") == (255, 255, 255)     # wrong length -> default


# ─── background colour ────────────────────────────────────────────────────────

def test_background_color_fills_canvas():
    work = tempfile.mkdtemp(prefix="pe-color-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    surface = _one_small_frame_surface()
    canvas = _engine(work)._composite_canvas(
        surface, [red], "cover", None, frame_transforms=[{}],
        background="#0000ff",  # blue background
    )
    # Corner (outside the frame) should be the blue background.
    assert _near(canvas.getpixel((10, 10)), (0, 0, 255)), "background should be blue"
    # Inside the frame the photo (red) still shows.
    assert _near(canvas.getpixel((150, 150)), (255, 0, 0)), "frame should show the photo"


def test_default_white_background_unchanged():
    work = tempfile.mkdtemp(prefix="pe-color-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    surface = _one_small_frame_surface()
    canvas = _engine(work)._composite_canvas(surface, [red], "cover", None, frame_transforms=[{}])
    assert _near(canvas.getpixel((10, 10)), (255, 255, 255)), "no background arg -> white as before"


# ─── paper mat ────────────────────────────────────────────────────────────────

def test_paper_mat_surrounds_frame_and_photo_shows_through():
    work = tempfile.mkdtemp(prefix="pe-color-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    surface = _one_small_frame_surface()
    canvas = _engine(work)._composite_canvas(
        surface, [red], "cover", None, frame_transforms=[{}],
        background="#ffffff", paper_color="#00aa00",  # green mat
    )
    # Mat area (around the frame) is green.
    assert _near(canvas.getpixel((10, 10)), (0, 170, 0)), "mat should be green"
    # The photo shows through the frame hole.
    assert _near(canvas.getpixel((150, 150)), (255, 0, 0)), "photo should show through the hole"


def test_paper_equal_to_background_is_noop():
    """When mat == background there is nothing to paint; frame still renders."""
    work = tempfile.mkdtemp(prefix="pe-color-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    surface = _one_small_frame_surface()
    canvas = _engine(work)._composite_canvas(
        surface, [red], "cover", None, frame_transforms=[{}],
        background="#ffffff", paper_color="#ffffff",
    )
    assert _near(canvas.getpixel((10, 10)), (255, 255, 255))
    assert _near(canvas.getpixel((150, 150)), (255, 0, 0))


def test_circle_frame_hole_in_paper_mat_is_round():
    """The mat hole honours the frame's circular shape: the frame's bounding-box
    corner is mat colour (outside the circle), the centre is the photo."""
    work = tempfile.mkdtemp(prefix="pe-color-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    surface = {
        "canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
        "frames": [{"x": 100, "y": 100, "width": 100, "height": 100, "borderRadiusMm": 150}],
    }
    canvas = _engine(work)._composite_canvas(
        surface, [red], "cover", None, frame_transforms=[{}],
        paper_color="#00aa00",
    )
    assert _near(canvas.getpixel((150, 150)), (255, 0, 0)), "circle centre = photo"
    # Corner of the frame's bounding box is outside the circle -> mat (green).
    assert _near(canvas.getpixel((103, 103)), (0, 170, 0)), "frame-box corner = mat (outside circle)"


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
    print(f"All {len(funcs)} canvas-colour tests passed.")


if __name__ == "__main__":
    _run_all()
