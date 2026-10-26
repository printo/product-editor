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

* `printSheet` — `{mode: 'canvas' | 'bleed'}`. `canvas` (and absent) prints
  the whole canvas as before, byte for byte. `bleed` prints the bleed area taken
  **from the photo windows**: the box around every frame (each frame's
  rectangle already includes its own bleed), worked out at render time, nothing
  stored, so the print follows the windows wherever ops move them. Nothing is
  ever typed: what prints is exactly what the customer's windows show (Kannan,
  2026-10-26, when a typed rectangle was tried and dropped the same day).
  `bleed` is never a default: a layout such as the retro polaroid keeps its
  white border and caption in the print.
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

def print_sheet_mode(block: dict) -> str:
    sheet = block.get("printSheet") if isinstance(block, dict) else None
    if isinstance(sheet, dict) and sheet.get("mode") == "bleed":
        return "bleed"
    return "canvas"


def validate_print_sheet(block: dict) -> Optional[dict]:
    """A cleaned `printSheet` for storage, or None when the block has none.

    Raises ValueError with an ops-readable message for anything but
    `{mode: 'canvas' | 'bleed'}`: the bleed area always comes from the photo
    windows, so a rectangle of any kind is refused rather than stored.
    """
    sheet = block.get("printSheet")
    if sheet is None:
        return None
    if not isinstance(sheet, dict):
        raise ValueError("printSheet must be an object with a `mode`.")
    mode = sheet.get("mode", "canvas")
    if mode not in PRINT_SHEET_MODES:
        raise ValueError("printSheet.mode must be 'canvas' (the whole canvas) or 'bleed' (the bleed area).")
    extra = sorted(k for k in sheet if k != "mode")
    if extra:
        raise ValueError(
            "printSheet takes only `mode`; the bleed area always comes from the photo "
            f"windows (unexpected: {', '.join(extra)})."
        )
    return {"mode": mode}


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
    box = windows_bleed_box_px(surface_def.get("frames") or [], canvas)
    if box is None:
        return None
    left, top, right, bottom = box
    if right - left <= 0 or bottom - top <= 0:
        raise ValueError(
            f"The bleed area of surface '{surface_def.get('key', 'default')}' is empty "
            f"({left}, {top}) to ({right}, {bottom}) px; check the layout's photo windows."
        )
    if (left, top, right, bottom) == (0, 0, int(canvas["width"]), int(canvas["height"])):
        return None
    return box
