"""
Tests for the position-explicit frame/photo alignment contract in
layout_engine.engine._composite_canvas (Phase-1 "silent wrong-print" fix).

Background — the bug this guards against:
    A frame whose photo was lost client-side submits an empty (`''`) slot.
    Previously the backend dropped such slots, collapsing image_paths so every
    later photo shifted one frame to the left and printed in the wrong window,
    with the last frame wrap-padded to a duplicate — all with no error.

The fix makes image_paths position-explicit (one entry per frame, `''` for a
missing photo) so it indexes identically to the per-frame transforms, and
_composite_canvas renders an empty slot as a BLANK frame instead of pulling the
next photo forward.

Run stand-alone:
    cd backend/django && python -m services.tests.test_frame_alignment
"""
from __future__ import annotations

import os
import sys
import tempfile

from PIL import Image

from layout_engine.engine import LayoutEngine


def _solid(path: str, color: tuple) -> str:
    Image.new("RGB", (200, 200), color).save(path)
    return path


def _near(px, target, tol: int = 40) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px[:3], target))


def _three_frame_surface() -> dict:
    # Three non-overlapping 300×300 frames across a 900×300 canvas.
    return {
        "canvas": {"width": 900, "height": 300},
        "frames": [
            {"x": 0,   "y": 0, "width": 300, "height": 300},
            {"x": 300, "y": 0, "width": 300, "height": 300},
            {"x": 600, "y": 0, "width": 300, "height": 300},
        ],
    }


def _center(surface: dict, i: int, canvas: Image.Image):
    f = surface["frames"][i]
    return canvas.getpixel((f["x"] + f["width"] // 2, f["y"] + f["height"] // 2))


def test_missing_middle_photo_stays_blank_and_others_keep_position():
    """[RED, '', BLUE] → RED in f0, BLANK in f1, BLUE in f2 (no shift)."""
    work = tempfile.mkdtemp(prefix="pe-align-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    blue = _solid(os.path.join(work, "blue.png"), (0, 0, 255))
    surface = _three_frame_surface()
    eng = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    canvas = eng._composite_canvas(
        surface, [red, "", blue], "cover", None, frame_transforms=[{}, {}, {}],
    )

    assert _near(_center(surface, 0, canvas), (255, 0, 0)), "frame 0 should be RED"
    assert _near(_center(surface, 1, canvas), (255, 255, 255)), "frame 1 should be BLANK"
    assert _near(_center(surface, 2, canvas), (0, 0, 255)), "frame 2 should be BLUE"


def test_blue_does_not_leak_into_the_empty_slot():
    """The specific misprint symptom: BLUE must NOT appear in the empty frame 1."""
    work = tempfile.mkdtemp(prefix="pe-align-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    blue = _solid(os.path.join(work, "blue.png"), (0, 0, 255))
    surface = _three_frame_surface()
    eng = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    canvas = eng._composite_canvas(
        surface, [red, "", blue], "cover", None, frame_transforms=[{}, {}, {}],
    )
    assert not _near(_center(surface, 1, canvas), (0, 0, 255)), \
        "BLUE printed in the empty frame 1 — the wrong-print bug is back"


def test_all_photos_present_renders_each_in_its_own_frame():
    """No gap → straightforward 1:1 placement still works."""
    work = tempfile.mkdtemp(prefix="pe-align-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    green = _solid(os.path.join(work, "green.png"), (0, 200, 0))
    blue = _solid(os.path.join(work, "blue.png"), (0, 0, 255))
    surface = _three_frame_surface()
    eng = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    canvas = eng._composite_canvas(
        surface, [red, green, blue], "cover", None, frame_transforms=[{}, {}, {}],
    )
    assert _near(_center(surface, 0, canvas), (255, 0, 0))
    assert _near(_center(surface, 1, canvas), (0, 200, 0))
    assert _near(_center(surface, 2, canvas), (0, 0, 255))


def test_trailing_missing_photo_leaves_last_frame_blank():
    """[RED, GREEN, ''] → last frame blank, first two unaffected."""
    work = tempfile.mkdtemp(prefix="pe-align-")
    red = _solid(os.path.join(work, "red.png"), (255, 0, 0))
    green = _solid(os.path.join(work, "green.png"), (0, 200, 0))
    surface = _three_frame_surface()
    eng = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    canvas = eng._composite_canvas(
        surface, [red, green, ""], "cover", None, frame_transforms=[{}, {}, {}],
    )
    assert _near(_center(surface, 0, canvas), (255, 0, 0))
    assert _near(_center(surface, 1, canvas), (0, 200, 0))
    assert _near(_center(surface, 2, canvas), (255, 255, 255)), "frame 2 should be BLANK"


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
    print(f"All {len(funcs)} frame-alignment tests passed.")


if __name__ == "__main__":
    _run_all()
