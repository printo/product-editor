"""
Unit tests for api.validators.validate_calendar_layout
(CALENDAR_FEATURE_PRD.md §11.1 + §11.15).

Run with:
    cd backend/django && python -m pytest services/tests/test_calendar_validator.py -v
Or stand-alone:
    cd backend/django && python -m services.tests.test_calendar_validator
"""
from __future__ import annotations

import os
import sys

# Allow running without DJANGO_SETTINGS_MODULE — only ValidationError is needed,
# which the standalone-test path can stub. With Django configured, the real
# import works too.
try:
    import django
    if not os.environ.get('DJANGO_SETTINGS_MODULE'):
        os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'
    django.setup()
except Exception:
    pass

from django.core.exceptions import ValidationError
from api.validators import validate_calendar_layout


# ── Helpers ─────────────────────────────────────────────────────────────────

def _good_layout(**overrides) -> dict:
    """Baseline valid 12-month desk-calendar layout."""
    base = {
        "productType": "calendar",
        "canvas": {"width": 1500, "height": 2100, "dpi": 300},
        "frames": [{"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.5}],
        "calendars": [{"x": 0.05, "y": 0.6, "width": 0.9, "height": 0.35}],
        "calendar": {
            "themePreset": "modern-minimalist",
            "calendarType": "english",
            "weekStart": "sunday",
            "holidaySource": {"enabled": True, "locale": "en-IN", "showInCells": True},
        },
        "monthRange": {"count": 12, "defaultYear": "current"},
    }
    base.update(overrides)
    return base


def _poster_layout() -> dict:
    """Multi-calendar single-surface (year-on-one-poster) variant."""
    return {
        "productType": "calendar",
        "canvas": {"width": 3000, "height": 4200, "dpi": 300},
        "frames": [{"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.4}],
        "calendars": [
            {"x": 0.0, "y": 0.5, "width": 0.25, "height": 0.16, "monthOffset": i}
            for i in range(12)
        ],
        "calendar": {
            "themePreset": "modern-minimalist",
            "calendarType": "english",
            "weekStart": "sunday",
            "holidaySource": {"enabled": False, "locale": "generic", "showInCells": False},
        },
        "monthRange": {"count": 1, "defaultYear": 2026},
    }


def _assert_raises(layout: dict, fragment: str) -> None:
    """Assert validate_calendar_layout raises with `fragment` in the message."""
    try:
        validate_calendar_layout(layout)
    except ValidationError as exc:
        msg = (exc.messages[0] if getattr(exc, 'messages', None) else str(exc)).lower()
        if fragment.lower() not in msg:
            raise AssertionError(
                f"Expected error containing {fragment!r}, got: {msg!r}"
            )
        return
    raise AssertionError(f"Expected ValidationError containing {fragment!r}, none raised")


# ── Happy paths ─────────────────────────────────────────────────────────────

def test_desk_calendar_layout_valid():
    validate_calendar_layout(_good_layout())


def test_poster_year_on_one_page_valid():
    validate_calendar_layout(_poster_layout())


def test_concrete_year_valid():
    validate_calendar_layout(_good_layout(monthRange={"count": 12, "defaultYear": 2026}))


# ── monthRange × calendars constraint (§11.1) ───────────────────────────────

def test_rejects_when_total_months_not_12():
    layout = _good_layout(monthRange={"count": 6, "defaultYear": "current"})
    _assert_raises(layout, "exactly 12 months")


def test_rejects_when_count_zero():
    layout = _good_layout(monthRange={"count": 0, "defaultYear": "current"})
    _assert_raises(layout, "must be a positive integer")


def test_rejects_two_calendars_with_12_count():
    layout = _good_layout()
    layout["calendars"] = [{"x": 0, "y": 0.5, "width": 0.5, "height": 0.4},
                            {"x": 0.5, "y": 0.5, "width": 0.5, "height": 0.4}]
    layout["monthRange"] = {"count": 12, "defaultYear": "current"}
    _assert_raises(layout, "exactly 12 months")


# ── Calendar position fields (§4.2.1) ───────────────────────────────────────

def test_rejects_calendar_x_out_of_range():
    layout = _good_layout()
    layout["calendars"][0]["x"] = 1.5
    _assert_raises(layout, "in [0, 1]")


def test_rejects_calendar_width_zero():
    layout = _good_layout()
    layout["calendars"][0]["width"] = 0
    _assert_raises(layout, "positive width and height")


def test_rejects_calendar_negative_height():
    layout = _good_layout()
    layout["calendars"][0]["height"] = -0.1
    _assert_raises(layout, "in [0, 1]")


# ── Position-bounds checks (calendar must fit inside the canvas) ────────────

def test_rejects_calendar_extending_past_right_edge():
    """x=0.8 + width=0.5 → 1.3 lands past the canvas's right edge."""
    layout = _good_layout()
    layout["calendars"][0] = {"x": 0.8, "y": 0.1, "width": 0.5, "height": 0.5}
    _assert_raises(layout, "right canvas edge")


def test_rejects_calendar_extending_past_bottom_edge():
    """y=0.7 + height=0.5 → 1.2 lands past the canvas's bottom edge."""
    layout = _good_layout()
    layout["calendars"][0] = {"x": 0.05, "y": 0.7, "width": 0.5, "height": 0.5}
    _assert_raises(layout, "bottom canvas edge")


def test_accepts_calendar_at_exact_edge():
    """x=0.05 + width=0.95 = 1.0 — exactly fits the right edge. Must pass."""
    layout = _good_layout()
    layout["calendars"][0] = {"x": 0.05, "y": 0.05, "width": 0.95, "height": 0.5}
    validate_calendar_layout(layout)


def test_accepts_float_precision_landing_just_over_one():
    """Floats: 0.1 + 0.9 sometimes lands at 1.0000000002. Epsilon tolerates it."""
    layout = _good_layout()
    # 0.1 + 0.9 == 1.0 exactly in IEEE 754, but pick values where the
    # representation is known to drift slightly above 1.0.
    layout["calendars"][0] = {"x": 0.1, "y": 0.1, "width": 0.9, "height": 0.5}
    validate_calendar_layout(layout)


# ── Calendar style block is required on calendar layouts ────────────────────

def test_rejects_missing_calendar_block():
    layout = _good_layout()
    del layout["calendar"]
    _assert_raises(layout, "calendar layouts must include a 'calendar' object")


def test_rejects_missing_theme_preset():
    layout = _good_layout()
    del layout["calendar"]["themePreset"]
    _assert_raises(layout, "calendar.themepreset is required")


def test_rejects_missing_calendar_type():
    layout = _good_layout()
    del layout["calendar"]["calendarType"]
    _assert_raises(layout, "calendar.calendartype is required")


def test_rejects_missing_week_start():
    layout = _good_layout()
    del layout["calendar"]["weekStart"]
    _assert_raises(layout, "calendar.weekstart is required")


# ── monthOffset uniqueness (§11.1) ──────────────────────────────────────────

def test_poster_rejects_duplicate_month_offsets():
    layout = _poster_layout()
    layout["calendars"][1]["monthOffset"] = 0  # collides with calendars[0]
    _assert_raises(layout, "duplicates")


def test_rejects_month_offset_out_of_range():
    layout = _poster_layout()
    layout["calendars"][0]["monthOffset"] = 99
    _assert_raises(layout, "monthoffset")


# ── Style enum checks (§10.3) ───────────────────────────────────────────────

def test_rejects_unknown_theme_preset():
    layout = _good_layout()
    layout["calendar"]["themePreset"] = "modern-corporate"
    _assert_raises(layout, "themepreset")


def test_rejects_unknown_calendar_type():
    layout = _good_layout()
    layout["calendar"]["calendarType"] = "hijri"
    _assert_raises(layout, "calendartype")


def test_rejects_unknown_week_start():
    layout = _good_layout()
    layout["calendar"]["weekStart"] = "wednesday"
    _assert_raises(layout, "weekstart")


# ── surfaceOverrides banned-field rejection (§11.15) ────────────────────────

def test_rejects_theme_preset_in_surface_override():
    layout = _good_layout()
    layout["surfaceOverrides"] = {
        "month_03": {"themePreset": "modern-genz"},
    }
    _assert_raises(layout, "themepreset")


def test_rejects_calendar_type_in_surface_override():
    layout = _good_layout()
    layout["surfaceOverrides"] = {
        "month_07": {"calendarType": "financial"},
    }
    _assert_raises(layout, "calendartype")


def test_rejects_canvas_in_surface_override():
    layout = _good_layout()
    layout["surfaceOverrides"] = {
        "month_12": {"canvas": {"width": 999, "height": 999}},
    }
    _assert_raises(layout, "canvas")


def test_accepts_frames_override():
    layout = _good_layout()
    layout["surfaceOverrides"] = {
        "month_03": {"frames": [{"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.45}]},
    }
    validate_calendar_layout(layout)


def test_accepts_overlays_override():
    layout = _good_layout()
    layout["surfaceOverrides"] = {
        "month_12": {"overlays": [{"type": "image", "src": "snowflakes.png", "x": 80, "y": 5, "width": 15, "height": 10, "rotation": 0, "opacity": 0.7, "source": "clipart", "label": "snow", "id": "x1"}]},
    }
    validate_calendar_layout(layout)


# ── defaultYear (§10.4) ─────────────────────────────────────────────────────

def test_rejects_default_year_too_old():
    _assert_raises(_good_layout(monthRange={"count": 12, "defaultYear": 1999}),
                   "defaultyear")


def test_rejects_default_year_garbage():
    _assert_raises(_good_layout(monthRange={"count": 12, "defaultYear": "next-year"}),
                   "defaultyear")


# ── Stand-alone runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import inspect
    failed = 0
    tests = [
        (name, fn) for name, fn in globals().items()
        if name.startswith("test_") and callable(fn)
    ]
    print(f"Running {len(tests)} validator tests …")
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
    print(f"\nAll {len(tests)} validator tests passed.")
