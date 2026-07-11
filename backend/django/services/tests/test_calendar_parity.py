"""
Tests for Phase 2 item 6 — calendar print/preview parity:

  (a) theme preset colours resolved server-side (materialize_surfaces reads
      storage/calendar_styles/<name>.json exactly like the browser preview)
  (b) materialized surface overlays (ops month artwork + the opt-in month
      title) actually reach the print
  (c) multi-photo uploads produce exactly 12 outputs, month i cycling
      photo canvases, instead of 12·N files
  (d) per-day entries are one flat ISO-keyed map, stamped on every month
      (render_calendar's in-month filter draws only the right dates)

Run stand-alone:
    cd backend/django && python -m services.tests.test_calendar_parity
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from PIL import Image  # noqa: E402

from api.tasks import _extract_calendar_state  # noqa: E402
from layout_engine.engine import LayoutEngine  # noqa: E402
from services.calendar_layout import materialize_surfaces  # noqa: E402
from services.calendar_renderer import _resolve_colors  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _calendar_layout(**extra) -> dict:
    base = {
        "name": "parity_cal",
        "productType": "calendar",
        "canvas": {"width": 600, "height": 840, "dpi": 300},
        "frames": [{"id": "top", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.40}],
        "calendars": [{"x": 0.05, "y": 0.55, "width": 0.9, "height": 0.40}],
        "calendar": {
            "themePreset": "modern-minimalist",
            "calendarType": "english",
            "weekStart": "sunday",
        },
        "monthRange": {"count": 12, "defaultYear": 2026},
    }
    base.update(extra)
    return base


def _write_layout(layouts_dir: str, layout: dict) -> str:
    os.makedirs(layouts_dir, exist_ok=True)
    with open(os.path.join(layouts_dir, f"{layout['name']}.json"), "w") as f:
        json.dump(layout, f)
    return layout["name"]


def _solid(path: str, color: tuple, size=(300, 300)) -> str:
    Image.new("RGB", size, color).save(path)
    return path


def _near(px, target, tol: int = 40) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px[:3], target))


# ── (a) Theme colours resolved server-side ───────────────────────────────────

def test_materialize_resolves_weekday_highlight_colors():
    layout = _calendar_layout()
    surfaces = materialize_surfaces(layout, theme_preset_override="weekday-highlight")
    colors = surfaces[0]["calendar"]["colors"]
    assert colors["weekdaySunday"] == "#DC2626", colors
    assert colors["sundayCellFill"] == "#FEE2E2", colors
    assert colors["grid"] == "#D4D4D8", colors
    assert surfaces[0]["calendar"]["dotCycle"][0] == "#1F2937"


def test_materialize_layout_colors_win_over_theme():
    layout = _calendar_layout()
    layout["calendar"]["colors"] = {"grid": "#123456"}
    surfaces = materialize_surfaces(layout, theme_preset_override="weekday-highlight")
    colors = surfaces[0]["calendar"]["colors"]
    assert colors["grid"] == "#123456", "ops-set layout colours must win over the preset"
    assert colors["weekdaySunday"] == "#DC2626", "preset still fills the unset keys"


def test_materialize_missing_theme_json_falls_back():
    layout = _calendar_layout()
    layout["calendar"]["themePreset"] = "no-such-theme"
    surfaces = materialize_surfaces(layout)  # must not raise
    assert surfaces[0]["calendar"].get("colors") in (None, {}), \
        "unknown theme falls through to renderer defaults"


def test_resolve_colors_palette_sets_weekday_sunday():
    out = _resolve_colors({}, {"weekday": "#112233", "date": "#445566"})
    assert out["weekdaySunday"] == "#112233"
    assert out["outOfMonth"] == "#44556659", "out-of-month fades to date colour @35%"


# ── (b) Surface overlays reach the print ────────────────────────────────────

_RED_RECT = {
    "type": "shape", "shapeType": "rect", "x": 5.0, "y": 5.0,
    "width": 20.0, "height": 10.0, "fill": "#FF0000", "opacity": 1.0,
}


def _generate(layout: dict, images: list, **kw) -> tuple:
    """Render into a temp exports dir; returns (engine, outputs, workdir)."""
    work = tempfile.mkdtemp(prefix="pe-calpar-")
    layouts_dir = os.path.join(work, "layouts")
    exports_dir = os.path.join(work, "exports")
    os.makedirs(exports_dir, exist_ok=True)
    name = _write_layout(layouts_dir, layout)
    eng = LayoutEngine(layouts_dir, exports_dir)
    outputs = eng.generate(name, images, **kw)
    return eng, outputs, work


def test_template_overlay_prints_on_every_month():
    layout = _calendar_layout(overlays=[_RED_RECT])
    work = tempfile.mkdtemp(prefix="pe-calpar-src-")
    img = _solid(os.path.join(work, "w.png"), (255, 255, 255))
    _, outputs, _ = _generate(layout, [img])
    assert len(outputs) == 12
    jan = next(p for p in outputs if os.path.basename(p).startswith("January"))
    with Image.open(jan) as out:
        # Inside the red rect (x 5-25%, y 5-15% of 600×840).
        px = out.getpixel((int(0.10 * 600), int(0.08 * 840)))
    assert _near(px, (255, 0, 0)), f"template overlay must print, got {px}"


def test_surface_override_overlay_only_on_its_month():
    layout = _calendar_layout(surfaceOverrides={"month_12": {"overlays": [_RED_RECT]}})
    work = tempfile.mkdtemp(prefix="pe-calpar-src-")
    img = _solid(os.path.join(work, "w.png"), (255, 255, 255))
    _, outputs, _ = _generate(layout, [img])
    dec = next(p for p in outputs if os.path.basename(p).startswith("December"))
    jan = next(p for p in outputs if os.path.basename(p).startswith("January"))
    with Image.open(dec) as out:
        dec_px = out.getpixel((int(0.10 * 600), int(0.08 * 840)))
    with Image.open(jan) as out:
        jan_px = out.getpixel((int(0.10 * 600), int(0.08 * 840)))
    assert _near(dec_px, (255, 0, 0)), f"December must carry its override overlay, got {dec_px}"
    assert not _near(jan_px, (255, 0, 0)), f"January must NOT carry December's overlay, got {jan_px}"


def test_month_title_synthesis_opt_in():
    layout = _calendar_layout()
    layout["calendar"]["monthTitle"] = {"enabled": True, "x": 5, "y": 2, "fontSize": 30}
    surfaces = materialize_surfaces(layout)
    first = surfaces[0]["overlays"][0]
    assert first["type"] == "text" and first["text"] == surfaces[0]["displayLabel"]

    # Off by default — no synthesized overlay.
    plain = materialize_surfaces(_calendar_layout())
    assert plain[0]["overlays"] == []


def test_customer_overlays_land_on_their_own_month():
    """overlays_per_canvas[3] must print on month 4 only (per-surface slicing)."""
    layout = _calendar_layout()
    work = tempfile.mkdtemp(prefix="pe-calpar-src-")
    img = _solid(os.path.join(work, "w.png"), (255, 255, 255))
    images = [img] * 12
    overlays_pc = [[] for _ in range(12)]
    overlays_pc[3] = [_RED_RECT]
    _, outputs, _ = _generate(
        layout, images,
        overlays_per_canvas=overlays_pc,
        calendar_state={"cells": {}, "num_canvases": 12},
    )
    assert len(outputs) == 12
    april = next(p for p in outputs if os.path.basename(p).startswith("April"))
    march = next(p for p in outputs if os.path.basename(p).startswith("March"))
    with Image.open(april) as out:
        april_px = out.getpixel((int(0.10 * 600), int(0.08 * 840)))
    with Image.open(march) as out:
        march_px = out.getpixel((int(0.10 * 600), int(0.08 * 840)))
    assert _near(april_px, (255, 0, 0)), f"canvas 3's overlay must land on April, got {april_px}"
    assert not _near(march_px, (255, 0, 0)), "March must not inherit canvas 3's overlay"


# ── (c) Multi-photo batching ─────────────────────────────────────────────────

def test_three_photos_still_give_exactly_12_outputs():
    layout = _calendar_layout()
    work = tempfile.mkdtemp(prefix="pe-calpar-src-")
    red = _solid(os.path.join(work, "r.png"), (255, 0, 0))
    green = _solid(os.path.join(work, "g.png"), (0, 200, 0))
    blue = _solid(os.path.join(work, "b.png"), (0, 0, 255))
    _, outputs, _ = _generate(layout, [red, green, blue])

    assert len(outputs) == 12, f"expected 12 outputs, got {len(outputs)}"
    names = [os.path.basename(p) for p in outputs]
    assert not any("_2" in n or "_3" in n for n in names), \
        f"no photo-batch suffixes allowed: {names}"

    # Month i renders photo canvas (i mod 3): Jan=red, Feb=green, Mar=blue, Apr=red…
    frame_probe = (int((0.05 + 0.45) * 600), int((0.05 + 0.20) * 840))
    expect = {"January": (255, 0, 0), "February": (0, 200, 0),
              "March": (0, 0, 255), "April": (255, 0, 0)}
    for month, color in expect.items():
        path = next(p for p in outputs if os.path.basename(p).startswith(month))
        with Image.open(path) as out:
            px = out.getpixel(frame_probe)
        assert _near(px, color), f"{month} should show {color}, got {px}"


def test_single_photo_cycles_to_all_12_months():
    layout = _calendar_layout()
    work = tempfile.mkdtemp(prefix="pe-calpar-src-")
    red = _solid(os.path.join(work, "r.png"), (255, 0, 0))
    _, outputs, _ = _generate(layout, [red])
    assert len(outputs) == 12
    frame_probe = (int(0.50 * 600), int(0.25 * 840))
    for p in outputs:
        with Image.open(p) as out:
            assert _near(out.getpixel(frame_probe), (255, 0, 0)), os.path.basename(p)


# ── (d) Flat ISO-keyed cells ─────────────────────────────────────────────────

def test_extract_calendar_state_merges_flat_cells():
    editor_state = {
        "canvases": [
            {"calendar": {"themePreset": "modern-minimalist", "calendarType": "english",
                          "cells": {"2026-01-05": [{"type": "text", "text": "a"}]}}},
            {"calendar": {"cells": {"2026-05-10": [{"type": "text", "text": "b"}]}}},
            {"calendar": {"cells": {}}},
        ],
    }
    out = _extract_calendar_state(editor_state)
    assert set(out["cells"].keys()) == {"2026-01-05", "2026-05-10"}
    assert out["num_canvases"] == 3
    assert out["theme_preset"] == "modern-minimalist"


def test_extract_caps_entries_per_cell_at_three():
    editor_state = {
        "canvases": [{"calendar": {"cells": {"2026-03-03": [
            {"text": "1"}, {"text": "2"}, {"text": "3"}, {"text": "4"},
        ]}}}],
    }
    out = _extract_calendar_state(editor_state)
    assert len(out["cells"]["2026-03-03"]) == 3


def test_flat_cells_render_only_on_their_month():
    layout = _calendar_layout()
    work = tempfile.mkdtemp(prefix="pe-calpar-src-")
    img = _solid(os.path.join(work, "w.png"), (255, 255, 255))
    cells = {"2026-05-10": [{"type": "text", "text": "MAYDAY", "dotColor": "#FF0000"}]}
    _, outputs, _ = _generate(
        layout, [img], calendar_state={"cells": cells, "num_canvases": 1},
    )
    assert len(outputs) == 12
    # The May grid must differ from a no-entries render of May; January must
    # be pixel-identical to its no-entries render (entry drew nothing there).
    _, plain_outputs, _ = _generate(
        layout, [img], calendar_state={"cells": {}, "num_canvases": 1},
    )

    def _img_bytes(paths, month):
        p = next(q for q in paths if os.path.basename(q).startswith(month))
        with Image.open(p) as im:
            return im.tobytes()

    assert _img_bytes(outputs, "May") != _img_bytes(plain_outputs, "May"), \
        "the 2026-05-10 entry must draw on May"
    assert _img_bytes(outputs, "January") == _img_bytes(plain_outputs, "January"), \
        "an out-of-month entry must not draw on January"


# ── Test runner ─────────────────────────────────────────────────────────────

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
    print(f"All {len(funcs)} calendar-parity tests passed.")


if __name__ == "__main__":
    _run_all()
