"""
Unit tests for api.validators.validate_book_layout (BOOK_LAYOUT_PRD.md §5).

Run with:
    cd backend/django && python -m pytest services/tests/test_book_validator.py -v
Or stand-alone:
    cd backend/django && python -m services.tests.test_book_validator
"""
from __future__ import annotations

import os
import sys

try:
    import django
    if not os.environ.get('DJANGO_SETTINGS_MODULE'):
        os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'
    django.setup()
except Exception:
    pass

from django.core.exceptions import ValidationError
from api.validators import validate_book_layout


# ── Helpers ─────────────────────────────────────────────────────────────────

def _good_layout(**overrides) -> dict:
    base = {
        "productType": "book",
        "book": {
            "bleedMm": 3,
            "gutterMm": 12,
            "pageCount": {"min": 20, "max": 60, "step": 4, "default": 24},
            "paperThicknessMm": 0.12,
            "cover": {
                "canvas": {"width": 3579, "height": 2551, "widthMm": 303, "heightMm": 216},
                "frames": [{"id": "c0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}],
            },
            "innerPage": {
                "canvas": {"width": 3508, "height": 2480, "widthMm": 297, "heightMm": 210},
                "frames": [{"id": "p0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}],
            },
        },
    }
    base.update(overrides)
    return base


def _assert_raises(fn, needle: str):
    try:
        fn()
        assert False, f"expected ValidationError containing {needle!r}"
    except ValidationError as exc:
        msg = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
        assert needle.lower() in msg.lower(), f"{msg!r} does not contain {needle!r}"


# ── Happy path ───────────────────────────────────────────────────────────────

def test_accepts_minimal_valid_layout():
    validate_book_layout(_good_layout())  # must not raise


def test_accepts_layout_with_back_cover():
    layout = _good_layout()
    layout["book"]["backCover"] = {
        "canvas": {"width": 3579, "height": 2551, "widthMm": 303, "heightMm": 216},
        "frames": [],
    }
    validate_book_layout(layout)


def test_accepts_back_cover_without_canvas_inheriting_cover():
    layout = _good_layout()
    layout["book"]["backCover"] = {"frames": []}
    validate_book_layout(layout)


def test_accepts_page_overrides_matching_template_frame_count():
    layout = _good_layout()
    layout["pageOverrides"] = {
        "3": {"frames": [{"id": "p0", "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}]},
    }
    validate_book_layout(layout)


# ── Structural ───────────────────────────────────────────────────────────────

def test_rejects_missing_book_block():
    _assert_raises(lambda: validate_book_layout({"productType": "book"}), "book")


def test_rejects_non_dict_layout():
    _assert_raises(lambda: validate_book_layout("not a dict"), "dict")


# ── pageCount (D2) ────────────────────────────────────────────────────────────

def test_rejects_missing_page_count():
    layout = _good_layout()
    del layout["book"]["pageCount"]
    _assert_raises(lambda: validate_book_layout(layout), "pageCount")


def test_rejects_non_integer_min():
    layout = _good_layout()
    layout["book"]["pageCount"]["min"] = "twenty"
    _assert_raises(lambda: validate_book_layout(layout), "pageCount.min")


def test_rejects_max_less_than_min():
    layout = _good_layout()
    layout["book"]["pageCount"] = {"min": 60, "max": 20, "step": 4}
    _assert_raises(lambda: validate_book_layout(layout), "max")


def test_rejects_max_not_on_step_grid():
    layout = _good_layout()
    layout["book"]["pageCount"] = {"min": 20, "max": 61, "step": 4}
    _assert_raises(lambda: validate_book_layout(layout), "step")


def test_rejects_default_off_step_grid():
    layout = _good_layout()
    layout["book"]["pageCount"] = {"min": 20, "max": 60, "step": 4, "default": 22}
    _assert_raises(lambda: validate_book_layout(layout), "default")


def test_rejects_zero_step():
    layout = _good_layout()
    layout["book"]["pageCount"]["step"] = 0
    _assert_raises(lambda: validate_book_layout(layout), "step")


# ── Role templates (D2a / D7) ────────────────────────────────────────────────

def test_rejects_missing_cover_template():
    layout = _good_layout()
    del layout["book"]["cover"]
    _assert_raises(lambda: validate_book_layout(layout), "cover")


def test_rejects_missing_inner_page_template():
    layout = _good_layout()
    del layout["book"]["innerPage"]
    _assert_raises(lambda: validate_book_layout(layout), "innerPage")


def test_rejects_cover_canvas_missing_width():
    layout = _good_layout()
    del layout["book"]["cover"]["canvas"]["width"]
    _assert_raises(lambda: validate_book_layout(layout), "width")


def test_rejects_cover_canvas_zero_height():
    layout = _good_layout()
    layout["book"]["cover"]["canvas"]["height"] = 0
    _assert_raises(lambda: validate_book_layout(layout), "height")


def test_rejects_half_specified_back_cover_canvas():
    layout = _good_layout()
    layout["book"]["backCover"] = {"canvas": {"width": 3579}}  # missing height
    _assert_raises(lambda: validate_book_layout(layout), "height")


def test_rejects_inner_page_frames_not_a_list():
    layout = _good_layout()
    layout["book"]["innerPage"]["frames"] = "not-a-list"
    _assert_raises(lambda: validate_book_layout(layout), "frames")


# ── gutterMm / bleedMm / paperThicknessMm (D5) ───────────────────────────────

def test_rejects_negative_gutter():
    layout = _good_layout()
    layout["book"]["gutterMm"] = -1
    _assert_raises(lambda: validate_book_layout(layout), "gutterMm")


def test_rejects_negative_paper_thickness():
    layout = _good_layout()
    layout["book"]["paperThicknessMm"] = -0.1
    _assert_raises(lambda: validate_book_layout(layout), "paperThicknessMm")


def test_accepts_zero_gutter():
    layout = _good_layout()
    layout["book"]["gutterMm"] = 0
    validate_book_layout(layout)  # must not raise


# ── pageOverrides ─────────────────────────────────────────────────────────────

def test_rejects_page_override_key_not_an_integer():
    layout = _good_layout()
    layout["pageOverrides"] = {"cover": {"frames": []}}
    _assert_raises(lambda: validate_book_layout(layout), "page index")


def test_rejects_page_override_index_below_one():
    layout = _good_layout()
    layout["pageOverrides"] = {"0": {"frames": [
        {"id": "p0", "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}
    ]}}
    _assert_raises(lambda: validate_book_layout(layout), "1-based")


def test_rejects_page_override_frame_count_mismatch():
    layout = _good_layout()
    layout["pageOverrides"] = {"3": {"frames": [
        {"id": "a", "x": 0.0, "y": 0.0, "width": 0.4, "height": 0.4},
        {"id": "b", "x": 0.5, "y": 0.5, "width": 0.4, "height": 0.4},
    ]}}  # template has only 1 frame
    _assert_raises(lambda: validate_book_layout(layout), "exactly")


def test_rejects_page_override_frame_extending_past_edge():
    layout = _good_layout()
    layout["pageOverrides"] = {"3": {"frames": [
        {"id": "p0", "x": 0.8, "y": 0.1, "width": 0.5, "height": 0.5},
    ]}}
    _assert_raises(lambda: validate_book_layout(layout), "edge")


# ── Overlay contract shared with the calendar validator ─────────────────────

def test_rejects_overlay_using_0_to_1_fraction_by_mistake():
    layout = _good_layout()
    layout["book"]["innerPage"]["overlays"] = [
        {"type": "text", "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.05}
    ]
    _assert_raises(lambda: validate_book_layout(layout), "percent")


def test_accepts_overlay_using_percent_coords():
    layout = _good_layout()
    layout["book"]["innerPage"]["overlays"] = [
        {"type": "text", "x": 10.0, "y": 10.0, "width": 20.0, "height": 5.0}
    ]
    validate_book_layout(layout)


# ── Stand-alone runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} book_validator tests …")
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
    print(f"\nAll {len(tests)} book_validator tests passed.")
