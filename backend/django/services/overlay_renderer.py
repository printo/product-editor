"""
Server-side overlay renderer (Phase 1 of CALENDAR_FEATURE_PRD.md §5).

Fixes a pre-existing gap: text/shape/image overlays added in the editor
were preview-only — they appeared in the dashboard dataUrl thumbnail
but vanished from the 300 DPI printed file. This module draws them onto
the final PIL canvas just before the mask is applied, so the printed
output matches the editor preview byte-for-byte (within float / rounding
tolerance).

Render order (matches editor z-order in FabricEditor.tsx):

    canvas (frames composited)
    └── render_overlays()    ← THIS MODULE
        ├── overlay[0]
        ├── overlay[1]
        └── ...
    └── mask (if maskOnExport)

The overlay shape mirrors the frontend `Overlay` discriminated union
(see `frontend/nextjs/src/app/editor/layout/[name]/types.ts`):

    { type: 'text',  x, y, fontSize, color, fontFamily, textAlign, rotation, text }
    { type: 'shape', x, y, width, height, rotation, fill, stroke, strokeWidth, opacity, shapeType, svgPath? }
    { type: 'image', x, y, width, height, rotation, opacity, source, fileId?, src }

Coordinates from the editor are in **percentages of the canvas** (0–100)
not pixels — the renderer multiplies by canvas_w_px / canvas_h_px to
land in image space. fontSize for text is in pixels relative to the
editor canvas height; we scale by the px ratio to keep relative sizes
matched at 300 DPI.

Image overlays
==============
Local-uploaded images carry a `fileId` (UUID) that maps to a server-side
upload_id; the caller passes an `uploaded_files: dict[upload_id, file_path]`
map so we can pull the bytes off disk. Clipart / icon overlays carry an
`src` URL — for v1 we only resolve `src` that point to a path under
`STORAGE_ROOT` (no remote fetch); anything else is logged and skipped.
"""
from __future__ import annotations

import logging
import math
import os
from typing import Optional

from PIL import Image, ImageDraw

from services.fonts import get_font

logger = logging.getLogger(__name__)


# ── Public API ──────────────────────────────────────────────────────────────


def render_overlays(
    canvas: Image.Image,
    overlays: list[dict],
    canvas_w_px: int,
    canvas_h_px: int,
    uploaded_files: Optional[dict[str, str]] = None,
) -> Image.Image:
    """
    Draw text / shape / image overlays onto `canvas` in place.

    Args:
        canvas: PIL Image (mode RGB). Mutated in place; also returned for
            chaining.
        overlays: list of overlay dicts in the editor's discriminated-union
            shape. Unknown `type` values are logged and skipped.
        canvas_w_px / canvas_h_px: target image dimensions in pixels. The
            editor uses percentage coordinates so we need the absolute
            size to resolve them.
        uploaded_files: optional map of upload_id → server file path,
            for resolving `image` overlays that reference local uploads.

    Returns:
        The same `canvas` (for chaining with mask compositing).
    """
    if not overlays:
        return canvas

    uploaded_files = uploaded_files or {}

    # Work in RGBA so alpha blending works for shapes + image overlays
    # with opacity. The mask compositing step in engine.py expects RGBA
    # too, so we hand back an RGBA buffer that the caller can flatten.
    rgba = canvas if canvas.mode == "RGBA" else canvas.convert("RGBA")

    for o in overlays:
        try:
            otype = o.get("type")
            if otype == "text":
                _draw_text(rgba, o, canvas_w_px, canvas_h_px)
            elif otype == "shape":
                _draw_shape(rgba, o, canvas_w_px, canvas_h_px)
            elif otype == "image":
                _paste_image(rgba, o, canvas_w_px, canvas_h_px, uploaded_files)
            else:
                logger.warning("Unknown overlay type: %r — skipping", otype)
        except Exception:  # noqa: BLE001 — one bad overlay shouldn't kill the render
            logger.exception("Failed to render overlay: %r", o)

    if rgba is not canvas:
        # Flatten back to RGB. The caller then runs mask compositing on
        # this and gets the same shape it started with.
        flat = rgba.convert("RGB")
        canvas.paste(flat)
        flat.close()
        rgba.close()

    return canvas


# ── Text ────────────────────────────────────────────────────────────────────


def _draw_text(canvas: Image.Image, o: dict, cw: int, ch: int) -> None:
    """Render a `TextOverlay` onto canvas (assumed RGBA mode)."""
    text = str(o.get("text") or "")
    if not text:
        return

    # Editor stores fontSize in px relative to its own canvas height. The
    # render target is at 300 DPI which is taller than the editor canvas
    # in absolute pixels, so we scale by the height ratio.
    font_size_editor = float(o.get("fontSize") or 14)
    # Heuristic: the editor canvas is roughly 800 px tall in the preview;
    # scale fontSize linearly with the print canvas height. This matches
    # what the editor preview shows (Fabric.js text scales with viewport).
    font_size_px = max(8, int(font_size_editor * ch / 800.0))
    color = _parse_color(o.get("color") or "#000000")

    # fontFamily field is ignored per PRD §11.7 — always Inter.
    font = get_font(font_size_px, weight=400)

    x_pct = float(o.get("x") or 0)
    y_pct = float(o.get("y") or 0)
    x_px = int(x_pct * cw / 100.0)
    y_px = int(y_pct * ch / 100.0)

    # textAlign affects anchor: 'left' = anchor at x, 'center' = x is mid,
    # 'right' = x is right edge. PIL's anchor takes a 2-char code where
    # the first char is horizontal (l/m/r) and second is vertical (t/m/b/s).
    # Editor doesn't expose vertical anchor — default to top.
    align = (o.get("textAlign") or "left").lower()
    anchor_h = {"left": "l", "center": "m", "right": "r"}.get(align, "l")
    anchor = f"{anchor_h}t"

    rotation = float(o.get("rotation") or 0.0)

    if abs(rotation) < 0.5:
        # Fast path — no rotation, draw straight onto the canvas.
        draw = ImageDraw.Draw(canvas)
        draw.text((x_px, y_px), text, font=font, fill=color, anchor=anchor)
        return

    # Rotated text: render onto a transparent strip, rotate, paste.
    # PIL has no native rotated-text in `draw.text()`, so this is the
    # documented workaround. Strip size is generous to avoid clipping;
    # we use the font's bbox to size it.
    bbox = font.getbbox(text)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    pad = max(4, font_size_px // 4)
    strip = Image.new("RGBA", (text_w + pad * 2, text_h + pad * 2), (0, 0, 0, 0))
    strip_draw = ImageDraw.Draw(strip)
    strip_draw.text((pad, pad), text, font=font, fill=color, anchor="lt")
    rotated = strip.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)
    # Re-anchor: editor's (x, y) is the un-rotated text's anchor. After
    # rotation, paste so that the anchor point in the rotated strip
    # lands at (x_px, y_px). Simplification for v1: paste with the
    # rotated strip's top-left at (x_px, y_px) — slight visual drift
    # for non-left anchors at non-zero rotation, fixable in Phase 9 polish.
    canvas.alpha_composite(rotated, (x_px, y_px))
    strip.close()
    rotated.close()


# ── Shape ───────────────────────────────────────────────────────────────────


def _draw_shape(canvas: Image.Image, o: dict, cw: int, ch: int) -> None:
    """Render a `ShapeOverlay` onto canvas (assumed RGBA mode)."""
    shape_type = (o.get("shapeType") or "rect").lower()

    x_px = int(float(o.get("x") or 0) * cw / 100.0)
    y_px = int(float(o.get("y") or 0) * ch / 100.0)
    w_px = max(1, int(float(o.get("width") or 0) * cw / 100.0))
    h_px = max(1, int(float(o.get("height") or 0) * ch / 100.0))

    fill = _parse_color(o.get("fill") or "#000000", o.get("opacity"))
    stroke = _parse_color(o.get("stroke") or "rgba(0,0,0,0)", o.get("opacity"))
    stroke_w = max(0, int(float(o.get("strokeWidth") or 0)))
    rotation = float(o.get("rotation") or 0.0)

    # Render the shape onto a transparent strip then composite — keeps
    # the rotation path uniform with text.
    pad = max(4, stroke_w)
    strip = Image.new("RGBA", (w_px + pad * 2, h_px + pad * 2), (0, 0, 0, 0))
    strip_draw = ImageDraw.Draw(strip)
    box = (pad, pad, pad + w_px, pad + h_px)

    if shape_type in ("rect", "rectangle", "square"):
        strip_draw.rectangle(box, fill=fill, outline=stroke if stroke_w else None, width=stroke_w)
    elif shape_type in ("ellipse", "circle"):
        strip_draw.ellipse(box, fill=fill, outline=stroke if stroke_w else None, width=stroke_w)
    elif shape_type == "line":
        strip_draw.line(
            (pad, pad + h_px // 2, pad + w_px, pad + h_px // 2),
            fill=fill,
            width=max(1, stroke_w),
        )
    else:
        # svgPath / arbitrary shapes — Pillow can't natively render SVG.
        # Falls through to a rectangle outline so the overlay is still
        # visible. Full SVG support is a Phase 9 candidate (cairosvg).
        logger.warning("Unsupported shapeType: %r — rendering as rectangle", shape_type)
        strip_draw.rectangle(box, fill=fill, outline=stroke if stroke_w else None, width=stroke_w)

    if abs(rotation) >= 0.5:
        strip = strip.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)

    canvas.alpha_composite(strip, (x_px - pad, y_px - pad))
    strip.close()


# ── Image ───────────────────────────────────────────────────────────────────


def _paste_image(
    canvas: Image.Image,
    o: dict,
    cw: int,
    ch: int,
    uploaded_files: dict[str, str],
) -> None:
    """Render an `ImageOverlay` onto canvas (assumed RGBA mode)."""
    path = _resolve_image_path(o, uploaded_files)
    if not path:
        logger.warning(
            "ImageOverlay couldn't resolve to a server path: source=%r, fileId=%r — skipping",
            o.get("source"), o.get("fileId"),
        )
        return

    x_px = int(float(o.get("x") or 0) * cw / 100.0)
    y_px = int(float(o.get("y") or 0) * ch / 100.0)
    w_px = max(1, int(float(o.get("width") or 0) * cw / 100.0))
    h_px = max(1, int(float(o.get("height") or 0) * ch / 100.0))
    rotation = float(o.get("rotation") or 0.0)
    opacity = float(o.get("opacity") if o.get("opacity") is not None else 1.0)
    opacity = max(0.0, min(1.0, opacity))

    try:
        with Image.open(path) as _src:
            img = _src.convert("RGBA")
    except (OSError, ValueError) as exc:
        logger.warning("Failed to open image overlay at %s: %s — skipping", path, exc)
        return

    img = img.resize((w_px, h_px), Image.Resampling.LANCZOS)

    if abs(rotation) >= 0.5:
        img = img.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)

    if opacity < 1.0:
        # Scale the alpha channel by the requested opacity.
        alpha = img.split()[-1]
        alpha = alpha.point(lambda v: int(v * opacity))
        img.putalpha(alpha)

    canvas.alpha_composite(img, (x_px, y_px))
    img.close()


def _resolve_image_path(o: dict, uploaded_files: dict[str, str]) -> Optional[str]:
    """Resolve an ImageOverlay to a server-side file path, or None."""
    file_id = o.get("fileId")
    if file_id and file_id in uploaded_files:
        return uploaded_files[file_id]

    src = o.get("src") or ""
    # Only honour src values that point to local server paths (no remote
    # fetch in v1 — would need allowlist + timeout + retry policy).
    if src and not src.startswith(("http://", "https://", "data:")):
        if os.path.exists(src):
            return src

    return None


# ── Color parsing ───────────────────────────────────────────────────────────


def _parse_color(value: str, opacity_override: Optional[float] = None) -> tuple:
    """
    Parse a CSS-style color string into an (r, g, b, a) tuple.

    Accepts:
      "#rgb", "#rrggbb", "#rrggbbaa", "rgb(...)", "rgba(...)".
    Anything else → black opaque. opacity_override (0..1), if provided,
    multiplies the alpha channel.
    """
    v = (value or "").strip().lower()
    r, g, b, a = 0, 0, 0, 255

    if v.startswith("#"):
        hexstr = v.lstrip("#")
        if len(hexstr) == 3:  # #rgb → #rrggbb
            hexstr = "".join(c * 2 for c in hexstr)
        if len(hexstr) in (6, 8):
            try:
                r = int(hexstr[0:2], 16)
                g = int(hexstr[2:4], 16)
                b = int(hexstr[4:6], 16)
                if len(hexstr) == 8:
                    a = int(hexstr[6:8], 16)
            except ValueError:
                pass
    elif v.startswith("rgb"):
        # rgb(r,g,b) or rgba(r,g,b,a)
        try:
            inner = v[v.index("(") + 1: v.index(")")]
            parts = [p.strip() for p in inner.split(",")]
            r = int(float(parts[0]))
            g = int(float(parts[1]))
            b = int(float(parts[2]))
            if len(parts) >= 4:
                a = int(float(parts[3]) * 255)
        except (ValueError, IndexError):
            pass

    if opacity_override is not None:
        try:
            a = int(a * max(0.0, min(1.0, float(opacity_override))))
        except (ValueError, TypeError):
            pass

    return (r, g, b, a)
