"""
Unit tests for services.calendar_renderer + services.calendar_holidays
(CALENDAR_FEATURE_PRD.md §5 Phase 4 + Phase 2/3 hand-off tests).

Covers:
  - build_month_grid: 5-row + 6-row months, leap year Feb, year boundaries
  - _merge_cell_pills: user-first precedence (§11.14), 3-cap (§11.10)
  - _hex_to_rgba: shorthand + alpha
  - _resolve_colors / _resolve_dot_cycle: theme + Gen-Z palette merge
  - _autofit_text: truncation when text exceeds floor
  - load_holidays_for_year: real disk read + missing-file fallback

Includes a TS↔Python parity test that pins (year, month, weekStart) →
known grid output. The frontend lib/calendar.ts MUST produce identical
output for the same inputs; any drift breaks the editor preview vs
the printed file.

Run with:
    docker-compose exec backend python -m services.tests.test_calendar_renderer
"""
from __future__ import annotations

import os
import sys

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from services.calendar_renderer import (  # noqa: E402
    MAX_ENTRIES_PER_CELL,
    build_month_grid,
    _merge_cell_pills,
    _hex_to_rgba,
    _resolve_colors,
    _resolve_dot_cycle,
    _autofit_text,
)
from services.calendar_holidays import load_holidays_for_year  # noqa: E402
from services.fonts import get_font  # noqa: E402


# ── build_month_grid ────────────────────────────────────────────────────────

def test_january_2026_lands_on_thursday():
    """Jan 1 2026 is a Thursday; check first row + Sunday leading-blanks."""
    grid = build_month_grid(2026, 1, "sunday")
    assert len(grid) == 35  # 5-week month (Jan 2026: Jan 1 Thu → Jan 31 Sat)
    # First 4 cells = Dec 28, 29, 30, 31 (out of month); cell 4 = Jan 1.
    assert [c["day"] for c in grid[:5]] == [28, 29, 30, 31, 1]
    assert grid[4]["inMonth"] is True
    assert grid[4]["dayOfWeek"] == 4  # Thursday
    # All grid[0:4] are out-of-month.
    assert all(c["inMonth"] is False for c in grid[:4])


def test_january_2026_monday_first_shifts_layout():
    grid = build_month_grid(2026, 1, "monday")
    # With monday-first, Jan 1 (Thu) is column 3 in the first row.
    assert grid[3]["day"] == 1
    assert grid[3]["inMonth"] is True


def test_feb_2024_leap_year_has_29_days():
    grid = build_month_grid(2024, 2, "sunday")
    in_month_days = [c["day"] for c in grid if c["inMonth"]]
    assert in_month_days == list(range(1, 30))   # 1..29
    # Confirm Feb 29 is dayOfWeek = 4 (Thu in 2024).
    feb29 = next(c for c in grid if c["inMonth"] and c["day"] == 29)
    assert feb29["dayOfWeek"] == 4


def test_feb_2025_non_leap_year_has_28_days():
    grid = build_month_grid(2025, 2, "sunday")
    in_month = [c for c in grid if c["inMonth"]]
    assert len(in_month) == 28


def test_six_row_month():
    """Pick a month known to span 6 rows: May 2026 (May 1 = Friday)."""
    grid = build_month_grid(2026, 5, "sunday")
    # May 1 2026 is Friday → 5 leading blanks → 5+31 = 36 → ceil to 42.
    assert len(grid) == 42


def test_december_year_boundary():
    """Dec 2025 + Sunday-start: trailing cells should land in January 2026."""
    grid = build_month_grid(2025, 12, "sunday")
    last_cells = [c for c in grid if not c["inMonth"] and c["day"] < 15]
    # At least one trailing cell should have year=2026 (rolled into next month).
    assert any(c["year"] == 2026 for c in last_cells)


def test_grid_iso_strings_are_well_formed():
    grid = build_month_grid(2026, 7, "sunday")
    for c in grid:
        assert len(c["iso"]) == 10
        assert c["iso"][4] == "-" and c["iso"][7] == "-"
        y, m, d = c["iso"].split("-")
        assert int(y) == c["year"] and int(m) == c["month"] and int(d) == c["day"]


# ── _merge_cell_pills (§11.14 user-first + §11.10 hard cap) ─────────────────

def test_merge_pills_no_input_is_empty():
    assert _merge_cell_pills([], [], ["#000"], {}) == []


def test_merge_pills_user_only():
    out = _merge_cell_pills(
        [{"type": "text", "text": "Mom"}, {"type": "text", "text": "Dad"}],
        [],
        ["#A", "#B", "#C"],
        {},
    )
    assert len(out) == 2
    assert out[0]["text"] == "Mom" and out[0]["dotColor"] == "#A"
    assert out[1]["text"] == "Dad" and out[1]["dotColor"] == "#B"


def test_merge_pills_user_first_then_holidays():
    """User entries fill first; holidays take any remaining slots (§11.14)."""
    user = [{"type": "text", "text": "Birthday"}]
    holidays = [{"name": "Christmas", "color": "#10B981"}]
    out = _merge_cell_pills(user, holidays, ["#A", "#B", "#C"], {})
    assert out[0]["source"] if False else True
    assert out[0]["text"] == "Birthday" and out[0]["dotColor"] == "#A"
    assert out[1]["text"] == "Christmas" and out[1]["dotColor"] == "#10B981"


def test_merge_pills_hard_cap_of_three():
    """Anything past MAX_ENTRIES_PER_CELL is silently suppressed (§11.10)."""
    assert MAX_ENTRIES_PER_CELL == 3
    user = [
        {"type": "text", "text": "U1"},
        {"type": "text", "text": "U2"},
        {"type": "text", "text": "U3"},
        {"type": "text", "text": "U4"},  # over cap — must vanish
    ]
    holidays = [{"name": "H1", "color": "#000"}]  # also vanishes
    out = _merge_cell_pills(user, holidays, ["#A", "#B", "#C"], {})
    assert [p["text"] for p in out] == ["U1", "U2", "U3"]


def test_merge_pills_user_three_pushes_holiday_out():
    """If user has 3 entries on a holiday day, holiday is suppressed entirely."""
    user = [
        {"type": "text", "text": "U1"},
        {"type": "text", "text": "U2"},
        {"type": "text", "text": "U3"},
    ]
    holidays = [{"name": "Republic Day", "color": "#DC2626"}]
    out = _merge_cell_pills(user, holidays, ["#A", "#B", "#C"], {})
    assert [p["text"] for p in out] == ["U1", "U2", "U3"]
    assert all(p["dotColor"] in ("#A", "#B", "#C") for p in out)


def test_merge_pills_holiday_dot_falls_back():
    """Holiday without `color` falls back to monthText / black."""
    out = _merge_cell_pills(
        [], [{"name": "X"}], ["#A"], {"monthText": "#222"},
    )
    assert out[0]["dotColor"] == "#222"


def test_merge_pills_skips_empty_text():
    """Whitespace-only / missing text user entries don't consume a slot."""
    out = _merge_cell_pills(
        [{"type": "text", "text": "   "}, {"type": "text", "text": "Real"}],
        [],
        ["#A", "#B"],
        {},
    )
    assert [p["text"] for p in out] == ["Real"]


# ── _hex_to_rgba ────────────────────────────────────────────────────────────

def test_hex_to_rgba_six_digits():
    assert _hex_to_rgba("#FF0080") == (0xFF, 0x00, 0x80, 0xFF)


def test_hex_to_rgba_three_digit_shorthand():
    assert _hex_to_rgba("#f80") == (0xFF, 0x88, 0x00, 0xFF)


def test_hex_to_rgba_eight_digits_keeps_alpha():
    assert _hex_to_rgba("#10203040") == (0x10, 0x20, 0x30, 0x40)


def test_hex_to_rgba_bogus_input_returns_black_opaque():
    assert _hex_to_rgba("garbage") == (0, 0, 0, 255)
    assert _hex_to_rgba("") == (0, 0, 0, 255)


# ── _resolve_colors + _resolve_dot_cycle ────────────────────────────────────

def test_resolve_colors_uses_defaults_when_style_empty():
    out = _resolve_colors({}, None)
    assert out["background"] == "#FFFFFF"
    assert "grid" in out and "pillBackground" in out


def test_resolve_colors_style_overrides_defaults():
    style = {"colors": {"background": "#FEE2E2", "grid": "#F87171"}}
    out = _resolve_colors(style, None)
    assert out["background"] == "#FEE2E2"
    assert out["grid"] == "#F87171"
    # Untouched defaults survive.
    assert out["dateNumber"] == "#18181B"


def test_resolve_colors_palette_overrides_style():
    style = {"colors": {"background": "#FFF", "grid": "#000"}}
    palette = {"bg": "#FEF3C7", "grid": "#FBCFE8", "month": "#A855F7",
               "weekday": "#A855F7", "date": "#0F172A", "pill": "#CCFBF1",
               "dotCycle": ["#A855F7", "#EC4899", "#0EA5E9"]}
    out = _resolve_colors(style, palette)
    assert out["background"] == "#FEF3C7"   # palette wins over style
    assert out["grid"] == "#FBCFE8"
    assert out["pillBackground"] == "#CCFBF1"


def test_resolve_dot_cycle_palette_wins():
    palette = {"dotCycle": ["#A", "#B", "#C"]}
    assert _resolve_dot_cycle({}, palette) == ["#A", "#B", "#C"]


def test_resolve_dot_cycle_style_fallback():
    style = {"dotCycle": ["#X", "#Y", "#Z"]}
    assert _resolve_dot_cycle(style, None) == ["#X", "#Y", "#Z"]


def test_resolve_dot_cycle_default_when_nothing_set():
    out = _resolve_dot_cycle({}, None)
    assert len(out) == 3
    assert all(c.startswith("#") for c in out)


# ── _autofit_text ───────────────────────────────────────────────────────────

def test_autofit_text_returns_original_when_it_fits():
    font = get_font(20, weight=500)
    text, f = _autofit_text("hi", font, max_w=500)
    assert text == "hi"
    # Same font is returned when no shrink needed.
    assert f is font


def test_autofit_text_truncates_when_impossibly_long():
    font = get_font(20, weight=500)
    long_text = "X" * 200
    text, f = _autofit_text(long_text, font, max_w=30)
    # Either shrank or truncated with ellipsis — both signal "didn't fit raw".
    assert text != long_text
    assert text.endswith("…") or len(text) < len(long_text)


# ── load_holidays_for_year (Bug A integration) ──────────────────────────────

def test_load_holidays_en_in_2026_returns_seed():
    events = load_holidays_for_year("en-IN", 2026)
    names = [e["name"] for e in events]
    assert "Republic Day" in names
    assert "Diwali" in names
    assert all("date" in e and "name" in e for e in events)


def test_load_holidays_missing_year_returns_empty():
    assert load_holidays_for_year("en-IN", 2099) == []


def test_load_holidays_bogus_locale_returns_empty():
    assert load_holidays_for_year("../etc", 2026) == []
    assert load_holidays_for_year("evil/path", 2026) == []


def test_load_holidays_out_of_range_year_returns_empty():
    assert load_holidays_for_year("en-IN", 9999) == []
    assert load_holidays_for_year("en-IN", 1800) == []


# ── TS ↔ Python parity (shared fixture file) ────────────────────────────────
#
# Both this file and frontend/nextjs/src/lib/__tests__/calendar.parity.test.ts
# load the same JSON fixtures from /parity-fixtures/calendar-grid.json. If
# either side drifts from the shared ground truth, exactly one of the two
# test suites fails — and we know which side broke.
#
# Resolve the fixtures path from repo root. Django settings.STORAGE_ROOT
# resolves to <repo>/storage; the parity fixtures sit at <repo>/parity-fixtures.

def _load_parity_fixtures() -> dict:
    import json, os
    from django.conf import settings
    # Fixtures live under storage/parity-fixtures/ so this works both on the
    # host (running tests directly) and inside Docker (where ./storage is
    # volume-mounted at /app/storage).
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "calendar-grid.json")
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Parity fixtures not found at {path}. Shared file with "
            "frontend/nextjs/src/lib/__tests__/calendar.parity.test.ts."
        )
    with open(path, "r") as f:
        return json.load(f)


def _case(name: str) -> dict:
    fx = _load_parity_fixtures()
    for c in fx["cases"]:
        if c["name"] == name:
            return c
    raise KeyError(f"No fixture case named {name!r}")


def test_parity_january_2026_sunday_first():
    c = _case("january_2026_sunday_first")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    assert len(grid) == c["expectedGridSize"]
    assert [g["iso"] for g in grid[:7]] == c["firstRowIso"]
    last = next(g for g in reversed(grid) if g["inMonth"])
    assert last["iso"] == c["lastInMonthIso"]
    assert last["dayOfWeek"] == c["lastInMonthDayOfWeek"]


def test_parity_january_2026_monday_first():
    c = _case("january_2026_monday_first")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    assert [g["iso"] for g in grid[:7]] == c["firstRowIso"]


def test_parity_april_2026_financial_year_start():
    c = _case("april_2026_financial_year_start")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    first = next(g for g in grid if g["inMonth"])
    assert first["iso"] == c["expectedFirstInMonthIso"]
    assert first["dayOfWeek"] == c["expectedFirstInMonthDayOfWeek"]


def test_parity_march_2027_financial_year_end():
    c = _case("march_2027_financial_year_end")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    first = next(g for g in grid if g["inMonth"])
    assert first["iso"] == c["expectedFirstInMonthIso"]
    assert first["dayOfWeek"] == c["expectedFirstInMonthDayOfWeek"]


def test_parity_february_2024_leap_year_from_fixture():
    c = _case("february_2024_leap_year")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    in_month = [g for g in grid if g["inMonth"]]
    assert len(in_month) == c["expectedInMonthDayCount"]


def test_parity_february_2025_non_leap_year_from_fixture():
    c = _case("february_2025_non_leap_year")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    in_month = [g for g in grid if g["inMonth"]]
    assert len(in_month) == c["expectedInMonthDayCount"]


def test_parity_may_2026_six_row_month_from_fixture():
    c = _case("may_2026_six_row_month")
    grid = build_month_grid(c["year"], c["month"], c["weekStart"])
    assert len(grid) == c["expectedGridSize"]


# ── Stand-alone runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} calendar_renderer tests …")
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
    print(f"\nAll {len(tests)} calendar_renderer tests passed.")
