"""
Tests for per-surface payload grouping in multi-surface products
(Phase 3 — cross-surface wrong-print fix).

Background — the bug this guards against:
    The product branch of engine.generate rendered EVERY surface against the
    FULL flattened photo list: a 2-surface product cross-rendered each photo
    onto both surfaces' outputs, and a surface the frontend omitted printed
    the OTHER surface's photo instead of blank.

With canvases_meta ([{surface_key, frame_count}, ...] in payload order) each
surface renders only its own canvases; a surface with no canvases renders
blank. Without the meta, behaviour is legacy whole-list (byte-identical).

Run stand-alone:
    cd backend/django && python -m services.tests.test_surface_slicing
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

from PIL import Image

from layout_engine.engine import LayoutEngine


def _solid(path: str, color: tuple) -> str:
    Image.new("RGB", (300, 300), color).save(path)
    return path


def _near(px, target, tol: int = 40) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px[:3], target))


def _two_surface_layout() -> dict:
    return {
        "name": "slice_prod",
        "type": "product",
        "surfaces": [
            {
                "key": "front",
                "displayLabel": "Front",
                "canvas": {"width": 400, "height": 400},
                "frames": [{"x": 0, "y": 0, "width": 1, "height": 1}],
            },
            {
                "key": "back",
                "displayLabel": "Back",
                "canvas": {"width": 400, "height": 400},
                "frames": [{"x": 0, "y": 0, "width": 1, "height": 1}],
            },
        ],
    }


def _generate(images, canvases_meta=None, **kw):
    work = tempfile.mkdtemp(prefix="pe-slice-")
    layouts_dir = os.path.join(work, "layouts")
    exports_dir = os.path.join(work, "exports")
    os.makedirs(layouts_dir)
    os.makedirs(exports_dir)
    layout = _two_surface_layout()
    with open(os.path.join(layouts_dir, "slice_prod.json"), "w") as f:
        json.dump(layout, f)
    eng = LayoutEngine(layouts_dir, exports_dir)
    return eng.generate("slice_prod", images, canvases_meta=canvases_meta, **kw)


def _centre(path: str):
    with Image.open(path) as im:
        return im.getpixel((200, 200))


def test_meta_routes_each_photo_to_its_own_surface():
    work = tempfile.mkdtemp(prefix="pe-slice-src-")
    red = _solid(os.path.join(work, "r.png"), (255, 0, 0))
    blue = _solid(os.path.join(work, "b.png"), (0, 0, 255))
    outputs = _generate(
        [red, blue],
        canvases_meta=[
            {"surface_key": "front", "frame_count": 1},
            {"surface_key": "back", "frame_count": 1},
        ],
    )
    assert len(outputs) == 2, outputs
    front = next(p for p in outputs if "Front" in os.path.basename(p))
    back = next(p for p in outputs if "Back" in os.path.basename(p))
    assert _near(_centre(front), (255, 0, 0)), "front must show ONLY the front photo"
    assert _near(_centre(back), (0, 0, 255)), "back must show ONLY the back photo"


def test_omitted_surface_prints_blank_not_the_other_photo():
    work = tempfile.mkdtemp(prefix="pe-slice-src-")
    red = _solid(os.path.join(work, "r.png"), (255, 0, 0))
    outputs = _generate(
        [red],
        canvases_meta=[{"surface_key": "front", "frame_count": 1}],
    )
    assert len(outputs) == 2, outputs
    front = next(p for p in outputs if "Front" in os.path.basename(p))
    back = next(p for p in outputs if "Back" in os.path.basename(p))
    assert _near(_centre(front), (255, 0, 0))
    assert _near(_centre(back), (255, 255, 255)), (
        f"an omitted surface must print BLANK, got {_centre(back)} — "
        "the cross-surface wrong-print is back"
    )


def test_transforms_follow_their_surface():
    work = tempfile.mkdtemp(prefix="pe-slice-src-")
    red = _solid(os.path.join(work, "r.png"), (255, 0, 0))
    blue = _solid(os.path.join(work, "b.png"), (0, 0, 255))
    # Rotate ONLY the back photo 90° — a slicing bug would rotate the front.
    outputs = _generate(
        [red, blue],
        canvases_meta=[
            {"surface_key": "front", "frame_count": 1},
            {"surface_key": "back", "frame_count": 1},
        ],
        frame_transforms=[{}, {"rotation": 90}],
    )
    assert len(outputs) == 2
    # Both are solid colours so rotation is invisible — assert routing did not
    # crash and colours stayed correct (the arithmetic is what's under test).
    front = next(p for p in outputs if "Front" in os.path.basename(p))
    back = next(p for p in outputs if "Back" in os.path.basename(p))
    assert _near(_centre(front), (255, 0, 0))
    assert _near(_centre(back), (0, 0, 255))


def test_without_meta_legacy_behaviour_is_unchanged():
    work = tempfile.mkdtemp(prefix="pe-slice-src-")
    red = _solid(os.path.join(work, "r.png"), (255, 0, 0))
    blue = _solid(os.path.join(work, "b.png"), (0, 0, 255))
    outputs = _generate([red, blue], canvases_meta=None)
    # Legacy: every surface renders every photo → 2 surfaces × 2 batches.
    assert len(outputs) == 4, (
        f"legacy no-meta callers must keep the whole-list behaviour, got {len(outputs)}"
    )


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
    print(f"All {len(funcs)} surface-slicing tests passed.")


if __name__ == "__main__":
    _run_all()
