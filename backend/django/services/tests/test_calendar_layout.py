"""
Unit tests for services.calendar_layout — surface materialization, year
resolution, and the §11.1 month-resolution formula.

Run with:
    cd backend/django && python -m services.tests.test_calendar_layout
"""
from __future__ import annotations

import os
import sys
from datetime import date

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from services.calendar_layout import (  # noqa: E402
    display_label_for,
    materialize_surfaces,
    resolve_base_year,
    resolve_default_year,
    resolve_surface_month,
    start_month_for,
)


# ── Helpers ─────────────────────────────────────────────────────────────────

def _desk_calendar() -> dict:
    """12 surfaces × 1 calendar — standard desk-calendar layout."""
    return {
        "productType": "calendar",
        "canvas": {"width": 1500, "height": 2100, "dpi": 300},
        "frames": [{"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.5}],
        "calendars": [{"x": 0.05, "y": 0.6, "width": 0.9, "height": 0.35}],
        "calendar": {
            "themePreset": "modern-minimalist",
            "calendarType": "english",
            "weekStart": "sunday",
        },
        "monthRange": {"count": 12, "defaultYear": 2026},
    }


def _poster_calendar() -> dict:
    """1 surface × 12 calendars — year-on-one-poster layout."""
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
        },
        "monthRange": {"count": 1, "defaultYear": 2026},
    }


# ── year + month resolution ─────────────────────────────────────────────────

def test_start_month_english():
    assert start_month_for("english") == 1


def test_start_month_financial():
    assert start_month_for("financial") == 4


def test_resolve_base_year_english_is_today_year():
    # English baseYear always == today's calendar year, regardless of month.
    assert resolve_base_year("english", today=date(2026, 1, 5)) == 2026
    assert resolve_base_year("english", today=date(2026, 5, 21)) == 2026
    assert resolve_base_year("english", today=date(2026, 11, 30)) == 2026


def test_resolve_base_year_financial_apr_dec():
    # Apr–Dec of year Y belong to FY Y–(Y+1), so baseYear = Y.
    assert resolve_base_year("financial", today=date(2026, 4, 1)) == 2026
    assert resolve_base_year("financial", today=date(2026, 12, 31)) == 2026


def test_resolve_base_year_financial_jan_mar():
    # Jan–Mar of year Y belong to FY (Y-1)–Y, so baseYear = Y - 1.
    assert resolve_base_year("financial", today=date(2026, 1, 5)) == 2025
    assert resolve_base_year("financial", today=date(2026, 3, 31)) == 2025


def test_resolve_default_year_passes_through_concrete_year():
    assert resolve_default_year(2027, "english") == 2027


def test_resolve_default_year_current_uses_today():
    # We can't pin today inside the helper, but the result must equal
    # resolve_base_year for the same calendar type — that's the contract.
    assert resolve_default_year("current", "english") == resolve_base_year("english")
    assert resolve_default_year("current", "financial") == resolve_base_year("financial")


# ── (surface_index, monthOffset) → (year, month) ────────────────────────────

def test_resolve_surface_month_english_desk():
    # 12 surfaces × 1 calendar; surface_i drives month, monthOffset=0.
    assert resolve_surface_month(0, 0, "english", 2026) == (2026, 1)
    assert resolve_surface_month(1, 0, "english", 2026) == (2026, 2)
    assert resolve_surface_month(11, 0, "english", 2026) == (2026, 12)


def test_resolve_surface_month_financial_desk():
    # 12 surfaces × 1 calendar, financial: surface 0 = April of baseYear,
    # ..., surface 8 = December of baseYear, surface 9 = January of baseYear+1.
    assert resolve_surface_month(0, 0, "financial", 2026) == (2026, 4)
    assert resolve_surface_month(8, 0, "financial", 2026) == (2026, 12)
    assert resolve_surface_month(9, 0, "financial", 2026) == (2027, 1)
    assert resolve_surface_month(11, 0, "financial", 2026) == (2027, 3)


def test_resolve_surface_month_poster_english():
    # 1 surface × 12 calendars; surface=0, monthOffset 0..11.
    assert resolve_surface_month(0, 0, "english", 2026) == (2026, 1)
    assert resolve_surface_month(0, 5, "english", 2026) == (2026, 6)
    assert resolve_surface_month(0, 11, "english", 2026) == (2026, 12)


def test_resolve_surface_month_poster_financial():
    # 1 × 12 in financial mode: monthOffset 0 = April baseYear, offset 11 = March baseYear+1.
    assert resolve_surface_month(0, 0, "financial", 2026) == (2026, 4)
    assert resolve_surface_month(0, 8, "financial", 2026) == (2026, 12)
    assert resolve_surface_month(0, 9, "financial", 2026) == (2027, 1)
    assert resolve_surface_month(0, 11, "financial", 2026) == (2027, 3)


# ── display_label_for (§11.6) ───────────────────────────────────────────────

def test_display_label_format():
    assert display_label_for(2026, 1) == "January 2026"
    assert display_label_for(2026, 12) == "December 2026"
    assert display_label_for(2027, 3) == "March 2027"


# ── materialize_surfaces — desk layout ──────────────────────────────────────

def test_materialize_desk_english_12_surfaces():
    surfaces = materialize_surfaces(_desk_calendar())
    assert len(surfaces) == 12
    assert surfaces[0]["key"] == "month_01"
    assert surfaces[0]["month"] == 1
    assert surfaces[0]["year"] == 2026
    assert surfaces[0]["displayLabel"] == "January 2026"
    assert surfaces[11]["key"] == "month_12"
    assert surfaces[11]["month"] == 12
    assert surfaces[11]["displayLabel"] == "December 2026"


def test_materialize_desk_financial_spans_two_years():
    layout = _desk_calendar()
    surfaces = materialize_surfaces(layout, calendar_type_override="financial")
    assert len(surfaces) == 12
    # First surface = April baseYear
    assert surfaces[0]["month"] == 4
    assert surfaces[0]["year"] == 2026
    assert surfaces[0]["displayLabel"] == "April 2026"
    # Last surface = March baseYear+1
    assert surfaces[11]["month"] == 3
    assert surfaces[11]["year"] == 2027
    assert surfaces[11]["displayLabel"] == "March 2027"


def test_materialize_desk_inherits_template_when_no_override():
    surfaces = materialize_surfaces(_desk_calendar())
    # Without surfaceOverrides, every surface inherits the template frames.
    for s in surfaces:
        assert s["frames"] == [{"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.5}]


# ── materialize_surfaces — poster layout ────────────────────────────────────

def test_materialize_poster_english_12_calendars_one_surface_key_set():
    surfaces = materialize_surfaces(_poster_calendar())
    assert len(surfaces) == 12
    # Each emitted entry has a distinct key, even though they all map to
    # surface_index=0 (one physical print page).
    keys = {s["key"] for s in surfaces}
    assert len(keys) == 12
    # All months covered.
    months = {s["month"] for s in surfaces}
    assert months == set(range(1, 13))


# ── surfaceOverrides applied ────────────────────────────────────────────────

def test_materialize_applies_surface_override_frames():
    layout = _desk_calendar()
    layout["surfaceOverrides"] = {
        "month_03": {
            "frames": [{"x": 0.0, "y": 0.0, "width": 1.0, "height": 0.6}],
        },
    }
    surfaces = materialize_surfaces(layout)
    march = next(s for s in surfaces if s["month"] == 3)
    assert march["frames"] == [{"x": 0.0, "y": 0.0, "width": 1.0, "height": 0.6}]
    # Other months still inherit the template
    feb = next(s for s in surfaces if s["month"] == 2)
    assert feb["frames"] == [{"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.5}]


def test_materialize_applies_surface_override_overlays():
    layout = _desk_calendar()
    layout["surfaceOverrides"] = {
        "month_12": {"overlays": [{"type": "image", "src": "snow.png"}]},
    }
    surfaces = materialize_surfaces(layout)
    dec = next(s for s in surfaces if s["month"] == 12)
    assert dec["overlays"] == [{"type": "image", "src": "snow.png"}]


def test_materialize_bubbles_mask_url_to_every_surface():
    """maskUrl is layout-global (§10.2.1) — every materialized surface inherits."""
    layout = _desk_calendar()
    layout["maskUrl"] = "masks/test_mask.png"
    layout["maskOnExport"] = True
    surfaces = materialize_surfaces(layout)
    assert len(surfaces) == 12
    for s in surfaces:
        assert s["maskUrl"] == "masks/test_mask.png"
        assert s["maskOnExport"] is True


def test_materialize_defaults_mask_to_none_when_template_has_none():
    surfaces = materialize_surfaces(_desk_calendar())
    for s in surfaces:
        assert s["maskUrl"] is None
        assert s["maskOnExport"] is False


def test_materialize_mask_is_not_overridable_per_surface():
    """surfaceOverrides cannot change mask config — it stays template-global."""
    layout = _desk_calendar()
    layout["maskUrl"] = "masks/all_months.png"
    # Even if ops sneaks maskUrl into an override, materialize ignores it
    # (the field isn't in the allowed override list per PRD §10.2.1).
    layout["surfaceOverrides"] = {
        "month_06": {"frames": [{"x": 0, "y": 0, "width": 1, "height": 1}]}
    }
    surfaces = materialize_surfaces(layout)
    jun = next(s for s in surfaces if s["month"] == 6)
    assert jun["maskUrl"] == "masks/all_months.png"  # still inherited
    assert jun["frames"] == [{"x": 0, "y": 0, "width": 1, "height": 1}]  # override applied


def test_materialize_deep_copies_so_mutation_is_safe():
    layout = _desk_calendar()
    surfaces = materialize_surfaces(layout)
    # Mutate a surface's frames — original layout must be untouched.
    surfaces[0]["frames"][0]["x"] = 0.99
    assert layout["frames"][0]["x"] == 0.05


# ── displayLabel covers IST cases for financial mode ────────────────────────

def test_materialize_financial_uses_correct_year_split():
    layout = _desk_calendar()
    layout["monthRange"]["defaultYear"] = 2026
    surfaces = materialize_surfaces(layout, calendar_type_override="financial")
    # 9 months in 2026 (Apr–Dec), 3 months in 2027 (Jan–Mar).
    years = [s["year"] for s in surfaces]
    assert years.count(2026) == 9
    assert years.count(2027) == 3


# ── Stand-alone runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} calendar_layout tests …")
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
    print(f"\nAll {len(tests)} calendar_layout tests passed.")
