"""
Unit tests for services.book_layout — page-count resolution, gutter
mirroring, spine width, display labels, and page materialization
(BOOK_LAYOUT_PRD.md, D1/D2/D5/D6/D7).

Run with:
    cd backend/django && python -m services.tests.test_book_layout
"""
from __future__ import annotations

import os
import sys

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from services.book_layout import (  # noqa: E402
    ROLE_BACK_COVER,
    ROLE_COVER,
    ROLE_INNER,
    apply_gutter,
    display_label_for,
    gutter_shift_fraction,
    gutter_side_for,
    materialize_pages,
    page_count_bounds,
    pages_to_spreads,
    resolve_page_count,
    spine_width_mm,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _book_layout(**extra) -> dict:
    base = {
        "name": "softcover_a4",
        "productType": "book",
        "book": {
            "bleedMm": 3,
            "gutterMm": 12,
            "pageCount": {"min": 20, "max": 60, "step": 4, "default": 24},
            "paperThicknessMm": 0.12,
            "cover": {
                "canvas": {"width": 3579, "height": 2551, "widthMm": 303, "heightMm": 216, "dpi": 300},
                "frames": [{"id": "c0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}],
            },
            "innerPage": {
                "canvas": {"width": 3508, "height": 2480, "widthMm": 297, "heightMm": 210, "dpi": 300},
                "frames": [{"id": "p0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}],
            },
            "backCover": {
                "canvas": {"width": 3579, "height": 2551, "widthMm": 303, "heightMm": 216, "dpi": 300},
                "frames": [],
            },
        },
    }
    base.update(extra)
    return base


def _collage_book(**extra) -> dict:
    """An inner page with 2 frames — the 'collage' shape needs no schema flag."""
    layout = _book_layout(**extra)
    layout["book"]["innerPage"]["frames"] = [
        {"id": "left", "x": 0.02, "y": 0.05, "width": 0.46, "height": 0.9},
        {"id": "right", "x": 0.52, "y": 0.05, "width": 0.46, "height": 0.9},
    ]
    return layout


# ── page_count_bounds / resolve_page_count (D2) ─────────────────────────────

def test_page_count_bounds_reads_template():
    layout = _book_layout()
    assert page_count_bounds(layout) == (20, 60, 4, 24)


def test_resolve_page_count_uses_default_when_none():
    assert resolve_page_count(_book_layout(), None) == 24


def test_resolve_page_count_snaps_up_to_step_grid():
    layout = _book_layout()
    # 26 is not on the (20, 24, 28, ...) grid — must round UP, never down,
    # so the customer never silently loses a page they asked for.
    assert resolve_page_count(layout, 26) == 28


def test_resolve_page_count_on_grid_is_unchanged():
    assert resolve_page_count(_book_layout(), 32) == 32


def test_resolve_page_count_clamps_below_min():
    assert resolve_page_count(_book_layout(), 4) == 20


def test_resolve_page_count_clamps_above_max():
    assert resolve_page_count(_book_layout(), 200) == 60


def test_resolve_page_count_handles_garbage_input():
    assert resolve_page_count(_book_layout(), "not-a-number") == 24
    assert resolve_page_count(_book_layout(), None) == 24


# ── gutter_side_for (D5) ─────────────────────────────────────────────────────

def test_gutter_side_odd_pages_bind_left():
    assert gutter_side_for(1) == "left"
    assert gutter_side_for(3) == "left"


def test_gutter_side_even_pages_bind_right():
    assert gutter_side_for(2) == "right"
    assert gutter_side_for(4) == "right"


# ── gutter_shift_fraction / apply_gutter ────────────────────────────────────

def test_gutter_shift_moves_away_from_bound_edge():
    frames = [{"x": 0.05, "width": 0.9}]
    # 297mm page, 12mm gutter → 6mm each side → 6/297 ≈ 0.0202.
    shift = gutter_shift_fraction(frames, [], 12.0, 297.0, "left")
    assert shift > 0  # left-bound page shifts content RIGHT (away from spine)
    assert abs(shift - (6.0 / 297.0)) < 1e-9


def test_gutter_shift_right_bound_is_negative():
    frames = [{"x": 0.05, "width": 0.9}]
    shift = gutter_shift_fraction(frames, [], 12.0, 297.0, "right")
    assert shift < 0


def test_gutter_shift_clamped_by_headroom():
    # Frame already touches the left edge (x=0) — a left-bound page has zero
    # room to shift right without pushing the frame off-canvas... wait, a
    # left-bound page shifts RIGHT (away from the left edge), so headroom is
    # on the RIGHT: width=1.0 leaves no room to grow rightward.
    frames = [{"x": 0.0, "width": 1.0}]
    shift = gutter_shift_fraction(frames, [], 12.0, 297.0, "left")
    assert shift == 0.0


def test_gutter_shift_zero_when_no_canvas_width():
    frames = [{"x": 0.05, "width": 0.9}]
    assert gutter_shift_fraction(frames, [], 12.0, None, "left") == 0.0


def test_gutter_shift_zero_when_gutter_zero():
    frames = [{"x": 0.05, "width": 0.9}]
    assert gutter_shift_fraction(frames, [], 0, 297.0, "left") == 0.0


def test_apply_gutter_shifts_both_x_and_xmm():
    frames = [{"x": 0.05, "xMm": 15.0, "width": 0.9}]
    canvas = {"widthMm": 297.0}
    shifted, _ = apply_gutter(frames, [], 12.0, canvas, "left")
    assert shifted[0]["x"] > frames[0]["x"]
    assert shifted[0]["xMm"] > frames[0]["xMm"]


def test_apply_gutter_shifts_overlay_percent_coords():
    overlays = [{"x": 5.0, "width": 20.0, "type": "text"}]
    canvas = {"widthMm": 297.0}
    shifted, shifted_overlays = apply_gutter([], overlays, 12.0, canvas, "left")
    assert shifted_overlays[0]["x"] > overlays[0]["x"]


def test_apply_gutter_collage_moves_together_not_distorted():
    # A tight frame on the far side caps the shift for the WHOLE page — the
    # loose frame must move by the SAME amount, not its own larger amount,
    # or a collage would visibly skew apart.
    frames = [
        {"x": 0.02, "width": 0.46},   # plenty of room to shift right
        {"x": 0.52, "width": 0.46},   # x+width = 0.98, only 0.02 headroom
    ]
    canvas = {"widthMm": 297.0}
    shifted, _ = apply_gutter(frames, [], 40.0, canvas, "left")  # ask for a huge shift
    dx0 = shifted[0]["x"] - frames[0]["x"]
    dx1 = shifted[1]["x"] - frames[1]["x"]
    assert abs(dx0 - dx1) < 1e-9


# ── spine_width_mm (D4 / R2) ─────────────────────────────────────────────────

def test_spine_width_uses_leaves_not_sides():
    # 24 printed sides = 12 leaves.
    assert abs(spine_width_mm(24, 0.12) - (12 * 0.12)) < 1e-9


def test_spine_width_includes_cover_thickness():
    spine = spine_width_mm(24, 0.12, cover_thickness_mm=0.6)
    assert abs(spine - (12 * 0.12 + 2 * 0.6)) < 1e-9


def test_spine_width_zero_page_count():
    assert spine_width_mm(0, 0.12) == 0.0


# ── display_label_for (U6 — mechanical collation) ───────────────────────────

def test_display_label_cover_and_pages_sort_naturally():
    total = 26  # cover + 24 pages + back cover
    cover = display_label_for(ROLE_COVER, None, 1, total)
    p1 = display_label_for(ROLE_INNER, 1, 2, total)
    back = display_label_for(ROLE_BACK_COVER, None, 26, total)
    assert cover == "01 Front Cover"
    assert p1 == "02 Page 01"
    assert back == "26 Back Cover"
    # Plain alphabetical sort of the three labels must already be print order.
    assert sorted([back, cover, p1]) == [cover, p1, back]


# ── pages_to_spreads (D6) ────────────────────────────────────────────────────

def test_pages_to_spreads_groups_facing_pages():
    pages = [
        {"role": ROLE_COVER}, {"role": ROLE_INNER, "pageIndex": 1},
        {"role": ROLE_INNER, "pageIndex": 2}, {"role": ROLE_INNER, "pageIndex": 3},
        {"role": ROLE_INNER, "pageIndex": 4}, {"role": ROLE_BACK_COVER},
    ]
    spreads = pages_to_spreads(pages)
    sizes = [len(s) for s in spreads]
    # cover alone, page1 alone (recto with nothing facing it), (2,3), (4,) trailing verso alone, back cover alone
    assert sizes == [1, 1, 2, 1, 1]


# ── materialize_pages (§5.2) ─────────────────────────────────────────────────

def test_materialize_pages_default_count_flat_list():
    surfaces = materialize_pages(_book_layout())
    # default 24 + front + back = 26.
    assert len(surfaces) == 26
    assert surfaces[0]["role"] == ROLE_COVER
    assert surfaces[-1]["role"] == ROLE_BACK_COVER
    assert [s["role"] for s in surfaces[1:-1]] == [ROLE_INNER] * 24


def test_materialize_pages_page_index_is_1_based_and_ordered():
    surfaces = materialize_pages(_book_layout(), page_count=20)
    inner = [s for s in surfaces if s["role"] == ROLE_INNER]
    assert [s["pageIndex"] for s in inner] == list(range(1, 21))


def test_materialize_pages_covers_have_no_page_index():
    surfaces = materialize_pages(_book_layout(), page_count=20)
    assert surfaces[0]["pageIndex"] is None
    assert surfaces[-1]["pageIndex"] is None


def test_materialize_pages_keys_are_stable_and_addressable():
    surfaces = materialize_pages(_book_layout(), page_count=20)
    assert surfaces[0]["key"] == "cover"
    assert surfaces[-1]["key"] == "back_cover"
    assert surfaces[1]["key"] == "page_01"
    assert surfaces[10]["key"] == "page_10"


def test_materialize_pages_per_role_canvas_can_differ():
    # Cover (303x216mm) is physically larger than the inner block (297x210mm)
    # — D7's whole point.
    surfaces = materialize_pages(_book_layout(), page_count=20)
    cover_canvas = surfaces[0]["canvas"]
    inner_canvas = surfaces[1]["canvas"]
    assert cover_canvas["widthMm"] == 303
    assert inner_canvas["widthMm"] == 297


def test_materialize_pages_page_count_changing_preserves_cover_role():
    # D2: changing page count must never renumber or misidentify covers —
    # they are addressed by role, never index.
    small = materialize_pages(_book_layout(), page_count=20)
    large = materialize_pages(_book_layout(), page_count=40)
    assert small[0]["role"] == large[0]["role"] == ROLE_COVER
    assert small[-1]["role"] == large[-1]["role"] == ROLE_BACK_COVER


def test_materialize_pages_gutter_mirrors_by_parity():
    surfaces = materialize_pages(_book_layout(), page_count=4)
    inner = [s for s in surfaces if s["role"] == ROLE_INNER]
    assert inner[0]["gutterSide"] == "left"   # page 1
    assert inner[1]["gutterSide"] == "right"  # page 2
    assert inner[2]["gutterSide"] == "left"   # page 3
    assert inner[3]["gutterSide"] == "right"  # page 4
    # Frame actually moved relative to the un-shifted template.
    template_x = _book_layout()["book"]["innerPage"]["frames"][0]["x"]
    assert inner[0]["frames"][0]["x"] != template_x


def test_materialize_pages_covers_have_no_gutter_side():
    surfaces = materialize_pages(_book_layout(), page_count=4)
    assert surfaces[0]["gutterSide"] is None
    assert surfaces[-1]["gutterSide"] is None


def test_materialize_pages_collage_inner_page_frame_count_preserved():
    surfaces = materialize_pages(_collage_book(), page_count=4)
    inner = [s for s in surfaces if s["role"] == ROLE_INNER]
    for s in inner:
        assert len(s["frames"]) == 2  # collage shape survives materialization untouched


def test_materialize_pages_spine_width_on_covers_only():
    surfaces = materialize_pages(_book_layout(), page_count=24)
    assert "spineWidthMm" in surfaces[0]
    assert "spineWidthMm" in surfaces[-1]
    assert "spineWidthMm" not in surfaces[1]
    assert abs(surfaces[0]["spineWidthMm"] - (12 * 0.12)) < 1e-9


def test_materialize_pages_back_cover_falls_back_to_front_cover_canvas():
    layout = _book_layout()
    del layout["book"]["backCover"]
    surfaces = materialize_pages(layout, page_count=4)
    assert surfaces[-1]["canvas"]["widthMm"] == surfaces[0]["canvas"]["widthMm"]


def test_materialize_pages_page_overrides_reposition_without_changing_count():
    layout = _book_layout()
    layout["pageOverrides"] = {
        "2": {"frames": [{"id": "p0", "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}]},
    }
    surfaces = materialize_pages(layout, page_count=4)
    page2 = next(s for s in surfaces if s.get("pageIndex") == 2)
    assert page2["frames"][0]["x"] != layout["book"]["innerPage"]["frames"][0]["x"]


def test_materialize_pages_rejects_non_book_layout():
    try:
        materialize_pages({"productType": "calendar"})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_materialize_pages_requires_book_block():
    try:
        materialize_pages({"productType": "book"})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_engine_refuses_book_render_without_canvases_meta():
    # The direct-partner /api/layout/generate endpoint never builds
    # canvases_meta — a book fed the full photo list per page would flood
    # the exports directory rather than fail loudly. Engine-level guard,
    # not a book_layout.py concern, but pinned here alongside the other
    # book coverage since it protects the same materializer's contract.
    import os
    import tempfile
    from layout_engine.engine import LayoutEngine

    with tempfile.TemporaryDirectory() as layouts_dir, tempfile.TemporaryDirectory() as exports_dir:
        layout = _book_layout()
        with open(os.path.join(layouts_dir, "test_book.json"), "w") as f:
            import json
            json.dump(layout, f)
        engine = LayoutEngine(layouts_dir, exports_dir)
        try:
            engine.generate("test_book", [], canvases_meta=None)
            assert False, "expected ValueError"
        except ValueError as e:
            assert "canvases_meta" in str(e) or "editor/render" in str(e)


# ── Stand-alone runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} book_layout tests …")
    for name, fn in tests:
        try:
            fn()
            print(f"  OK  {name}")
        except Exception as e:
            print(f"  FAIL {name}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed} test(s) FAILED")
        sys.exit(1)
    print(f"\nAll {len(tests)} book_layout tests passed.")
