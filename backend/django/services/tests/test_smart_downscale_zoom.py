"""
Tests for zoom-aware smart-downscale (Phase 2 item 5 — "respect zoom in
smart-downscale").

Background — the bug this guards against:
    _composite_canvas pre-shrank every source to 2× the RAW frame size before
    compositing, ignoring the customer's zoom. At zoom z the visible window is
    cut from only (2/z)× frame-width pixels of the pre-shrunk source — above
    2× zoom the 300 DPI print upsamples a pre-destroyed source and comes out
    soft even when the original photo had ample resolution.

Run stand-alone:
    cd backend/django && python -m services.tests.test_smart_downscale_zoom
"""
from __future__ import annotations

import os
import sys
import tempfile

from PIL import Image

from layout_engine.engine import LayoutEngine


def _gradient(path: str, w: int = 4000, h: int = 3000) -> str:
    """Large gradient source (built with Pillow C ops — cheap at any size)."""
    img = Image.linear_gradient("L").resize((w, h)).convert("RGB")
    img.save(path)
    return path


def _one_frame_surface(size: int = 400) -> dict:
    return {
        "canvas": {"width": size, "height": size},
        "frames": [{"x": 0, "y": 0, "width": size, "height": size}],
    }


class _SpyEngine(LayoutEngine):
    """Records the target passed to _smart_downscale and the resulting size."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.downscale_calls = []

    def _smart_downscale(self, img, target_w, target_h):  # type: ignore[override]
        self.downscale_calls.append((target_w, target_h))
        out = LayoutEngine._smart_downscale(img, target_w, target_h)
        self.post_downscale_size = out.size
        return out


def _composite(engine, scale, src, size=400):
    surface = _one_frame_surface(size)
    return engine._composite_canvas(
        surface, [src], "cover", None, frame_transforms=[{"scale": scale}],
    )


def test_zoom_multiplies_downscale_target():
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"))
    eng = _SpyEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    _composite(eng, 3.0, src)

    assert eng.downscale_calls == [(1200, 1200)], (
        f"zoom 3× on a 400px frame must pre-shrink to a 1200px target, "
        f"got {eng.downscale_calls}"
    )
    # 2× headroom inside _smart_downscale ⇒ working copy keeps ≥ 2400px on
    # the long side (capped by the 4000px source, which is above that).
    assert eng.post_downscale_size[0] >= 2400, eng.post_downscale_size


def test_zoom_one_keeps_previous_target():
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"))
    eng = _SpyEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    _composite(eng, 1.0, src)
    assert eng.downscale_calls == [(400, 400)]


def test_zoom_out_never_shrinks_target_below_frame():
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"))
    eng = _SpyEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    _composite(eng, 0.5, src)
    assert eng.downscale_calls == [(400, 400)], "scale<1 must clamp to the raw frame target"


def test_missing_scale_defaults_to_one():
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"))
    eng = _SpyEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    surface = _one_frame_surface()
    eng._composite_canvas(surface, [src], "cover", None, frame_transforms=[{}])
    assert eng.downscale_calls == [(400, 400)]


def test_hostile_scale_clamped():
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"), 800, 600)
    eng = _SpyEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    _composite(eng, 10_000.0, src)
    (tw, th), = eng.downscale_calls
    assert tw <= 4000 and th <= 4000, f"hostile zoom must be clamped, got target {(tw, th)}"


def test_rotation_with_zoom_still_renders():
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"), 1000, 800)
    eng = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    surface = _one_frame_surface()
    canvas = eng._composite_canvas(
        surface, [src], "cover", None,
        frame_transforms=[{"scale": 2.5, "rotation": 90}],
    )
    assert canvas.size == (400, 400)


def test_zoomed_output_keeps_detail():
    """Quality proxy: at 3× zoom the fixed code must retain visibly more
    detail than a source pre-shrunk to the unzoomed target would."""
    work = tempfile.mkdtemp(prefix="pe-zoom-")
    src = _gradient(os.path.join(work, "g.png"))
    eng = _SpyEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))

    _composite(eng, 3.0, src)
    # Post-downscale the working copy must hold at least frame_px × zoom
    # pixels across (the minimum for 1:1 sampling in the visible window).
    assert eng.post_downscale_size[0] >= 400 * 3, eng.post_downscale_size


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
    print(f"All {len(funcs)} smart-downscale-zoom tests passed.")


if __name__ == "__main__":
    _run_all()
