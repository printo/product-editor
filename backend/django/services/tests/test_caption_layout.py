"""
Parity tests for LayoutEngine._resolve_caption_box — the Python mirror of the
browser's caption placement maths (frontend/src/lib/caption-layout.ts →
resolveCaptionBox). If these two drift, a positioned caption lands in a
different spot in the 300-DPI print than the customer saw in the preview.

Keep the default formulas identical to caption-layout.test.ts:
    w      = fw * 0.8
    font   = fh * 0.04        (Python rounds to an int px for rendering)
    x      = fx + (fw - w)/2  (horizontally centred)
    y      = fy + fh - fh*0.08 - font/2
    align  = 'center'
    color  = '#2a2a2a'

Run stand-alone:
    cd backend/django && python -m services.tests.test_caption_layout
"""
from __future__ import annotations

from layout_engine.engine import LayoutEngine

FX, FY, FW, FH = 100, 200, 400, 300


def test_defaults_match_legacy_bottom_centre():
    box = LayoutEngine._resolve_caption_box(FX, FY, FW, FH, {}, px_per_mm=1.0)
    assert box["w"] == FW * 0.8            # 320
    assert box["font_px"] == round(FH * 0.04)  # 12
    assert box["x"] == FX + (FW - FW * 0.8) / 2  # 140
    assert abs(box["y"] - (FY + FH - FH * 0.08 - (FH * 0.04) / 2)) < 1e-6  # 470
    assert box["align"] == "center"
    assert box["color"] == "#2a2a2a"


def test_explicit_overrides_used_verbatim():
    frame = {
        "captionXMm": 10, "captionYMm": 20, "captionWidthMm": 150,
        "captionFontMm": 30, "captionAlign": "right", "captionColor": "#ff0000",
    }
    box = LayoutEngine._resolve_caption_box(FX, FY, FW, FH, frame, px_per_mm=1.0)
    assert box == {"x": 10, "y": 20, "w": 150, "font_px": 30, "align": "right", "color": "#ff0000"}


def test_px_per_mm_scales_mm_values():
    box = LayoutEngine._resolve_caption_box(FX, FY, FW, FH, {"captionXMm": 10}, px_per_mm=2.0)
    assert box["x"] == 20


def test_explicit_width_recenters_default_x():
    box = LayoutEngine._resolve_caption_box(FX, FY, FW, FH, {"captionWidthMm": 200}, px_per_mm=1.0)
    assert box["w"] == 200
    assert box["x"] == FX + (FW - 200) / 2  # 200


def test_none_and_empty_string_fall_back_to_defaults():
    frame = {"captionXMm": None, "captionYMm": "", "captionColor": None, "captionAlign": None}
    box = LayoutEngine._resolve_caption_box(FX, FY, FW, FH, frame, px_per_mm=1.0)
    assert box["x"] == FX + (FW - FW * 0.8) / 2
    assert box["color"] == "#2a2a2a"
    assert box["align"] == "center"


def test_explicit_zero_is_kept_not_defaulted():
    box = LayoutEngine._resolve_caption_box(FX, FY, FW, FH, {"captionXMm": 0, "captionYMm": 0}, px_per_mm=1.0)
    assert box["x"] == 0
    assert box["y"] == 0


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} caption-layout parity tests passed.")
