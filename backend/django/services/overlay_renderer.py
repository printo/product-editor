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
map so we can pull the bytes off disk. That map is the ONLY way an image
overlay resolves. `src` is never opened: overlay dicts arrive verbatim from
the client (the render payload, book `pageOverrides`, the autosaved
editor_state), so honouring a path in `src` let a crafted submission
composite any file the worker could read — another order's upload or print —
into its own output. Icon overlays carry an https `src` and are skipped
(no remote fetch).
"""
from __future__ import annotations

import logging
import math
from typing import Optional

from PIL import Image, ImageDraw, ImageOps

from services.fonts import get_font
from services.image_loader import open_source_rgba

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
    # fontWeight is honoured so bold/semibold text overlays render correctly.
    font_weight = int(o.get("fontWeight") or 400)
    font = get_font(font_size_px, weight=font_weight)

    x_f = float(o.get("x") or 0) * cw / 100.0
    y_f = float(o.get("y") or 0) * ch / 100.0

    # textAlign affects the horizontal anchor: 'left' = anchor at x, 'center' =
    # x is mid, 'right' = x is right edge. PIL's anchor is a 2-char code where
    # the first char is horizontal (l/m/r) and the second is vertical.
    # The editor anchors text with originY:'center' (FabricEditor.tsx /
    # fabric-renderer.ts), so we vertically CENTRE with 'm' — using 't' (top)
    # printed the text half a line lower than the customer placed it.
    align = (o.get("textAlign") or "left").lower()
    anchor_h = {"left": "l", "center": "m", "right": "r"}.get(align, "l")
    anchor = f"{anchor_h}m"

    rotation = float(o.get("rotation") or 0.0)

    if abs(rotation) < 0.5:
        # Fast path — no rotation, draw straight onto the canvas.
        draw = ImageDraw.Draw(canvas)
        draw.text((int(x_f), int(y_f)), text, font=font, fill=color, anchor=anchor)
        return

    # Rotated text: PIL can't rotate `draw.text()`, so draw onto a strip with
    # the same anchor, then rotate the strip around that anchor — the editor's
    # Textbox rotates around its origin, which is this anchor.
    left, top, right, bottom = font.getbbox(text, anchor=anchor)
    pad = max(4, font_size_px // 4)
    strip = Image.new("RGBA", (right - left + pad * 2, bottom - top + pad * 2), (0, 0, 0, 0))
    anchor_in_strip = (pad - left, pad - top)
    ImageDraw.Draw(strip).text(anchor_in_strip, text, font=font, fill=color, anchor=anchor)
    _composite_rotated(canvas, strip, anchor_in_strip, (x_f, y_f), rotation)
    strip.close()


# ── Shape ───────────────────────────────────────────────────────────────────


def _draw_shape(canvas: Image.Image, o: dict, cw: int, ch: int) -> None:
    """Render a `ShapeOverlay` onto canvas (assumed RGBA mode)."""
    shape_type = (o.get("shapeType") or "rect").lower()

    x_f = float(o.get("x") or 0) * cw / 100.0
    y_f = float(o.get("y") or 0) * ch / 100.0
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

    # Pivot as in createShapeFromOverlay (lib/fabric-utils.ts): circles and
    # ellipses rotate around their centre, every other shape around its
    # top-left corner.
    if shape_type in ("ellipse", "circle"):
        pivot_in_strip = (pad + w_px / 2.0, pad + h_px / 2.0)
        pivot = (x_f + w_px / 2.0, y_f + h_px / 2.0)
    else:
        pivot_in_strip = (pad, pad)
        pivot = (x_f, y_f)
    _composite_rotated(canvas, strip, pivot_in_strip, pivot, rotation)
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

    x_f = float(o.get("x") or 0) * cw / 100.0
    y_f = float(o.get("y") or 0) * ch / 100.0
    w_px = max(1, int(float(o.get("width") or 0) * cw / 100.0))
    h_px = max(1, int(float(o.get("height") or 0) * ch / 100.0))
    rotation = float(o.get("rotation") or 0.0)
    opacity = float(o.get("opacity") if o.get("opacity") is not None else 1.0)
    opacity = max(0.0, min(1.0, opacity))

    try:
        # Colour-managed load (EXIF orientation + ICC→sRGB) — see services/image_loader.py.
        img = open_source_rgba(path)
    except (OSError, ValueError) as exc:
        logger.warning("Failed to open image overlay at %s: %s — skipping", path, exc)
        return

    img = img.resize((w_px, h_px), Image.Resampling.LANCZOS)

    if opacity < 1.0:
        # Scale the alpha channel by the requested opacity.
        alpha = img.split()[-1]
        alpha = alpha.point(lambda v: int(v * opacity))
        img.putalpha(alpha)

    # Both previews place the image with originX/originY 'left'/'top', so it
    # rotates around its top-left corner, which stays at (x, y).
    _composite_rotated(canvas, img, (0, 0), (x_f, y_f), rotation)
    img.close()


def _composite_rotated(
    canvas: Image.Image,
    img: Image.Image,
    pivot_in_img: tuple[float, float],
    pivot_on_canvas: tuple[float, float],
    rotation: float,
) -> None:
    """Rotate `img` clockwise by `rotation` degrees around `pivot_in_img` and
    composite it so that point lands on `pivot_on_canvas`.

    This is how Fabric places an object: `left`/`top` give where its origin
    point sits and `angle` turns it around that point. Pasting the expanded
    bounding box's top-left at (x, y) instead moves every rotated overlay
    away from where the customer put it.
    """
    px, py = pivot_in_img
    cx, cy = pivot_on_canvas
    if abs(rotation) < 0.5:
        canvas.alpha_composite(img, (round(cx - px), round(cy - py)))
        return

    rotated = img.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)
    # With expand=True, PIL keeps the image's centre at the centre of the
    # expanded output, so find where the pivot went relative to that centre.
    rad = math.radians(rotation)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    dx, dy = px - img.width / 2.0, py - img.height / 2.0
    pivot_x = rotated.width / 2.0 + dx * cos_a - dy * sin_a
    pivot_y = rotated.height / 2.0 + dx * sin_a + dy * cos_a
    canvas.alpha_composite(rotated, (round(cx - pivot_x), round(cy - pivot_y)))
    rotated.close()


def _resolve_image_path(o: dict, uploaded_files: dict[str, str]) -> Optional[str]:
    """Resolve an ImageOverlay to a server-side file path, or None.

    By `fileId` only — never by `src`, which is client-controlled (see the
    module docstring). `uploaded_files` is built from this order's own
    tenant's uploads (tasks._build_uploaded_files_map).
    """
    file_id = o.get("fileId")
    if file_id and file_id in uploaded_files:
        return uploaded_files[file_id]
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
