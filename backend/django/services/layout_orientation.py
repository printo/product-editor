"""
Serve a layout in the orientation the caller asked for.

printo.in's CMS decides per product whether the print is portrait or
landscape and sends it on the embed session. A layout is authored in one
orientation; when the other is asked for, the whole layout is turned a quarter
turn clockwise: the canvas swaps width and height, every frame moves with it
(array order is untouched, so photo N still lands in frame N), and the mask is
turned to match.

One function, used by the editor-init response (what the customer sees) and by
the render task (what prints), so the two cannot disagree. The layout is
**never** an error: anything that cannot or should not be turned is served as
authored and the reason is reported back (`apply_orientation`'s report).

Photos are not turned here. Each is re-fitted into its new frame by the same
cover/contain/pan code as before, and the pose-based photo rotation is
independent of the layout, so heads stay upright.
"""
from __future__ import annotations

import copy
from typing import Any, Optional

ORIENTATIONS = ("portrait", "landscape")

# Product types whose geometry is not a free-form frame layout: calendars and
# books have month grids, gutters and spines that a quarter turn would break.
_NEVER_ROTATED_PRODUCT_TYPES = ("calendar", "book")

MASK_ROTATE_QUERY = "rotate=90"


def parse_orientation(raw: Any) -> Optional[str]:
    """`portrait` / `landscape`, case and whitespace insensitive; else None."""
    value = str(raw or "").strip().lower()
    return value if value in ORIENTATIONS else None


def _surfaces(definition: dict) -> list:
    surfaces = definition.get("surfaces")
    if isinstance(surfaces, list) and surfaces:
        return [s for s in surfaces if isinstance(s, dict)]
    return [definition]


def _canvas_dims(surface: dict) -> Optional[tuple]:
    canvas = surface.get("canvas")
    if not isinstance(canvas, dict):
        return None
    w, h = canvas.get("width"), canvas.get("height")
    if not isinstance(w, (int, float)) or not isinstance(h, (int, float)) or w <= 0 or h <= 0:
        return None
    return w, h


def layout_orientation(definition: dict) -> Optional[str]:
    """The orientation the layout is authored in: `portrait`, `landscape`,
    `square`, or None when it has no readable canvas."""
    if not isinstance(definition, dict):
        return None
    dims = _canvas_dims(_surfaces(definition)[0])
    if dims is None:
        return None
    w, h = dims
    if h > w:
        return "portrait"
    if w > h:
        return "landscape"
    return "square"


def _mask_filename(mask_url: str) -> str:
    return mask_url.split("?", 1)[0].lower()


def _blocker(definition: dict) -> Optional[str]:
    """Why this layout must not be turned, or None when it may be."""
    if definition.get("orientationRotatable") is False:
        return "not_rotatable"
    if definition.get("productType") in _NEVER_ROTATED_PRODUCT_TYPES:
        return "not_rotatable"
    if definition.get("frameCaptionsEnabled"):
        return "has_captions"
    for surface in _surfaces(definition):
        if _canvas_dims(surface) is None:
            return "not_rotatable"
        if surface.get("overlays"):
            return "has_overlays"
        mask_url = surface.get("maskUrl")
        if mask_url and _mask_filename(str(mask_url)).endswith(".svg"):
            return "svg_mask"
    return None


def _is_fractional(frames: list) -> bool:
    return any("xMm" in f or f.get("width", 999) <= 1.0 for f in frames)


def _rotate_frame(frame: dict, fractional: bool, canvas_w: float, canvas_h: float,
                  canvas_w_mm: Optional[float], canvas_h_mm: Optional[float]) -> dict:
    """A quarter turn clockwise: (x, y, w, h) -> (H - y - h, x, h, w)."""
    out = dict(frame)
    x, y, w, h = frame["x"], frame["y"], frame["width"], frame["height"]
    extent = 1 if fractional else canvas_h
    out["x"], out["y"], out["width"], out["height"] = extent - y - h, x, h, w
    if all(k in frame for k in ("xMm", "yMm", "widthMm", "heightMm")):
        if canvas_h_mm is not None:
            out["xMm"] = canvas_h_mm - frame["yMm"] - frame["heightMm"]
            out["yMm"] = frame["xMm"]
            out["widthMm"], out["heightMm"] = frame["heightMm"], frame["widthMm"]
        else:
            for key in ("xMm", "yMm", "widthMm", "heightMm"):
                out.pop(key, None)
    return out


def _rotate_surface(surface: dict) -> None:
    """In place. The caller passes a copy."""
    canvas = surface["canvas"]
    w, h = canvas["width"], canvas["height"]
    w_mm, h_mm = canvas.get("widthMm"), canvas.get("heightMm")
    frames = surface.get("frames")
    if isinstance(frames, list) and frames:
        fractional = _is_fractional(frames)
        surface["frames"] = [
            _rotate_frame(f, fractional, w, h, w_mm, h_mm) for f in frames
        ]
    grid = surface.get("grid")
    if not frames and isinstance(grid, dict) and grid.get("rows") and grid.get("cols"):
        surface["grid"] = {**grid, "rows": grid["cols"], "cols": grid["rows"]}
    canvas["width"], canvas["height"] = h, w
    if w_mm is not None or h_mm is not None:
        canvas["widthMm"], canvas["heightMm"] = h_mm, w_mm
    mask_url = surface.get("maskUrl")
    if mask_url:
        base = str(mask_url).split("?", 1)[0]
        surface["maskUrl"] = f"{base}?{MASK_ROTATE_QUERY}"
        surface["maskRotate"] = 90


def orientation_info(definition: dict) -> dict:
    """What a layout list needs to draw its Portrait / Landscape choice: the
    orientation the layout is drawn in and why it can never be turned (None
    when it can). The same codes as apply_orientation's report."""
    report = apply_orientation(definition, None)[1]
    return {"orientation": report["orientation"], "blocked": report["blocked"]}


def apply_orientation(definition: dict, requested: Any) -> tuple:
    """
    `(definition, report)`. The definition is a turned copy when the report says
    `applied`, and the input object itself otherwise.

    report = { requested, applied, reason, orientation }
      requested    the cleaned value the caller sent, or None
      applied      True when the layout was turned
      reason       None when applied, else not_sent | invalid_value |
                   not_rotatable | has_captions | has_overlays | svg_mask |
                   already_that_orientation | square_layout
      orientation  what the served layout is: portrait / landscape / square
      blocked      why this layout can never be turned (same codes as reason,
                   minus the request-specific ones), or None when it can; lets
                   the dashboard toggle lock itself before anything is asked
    """
    current = layout_orientation(definition)
    cleaned = parse_orientation(requested)
    blocker = "square_layout" if current == "square" else (_blocker(definition) if current else "not_rotatable")
    report = {
        "requested": cleaned, "applied": False, "reason": None, "orientation": current,
        "blocked": blocker,
    }

    if requested is None or str(requested).strip() == "":
        report["reason"] = "not_sent"
        return definition, report
    if cleaned is None:
        report["reason"] = "invalid_value"
        return definition, report
    if current is None:
        report["reason"] = "not_rotatable"
        return definition, report
    if current == "square":
        report["reason"] = "square_layout"
        return definition, report
    if current == cleaned:
        report["reason"] = "already_that_orientation"
        return definition, report
    if blocker:
        report["reason"] = blocker
        return definition, report

    turned = copy.deepcopy(definition)
    for surface in _surfaces(turned):
        _rotate_surface(surface)
    report["applied"] = True
    report["orientation"] = cleaned
    return turned, report
