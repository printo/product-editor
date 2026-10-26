"""
What a layout prints: its print sheet and its two mask slots.

Catalog Ops reported (2026-10-26) that a physical photo frame could not be set
up right with one mask and a "Mask on Export" switch: printed, the picture of
the wooden frame was baked into the sheet; not printed, the sheet was the whole
canvas with white around the window. The print they need is the **bleed area**
only: the visible window grown by its bleed, the strip hidden under the frame
or trimmed after printing. The customer preview and the storefront mock still
show the frame.

Two things replace the switch:

* `printSheet` — `{mode: 'canvas' | 'bleed', xMm?, yMm?, widthMm?, heightMm?,
  bleedMm?}`. `canvas` (and absent) prints the whole canvas as before, byte for
  byte. `bleed` with no rectangle prints the bleed area taken **from the photo
  windows**: the box around every frame (each frame's rectangle already
  includes its own bleed), worked out at render time, nothing stored. `bleed`
  with a rectangle is a **typed** bleed area: the visible rectangle in canvas
  mm grown by `bleedMm` on every side; ops type one only when printed artwork
  extends beyond the photo windows. `bleed` is never a default: a layout such
  as the retro polaroid keeps its white border and caption in the print.

* Two mask slots in place of one. `frameMaskUrl` is placed **outside** the
  bleed area (the frame picture): drawn in every preview and in the mock,
  never printed, even where its pixels overlap the bleed ring.
  `artworkMaskUrl` is placed **inside** (artwork with photo holes): drawn in
  previews and the mock, printed, cropped to the bleed area with everything
  else. Above photos and overlays the order is artwork, then frame on top.
  Nothing is ticked as printable; placement decides.

The legacy pair is read compatibly: `maskUrl` with `maskOnExport: true` is the
artwork slot, `maskUrl` with it false or absent is the frame slot. Every
layout-serving response carries all four keys for one release
(`with_legacy_mask_fields`) so nothing downstream breaks. Calendars and books
keep their single mask and ignore `printSheet`.

Pure Python, no Django. The TypeScript twin of the slot rule is
`frontend/nextjs/src/lib/mask-slots.ts`.
"""
from __future__ import annotations

from typing import Any, Optional

PRINT_SHEET_MODES = ("canvas", "bleed")
FRAME_MASK = "frameMaskUrl"
ARTWORK_MASK = "artworkMaskUrl"
_RECT_KEYS = ("xMm", "yMm", "widthMm", "heightMm")
# Rounding slack for a rectangle typed in two-decimal millimetres.
_MM_TOLERANCE = 0.011


def _url(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


def resolve_mask_slots(block: dict) -> tuple[Optional[str], Optional[str]]:
    """`(frame_mask_url, artwork_mask_url)` for a layout, surface or book role.

    The new keys win as soon as either holds a URL; otherwise the legacy pair
    decides which slot the one mask was in. Two empty new keys beside a
    legacy mask (a read adds them to every response) never hide it.
    """
    if not isinstance(block, dict):
        return None, None
    frame, artwork = _url(block.get(FRAME_MASK)), _url(block.get(ARTWORK_MASK))
    if frame or artwork:
        return frame, artwork
    legacy = _url(block.get("maskUrl"))
    if legacy is None:
        return None, None
    if block.get("maskOnExport") is True:
        return None, legacy
    return legacy, None


def mask_blocks(definition: dict) -> list:
    """Every dict in a layout that may carry mask slots: the root, each
    `surfaces[]` entry and each authored `book.<role>`."""
    if not isinstance(definition, dict):
        return []
    blocks = [definition]
    surfaces = definition.get("surfaces")
    if isinstance(surfaces, list):
        blocks.extend(s for s in surfaces if isinstance(s, dict))
    book = definition.get("book")
    if isinstance(book, dict):
        blocks.extend(book[r] for r in ("cover", "innerPage", "backCover") if isinstance(book.get(r), dict))
    return blocks


def uses_single_mask(definition: dict) -> bool:
    """Calendars and books keep one mask and the on/off export switch."""
    return isinstance(definition, dict) and definition.get("productType") in ("calendar", "book")


def normalize_mask_slots(block: dict) -> None:
    """In place: store the two slots and drop the legacy pair.

    Used on save for generic layouts so a definition written from now on has
    one shape. Calendars and books are left as they are (see uses_single_mask).
    """
    frame, artwork = resolve_mask_slots(block)
    block[FRAME_MASK] = frame
    block[ARTWORK_MASK] = artwork
    block.pop("maskUrl", None)
    block.pop("maskOnExport", None)


def _with_all_mask_keys(block: dict) -> dict:
    out = dict(block)
    frame, artwork = resolve_mask_slots(block)
    out[FRAME_MASK] = frame
    out[ARTWORK_MASK] = artwork
    # The legacy pair can carry one URL. The frame picture is the one every
    # preview shows on top, so a legacy reader keeps drawing the same thing;
    # `maskOnExport` then says whether that one URL is the printed slot.
    out["maskUrl"] = frame or artwork
    out["maskOnExport"] = bool(artwork) and frame is None
    return out


def with_legacy_mask_fields(data):
    """A copy of a layout response (or a list of them) with the two slots and
    the derived legacy `maskUrl` / `maskOnExport` on the root, every surface
    and every book role. Never mutates the cached input."""
    if isinstance(data, list):
        return [with_legacy_mask_fields(d) for d in data]
    if not isinstance(data, dict):
        return data
    out = _with_all_mask_keys(data)
    surfaces = data.get("surfaces")
    if isinstance(surfaces, list):
        out["surfaces"] = [_with_all_mask_keys(s) if isinstance(s, dict) else s for s in surfaces]
    book = data.get("book")
    if isinstance(book, dict):
        out["book"] = {
            k: (_with_all_mask_keys(v) if k in ("cover", "innerPage", "backCover") and isinstance(v, dict) else v)
            for k, v in book.items()
        }
    return out


def is_svg_url(url: Any) -> bool:
    return isinstance(url, str) and url.split("?", 1)[0].lower().endswith(".svg")


def has_svg_mask(block: dict) -> bool:
    return any(is_svg_url(u) for u in resolve_mask_slots(block) if u)


# ── Print sheet ──────────────────────────────────────────────────────────────

def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def canvas_mm(canvas: dict) -> tuple[Optional[float], Optional[float]]:
    """The canvas size in mm: its `widthMm`/`heightMm`, else from its pixel
    size at its `dpi` (300 when absent). None when there is no readable canvas."""
    if not isinstance(canvas, dict):
        return None, None
    w_mm, h_mm = canvas.get("widthMm"), canvas.get("heightMm")
    if _is_number(w_mm) and _is_number(h_mm) and w_mm > 0 and h_mm > 0:
        return float(w_mm), float(h_mm)
    w, h = canvas.get("width"), canvas.get("height")
    if not (_is_number(w) and _is_number(h) and w > 0 and h > 0):
        return None, None
    dpi = canvas.get("dpi") if _is_number(canvas.get("dpi")) and canvas.get("dpi") > 0 else 300
    return w * 25.4 / dpi, h * 25.4 / dpi


def print_sheet_mode(block: dict) -> str:
    sheet = block.get("printSheet") if isinstance(block, dict) else None
    if isinstance(sheet, dict) and sheet.get("mode") == "bleed":
        return "bleed"
    return "canvas"


def typed_sheet_rect(sheet: Any) -> Optional[dict]:
    """The typed visible rectangle and bleed, or None when the sheet has no
    rectangle (the from-the-windows case). Does not validate."""
    if not isinstance(sheet, dict) or not all(_is_number(sheet.get(k)) for k in _RECT_KEYS):
        return None
    bleed = sheet.get("bleedMm")
    return {
        "xMm": float(sheet["xMm"]), "yMm": float(sheet["yMm"]),
        "widthMm": float(sheet["widthMm"]), "heightMm": float(sheet["heightMm"]),
        "bleedMm": float(bleed) if _is_number(bleed) else 0.0,
    }


def validate_print_sheet(block: dict, canvas: dict) -> Optional[dict]:
    """A cleaned `printSheet` for storage, or None when the block has none.

    Raises ValueError with an ops-readable message: unknown mode, a partial or
    non-numeric rectangle, a non-positive size, a negative bleed, or a bleed
    area outside the canvas.
    """
    sheet = block.get("printSheet")
    if sheet is None:
        return None
    if not isinstance(sheet, dict):
        raise ValueError("printSheet must be an object with a `mode`.")
    mode = sheet.get("mode", "canvas")
    if mode not in PRINT_SHEET_MODES:
        raise ValueError("printSheet.mode must be 'canvas' (the whole canvas) or 'bleed' (the bleed area).")
    present = [k for k in _RECT_KEYS if sheet.get(k) is not None]
    if not present:
        bleed = sheet.get("bleedMm")
        if bleed is not None and not _is_number(bleed):
            raise ValueError("printSheet.bleedMm must be a number of millimetres.")
        return {"mode": mode}
    if len(present) != len(_RECT_KEYS):
        raise ValueError("A typed bleed area needs all of xMm, yMm, widthMm and heightMm.")
    for key in _RECT_KEYS:
        if not _is_number(sheet[key]):
            raise ValueError(f"printSheet.{key} must be a number of millimetres.")
    bleed = sheet.get("bleedMm", 0)
    if bleed is None:
        bleed = 0
    if not _is_number(bleed) or bleed < 0:
        raise ValueError("printSheet.bleedMm must be zero or a positive number of millimetres.")
    rect = typed_sheet_rect({**sheet, "bleedMm": bleed})
    if rect["widthMm"] <= 0 or rect["heightMm"] <= 0:
        raise ValueError("A typed bleed area needs a positive width and height.")
    w_mm, h_mm = canvas_mm(canvas)
    if w_mm is None:
        raise ValueError("A typed bleed area needs a canvas with a size.")
    left, top = rect["xMm"] - rect["bleedMm"], rect["yMm"] - rect["bleedMm"]
    right, bottom = rect["xMm"] + rect["widthMm"] + rect["bleedMm"], rect["yMm"] + rect["heightMm"] + rect["bleedMm"]
    if left < -_MM_TOLERANCE or top < -_MM_TOLERANCE or right > w_mm + _MM_TOLERANCE or bottom > h_mm + _MM_TOLERANCE:
        raise ValueError(
            f"The bleed area ({left:.2f}, {top:.2f}) to ({right:.2f}, {bottom:.2f}) mm "
            f"runs outside the {w_mm:.2f} x {h_mm:.2f} mm canvas."
        )
    return {"mode": mode, **rect}


def mm_rect_to_px(rect: dict, canvas: dict) -> tuple[int, int, int, int]:
    """A visible mm rectangle grown by its bleed, as a pixel box
    `(left, top, right, bottom)` on the canvas, rounded like the frames are
    (`LayoutEngine._normalize_frames`) and clamped to the canvas."""
    canvas_w, canvas_h = int(canvas["width"]), int(canvas["height"])
    w_mm, h_mm = canvas_mm(canvas)
    ppm_x = canvas_w / w_mm
    ppm_y = canvas_h / h_mm
    bleed = rect.get("bleedMm", 0.0)
    left = round((rect["xMm"] - bleed) * ppm_x)
    top = round((rect["yMm"] - bleed) * ppm_y)
    right = round((rect["xMm"] + rect["widthMm"] + bleed) * ppm_x)
    bottom = round((rect["yMm"] + rect["heightMm"] + bleed) * ppm_y)
    return max(0, left), max(0, top), min(canvas_w, right), min(canvas_h, bottom)


def windows_bleed_box_px(frames: list, canvas: dict) -> Optional[tuple[int, int, int, int]]:
    """The box around every frame's pixel rectangle (each already includes
    its own bleed), clamped to the canvas; None without frames."""
    if not frames:
        return None
    canvas_w, canvas_h = int(canvas["width"]), int(canvas["height"])
    left = min(int(f["x"]) for f in frames)
    top = min(int(f["y"]) for f in frames)
    right = max(int(f["x"]) + int(f["width"]) for f in frames)
    bottom = max(int(f["y"]) + int(f["height"]) for f in frames)
    return max(0, left), max(0, top), min(canvas_w, right), min(canvas_h, bottom)


def resolve_print_box(surface_def: dict) -> Optional[tuple[int, int, int, int]]:
    """The pixel box `(left, top, right, bottom)` the print is cropped to, or
    None to print the whole canvas.

    `surface_def` is an engine surface: `canvas` in pixels and `frames`
    already normalised to pixels. Raises ValueError when a bleed sheet would
    be empty, so a bad layout fails the job visibly instead of printing the
    wrong sheet.
    """
    if print_sheet_mode(surface_def) != "bleed":
        return None
    canvas = surface_def["canvas"]
    rect = typed_sheet_rect(surface_def.get("printSheet"))
    if rect is not None:
        box = mm_rect_to_px(rect, canvas)
    else:
        box = windows_bleed_box_px(surface_def.get("frames") or [], canvas)
        if box is None:
            return None
    left, top, right, bottom = box
    if right - left <= 0 or bottom - top <= 0:
        raise ValueError(
            f"The bleed area of surface '{surface_def.get('key', 'default')}' is empty "
            f"({left}, {top}) to ({right}, {bottom}) px; check the layout's print sheet."
        )
    if (left, top, right, bottom) == (0, 0, int(canvas["width"]), int(canvas["height"])):
        return None
    return box


def rotate_print_sheet(sheet: Any, canvas_w_mm: float, canvas_h_mm: float) -> Any:
    """A typed sheet turned a quarter turn clockwise with the canvas, in the
    authored canvas's mm: (x, y, w, h) -> (H - y - h, x, h, w). A sheet
    without a rectangle is returned unchanged; its box follows the frames."""
    rect = typed_sheet_rect(sheet)
    if rect is None:
        return sheet
    return {
        **sheet,
        "xMm": canvas_h_mm - rect["yMm"] - rect["heightMm"],
        "yMm": rect["xMm"],
        "widthMm": rect["heightMm"],
        "heightMm": rect["widthMm"],
    }
