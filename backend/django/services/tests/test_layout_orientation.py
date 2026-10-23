"""
Tests for services.layout_orientation: the one quarter-turn transform that the
editor-init response and the render task both use.

Pure Python, no Django.

Run stand-alone:
    cd backend/django && python -m services.tests.test_layout_orientation
"""
from __future__ import annotations

import copy

from services.layout_orientation import apply_orientation, layout_orientation


def _landscape() -> dict:
    return {
        "name": "two_up",
        "canvas": {"width": 3000, "height": 2000, "widthMm": 300, "heightMm": 200, "dpi": 254},
        "frames": [
            {"id": "a", "x": 0.05, "y": 0.1, "width": 0.4, "height": 0.8,
             "xMm": 15, "yMm": 20, "widthMm": 120, "heightMm": 160},
            {"id": "b", "x": 0.55, "y": 0.1, "width": 0.4, "height": 0.8,
             "xMm": 165, "yMm": 20, "widthMm": 120, "heightMm": 160},
        ],
        "maskUrl": None,
    }


def _close(a, b):
    return abs(a - b) < 1e-9


def test_landscape_to_portrait_turns_canvas_and_frames():
    out, report = apply_orientation(_landscape(), "portrait")
    assert report == {"requested": "portrait", "applied": True, "reason": None, "orientation": "portrait"}
    assert out["canvas"]["width"] == 2000 and out["canvas"]["height"] == 3000
    assert out["canvas"]["widthMm"] == 200 and out["canvas"]["heightMm"] == 300
    a, b = out["frames"]
    assert [f["id"] for f in out["frames"]] == ["a", "b"]
    # frame a: x' = 1 - 0.1 - 0.8, y' = 0.05, w' = 0.8, h' = 0.4
    assert _close(a["x"], 0.1) and _close(a["y"], 0.05) and _close(a["width"], 0.8) and _close(a["height"], 0.4)
    assert _close(b["y"], 0.55)
    assert a["xMm"] == 200 - 20 - 160 and a["yMm"] == 15
    assert a["widthMm"] == 160 and a["heightMm"] == 120


def test_input_is_never_mutated():
    src = _landscape()
    before = copy.deepcopy(src)
    apply_orientation(src, "portrait")
    assert src == before


def test_two_quarter_turns_make_a_half_turn():
    once, _ = apply_orientation(_landscape(), "portrait")
    twice, _ = apply_orientation(once, "landscape")
    orig = _landscape()
    assert twice["canvas"] == orig["canvas"]
    for got, want in zip(twice["frames"], orig["frames"]):
        assert _close(got["x"], 1 - want["x"] - want["width"])
        assert _close(got["y"], 1 - want["y"] - want["height"])
        assert _close(got["width"], want["width"]) and _close(got["height"], want["height"])


def test_frames_stay_inside_the_canvas():
    out, _ = apply_orientation(_landscape(), "portrait")
    for f in out["frames"]:
        assert f["x"] >= 0 and f["y"] >= 0
        assert f["x"] + f["width"] <= 1 + 1e-9 and f["y"] + f["height"] <= 1 + 1e-9


def test_not_sent_and_invalid_serve_as_authored():
    src = _landscape()
    for raw, reason in ((None, "not_sent"), ("", "not_sent"), ("  ", "not_sent"),
                        ("sideways", "invalid_value"), (7, "invalid_value")):
        out, report = apply_orientation(src, raw)
        assert out is src and report["applied"] is False and report["reason"] == reason, (raw, report)
        assert report["orientation"] == "landscape"


def test_same_orientation_and_square_do_nothing():
    out, report = apply_orientation(_landscape(), " Landscape ")
    assert out["canvas"]["width"] == 3000 and report["reason"] == "already_that_orientation"
    sq = _landscape()
    sq["canvas"].update(width=2000, height=2000)
    out, report = apply_orientation(sq, "portrait")
    assert report["reason"] == "square_layout" and report["applied"] is False


def test_opt_out_flag_and_product_types():
    flagged = {**_landscape(), "orientationRotatable": False}
    assert apply_orientation(flagged, "portrait")[1]["reason"] == "not_rotatable"
    for pt in ("calendar", "book"):
        assert apply_orientation({**_landscape(), "productType": pt}, "portrait")[1]["reason"] == "not_rotatable"


def test_captions_overlays_and_svg_masks_are_left_alone():
    assert apply_orientation({**_landscape(), "frameCaptionsEnabled": True}, "portrait")[1]["reason"] == "has_captions"
    assert apply_orientation({**_landscape(), "overlays": [{"type": "text"}]}, "portrait")[1]["reason"] == "has_overlays"
    assert apply_orientation({**_landscape(), "maskUrl": "/api/layouts/masks/m.svg"}, "portrait")[1]["reason"] == "svg_mask"


def test_raster_mask_is_marked_for_a_matching_turn():
    src = {**_landscape(), "maskUrl": "/api/layouts/masks/m.png", "maskOnExport": True}
    out, report = apply_orientation(src, "portrait")
    assert report["applied"] is True
    assert out["maskUrl"] == "/api/layouts/masks/m.png?rotate=90" and out["maskRotate"] == 90
    assert src["maskUrl"] == "/api/layouts/masks/m.png"


def test_multi_surface_layout_turns_every_surface():
    surf = lambda key: {"key": key, "canvas": _landscape()["canvas"], "frames": _landscape()["frames"], "maskUrl": None}
    src = {"name": "p", "type": "product", "surfaces": [surf("front"), surf("back")]}
    out, report = apply_orientation(src, "portrait")
    assert report["applied"] is True
    assert all(s["canvas"]["width"] == 2000 for s in out["surfaces"])
    assert layout_orientation(out) == "portrait"


def test_pixel_frames_and_grid_layouts():
    px = {"canvas": {"width": 300, "height": 200}, "frames": [{"x": 10, "y": 20, "width": 100, "height": 50}]}
    out, _ = apply_orientation(px, "portrait")
    f = out["frames"][0]
    assert (f["x"], f["y"], f["width"], f["height"]) == (200 - 20 - 50, 10, 50, 100)
    grid = {"canvas": {"width": 300, "height": 200}, "grid": {"rows": 2, "cols": 3, "padding": 5}}
    out, _ = apply_orientation(grid, "portrait")
    assert out["grid"] == {"rows": 3, "cols": 2, "padding": 5}


def test_frame_mm_dropped_when_canvas_mm_is_unknown():
    src = _landscape()
    del src["canvas"]["widthMm"], src["canvas"]["heightMm"]
    out, _ = apply_orientation(src, "portrait")
    assert "xMm" not in out["frames"][0] and _close(out["frames"][0]["x"], 0.1)


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
