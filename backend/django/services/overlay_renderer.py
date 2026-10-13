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

    { type: 'text',  x, y, width?, fontSize, color, fontFamily, textAlign, rotation, text }
      fontFamily is honoured: see services/google_fonts.py.
    { type: 'shape', x, y, width, height, rotation, fill, stroke, strokeWidth, opacity, shapeType, svgPath? }
    { type: 'image', x, y, width, height, rotation, opacity, source, fileId?, src }

Coordinates from the editor are in **percentages of the canvas** (0–100)
not pixels — the renderer multiplies by canvas_w_px / canvas_h_px to
land in image space. `fontSize` and `strokeWidth` are already print pixels:
the editor's Fabric canvas is the layout's print size, so neither is scaled.
Text wraps inside `width` (% of the canvas, 80 when absent) exactly as the
Fabric Textbox in both previews does.

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
import re
from typing import Optional

from PIL import Image, ImageDraw, ImageOps

from services.google_fonts import FontUnavailable, get_overlay_font
from services.image_loader import open_source_rgba
from services.shape_catalog import UnsupportedPath, flatten_path, path_bbox, shape_def, shape_path

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
        except FontUnavailable:
            # Not skippable: printing without the text, or in another font,
            # is a wrong print. The render task retries.
            raise
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
#
# A text overlay is a Fabric `Textbox` in both previews (FabricEditor.tsx and
# fabric-renderer.ts), and the editor's canvas is the layout's print size, so
# `fontSize` is already print pixels: the print uses it unscaled (until
# 2026-10-13 it was multiplied by `canvas height / 800`, printing text about
# twice the size the customer saw). The box the text wraps in is `width` (% of
# the canvas), 80% when absent — `lib/overlay-text.ts` applies the same
# default on both clients. Wrapping and line placement follow Fabric's
# Textbox: words split on single spaces/tabs, a word wider than the box is
# never broken (the box widens to it), lines are `fontSize × 1.13 × 1.16`
# apart and the baseline of a line sits `fontSize × 1.13 × 0.778` below its
# top. Pinned by services/tests/test_overlay_text_layout.py.

DEFAULT_TEXT_BOX_WIDTH_PCT = 80.0
FABRIC_LINE_HEIGHT = 1.16        # Textbox.lineHeight default
FABRIC_FONT_SIZE_MULT = 1.13     # Text._fontSizeMult
FABRIC_FONT_SIZE_FRACTION = 0.222  # Text._fontSizeFraction

_WORD_JOINERS = re.compile(r"[ \t\r]")  # Textbox._wordJoiners
_NEWLINE = re.compile(r"\r?\n")


def wrap_text(text: str, measure, box_width: float) -> tuple[list[str], float]:
    """Wrap `text` the way Fabric's Textbox does.

    `measure(s)` returns the advance width of `s` in px. Returns the lines and
    the box width Fabric would end up with: `box_width`, widened to the
    largest word when one does not fit (Textbox.dynamicMinWidth).
    """
    hard_lines = _NEWLINE.split(text)
    words_per_line = [[(w, measure(w)) for w in _WORD_JOINERS.split(line)] for line in hard_lines]
    largest = max((ww for words in words_per_line for _, ww in words), default=0.0)
    max_width = max(box_width, largest)
    space_w = measure(" ")

    out: list[str] = []
    for words in words_per_line:
        line: list[str] = []
        line_width = 0.0
        infix_w = 0.0
        just_started = True
        for word, ww in words:
            line_width += infix_w + ww
            if line_width > max_width and not just_started:
                out.append("".join(line))
                line = []
                line_width = ww
                just_started = True
            if not just_started:
                line.append(" ")
            line.append(word)
            infix_w = space_w
            just_started = False
        out.append("".join(line))
    return out, max_width


def layout_text(
    lines: list[str], font_size: float, box_width: float, align: str, measure,
) -> list[tuple[str, float, float]]:
    """Place wrapped lines around the overlay's anchor (x, y).

    Returns `(line, dx, dy)` per line: the offset from the anchor to the
    line's left end on its baseline. Mirrors Fabric with originY 'center' and
    originX by textAlign (left → left edge at x, right → right edge, anything
    else → centred), lines aligned inside the box by textAlign.
    """
    n = len(lines)
    line_h = font_size * FABRIC_FONT_SIZE_MULT * FABRIC_LINE_HEIGHT
    height = (n - 1) * line_h + font_size * FABRIC_FONT_SIZE_MULT
    top = -height / 2.0
    baseline_in_line = font_size * FABRIC_FONT_SIZE_MULT * (1 - FABRIC_FONT_SIZE_FRACTION)

    if align == "left":
        box_left = 0.0
    elif align == "right":
        box_left = -box_width
    else:
        box_left = -box_width / 2.0

    placed = []
    for i, line in enumerate(lines):
        lw = measure(line)
        if align == "center":
            offset = (box_width - lw) / 2.0
        elif align == "right":
            offset = box_width - lw
        else:
            offset = 0.0
        placed.append((line, box_left + offset, top + i * line_h + baseline_in_line))
    return placed


def _draw_text(canvas: Image.Image, o: dict, cw: int, ch: int) -> None:
    """Render a `TextOverlay` onto canvas (assumed RGBA mode)."""
    text = str(o.get("text") or "")
    if not text:
        return

    font_size_px = max(1, int(round(float(o.get("fontSize") or 14))))
    color = _parse_color(o.get("color") or "#000000")

    # The family the editor previewed (services/google_fonts.py); Inter when
    # none is set. The editor never sets fontWeight, so text previews at 400.
    font_weight = int(o.get("fontWeight") or 400)
    font = get_overlay_font(o.get("fontFamily"), font_size_px, weight=font_weight)

    x_f = float(o.get("x") or 0) * cw / 100.0
    y_f = float(o.get("y") or 0) * ch / 100.0
    width_pct = o.get("width")
    box_width = float(width_pct if width_pct is not None else DEFAULT_TEXT_BOX_WIDTH_PCT) * cw / 100.0
    # Both previews draw an absent textAlign as centre.
    align = str(o.get("textAlign") or "center").lower()

    measure = font.getlength
    lines, box_width = wrap_text(text, measure, box_width)
    placed = layout_text(lines, font_size_px, box_width, align, measure)
    rotation = float(o.get("rotation") or 0.0)

    if abs(rotation) < 0.5:
        draw = ImageDraw.Draw(canvas)
        for line, dx, dy in placed:
            if line:
                draw.text((round(x_f + dx), round(y_f + dy)), line, font=font, fill=color, anchor="ls")
        return

    # Rotated text: PIL can't rotate `draw.text()`, so draw the block onto a
    # strip and rotate the strip around the anchor — the editor's Textbox
    # rotates around its origin point, which is this anchor.
    left = top = float("inf")
    right = bottom = float("-inf")
    for line, dx, dy in placed:
        if not line:
            continue
        l, t, r, b = font.getbbox(line, anchor="ls")
        left, top = min(left, dx + l), min(top, dy + t)
        right, bottom = max(right, dx + r), max(bottom, dy + b)
    if left == float("inf"):
        return
    pad = max(4, font_size_px // 4)
    ox, oy = math.floor(left) - pad, math.floor(top) - pad
    strip = Image.new("RGBA", (math.ceil(right) - ox + pad, math.ceil(bottom) - oy + pad), (0, 0, 0, 0))
    strip_draw = ImageDraw.Draw(strip)
    for line, dx, dy in placed:
        if line:
            strip_draw.text((round(dx - ox), round(dy - oy)), line, font=font, fill=color, anchor="ls")
    _composite_rotated(canvas, strip, (-ox, -oy), (x_f, y_f), rotation)
    strip.close()


# ── Shape ───────────────────────────────────────────────────────────────────
#
# Both previews build a shape with `createShapeFromOverlay` (lib/fabric-utils.ts)
# from the shape catalogue (lib/shape-catalog.ts, mirrored in
# services/shape_catalog.py). `shape_geometry` reproduces what Fabric then
# draws, in canvas px, including how Fabric places a stroked object: `left`/
# `top` are the corner of the box *including* the stroke, the stroke is
# centred on the geometry's edge, and a Path's stroke scales with the path.
# Pinned by services/tests/test_overlay_shape_geometry.py.


def shape_geometry(
    shape_type: str, svg_path: Optional[str],
    sx: float, sy: float, sw: float, sh: float, stroke_w: float,
) -> dict:
    """What the previews draw for a shape overlay whose box is (sx, sy, sw, sh).

    Returns one of
        {"kind": "rect",    "box": (l, t, r, b), "radius": r, "stroke_w": k}
        {"kind": "ellipse", "box": (l, t, r, b), "stroke_w": k}
        {"kind": "polygon", "polys": [[(x, y), ...], ...], "stroke_w": k}
    `box` is the geometry (the stroke is centred on its edge) and `stroke_w`
    the stroke's visual width in canvas px. Raises UnsupportedPath for a path
    the flattener can't draw.
    """
    d = shape_def(shape_type)
    fabric_type = d.get("fabricType") if d else None
    k = max(0.0, float(stroke_w))

    if fabric_type == "rect":
        radius = min(sw, sh) * 0.15 if shape_type == "rounded-rect" else 0.0
        return {
            "kind": "rect",
            "box": (sx + k / 2, sy + k / 2, sx + k / 2 + sw, sy + k / 2 + sh),
            "radius": radius, "stroke_w": k,
        }
    if fabric_type == "circle":
        r = min(sw, sh) / 2.0
        cx, cy = sx + sw / 2.0, sy + sh / 2.0
        return {"kind": "ellipse", "box": (cx - r, cy - r, cx + r, cy + r), "stroke_w": k}
    if fabric_type == "ellipse":
        cx, cy = sx + sw / 2.0, sy + sh / 2.0
        return {"kind": "ellipse", "box": (cx - sw / 2.0, cy - sh / 2.0, cx + sw / 2.0, cy + sh / 2.0), "stroke_w": k}
    if fabric_type == "triangle":
        ox, oy = sx + k / 2, sy + k / 2
        return {"kind": "polygon", "polys": [[(ox + sw / 2.0, oy), (ox + sw, oy + sh), (ox, oy + sh)]], "stroke_w": k}
    if fabric_type == "polygon" and d.get("polygonPoints"):
        pts = [(p["x"] / 100.0 * sw, p["y"] / 100.0 * sh) for p in d["polygonPoints"]]
        min_x, min_y = min(p[0] for p in pts), min(p[1] for p in pts)
        ox, oy = sx + k / 2 - min_x, sy + k / 2 - min_y
        return {"kind": "polygon", "polys": [[(px + ox, py + oy) for px, py in pts]], "stroke_w": k}

    # Fabric Path, scaled from the 100 x 100 catalogue space by (sw/100, sh/100):
    # the stroke scales with it (strokeUniform is off), non-uniformly when the
    # box is not square — Pillow draws one width, so take the mean.
    polys = flatten_path(shape_path(shape_type, svg_path))
    min_x, min_y, _, _ = path_bbox(polys)
    scale_x, scale_y = sw / 100.0, sh / 100.0
    ox, oy = sx + k * scale_x / 2, sy + k * scale_y / 2
    return {
        "kind": "polygon",
        "polys": [[(ox + (px - min_x) * scale_x, oy + (py - min_y) * scale_y) for px, py in poly] for poly in polys],
        "stroke_w": k * (scale_x + scale_y) / 2.0,
    }


def _draw_shape(canvas: Image.Image, o: dict, cw: int, ch: int) -> None:
    """Render a `ShapeOverlay` onto canvas (assumed RGBA mode)."""
    shape_type = str(o.get("shapeType") or "rect")
    if shape_def(shape_type) is None and not o.get("svgPath"):
        # The previews draw an unknown key as the rectangle path; so does the
        # print, but say so.
        logger.warning("Unknown shapeType %r — drawing the catalogue rectangle, as the preview does", shape_type)

    sx = float(o.get("x") or 0) * cw / 100.0
    sy = float(o.get("y") or 0) * ch / 100.0
    sw = float(o.get("width") or 0) * cw / 100.0
    sh = float(o.get("height") or 0) * ch / 100.0
    if sw <= 0 or sh <= 0:
        return

    opacity = o.get("opacity")
    fill = _parse_color(o.get("fill") or "transparent", opacity)
    stroke_w = float(o.get("strokeWidth") or 0)
    stroke = _parse_color(o.get("stroke") or "#000000", opacity) if stroke_w > 0 else None
    rotation = float(o.get("rotation") or 0.0)

    try:
        geom = shape_geometry(shape_type, o.get("svgPath"), sx, sy, sw, sh, stroke_w if stroke else 0.0)
    except UnsupportedPath as exc:
        logger.warning("Shape overlay %r has a path the print can't draw (%s) — skipping it", shape_type, exc)
        return

    k = geom["stroke_w"]
    if geom["kind"] == "polygon":
        pts = [p for poly in geom["polys"] for p in poly]
        bl, bt = min(p[0] for p in pts), min(p[1] for p in pts)
        br, bb = max(p[0] for p in pts), max(p[1] for p in pts)
    else:
        bl, bt, br, bb = geom["box"]
    pad = math.ceil(k / 2) + 2
    ox, oy = math.floor(bl) - pad, math.floor(bt) - pad
    strip = Image.new("RGBA", (math.ceil(br) - ox + pad, math.ceil(bb) - oy + pad), (0, 0, 0, 0))
    draw = ImageDraw.Draw(strip)
    width_px = int(round(k))

    if geom["kind"] in ("rect", "ellipse"):
        l, t, r, b = geom["box"]
        # Pillow strokes inward from the box it is given, so hand it the
        # outer edge of a stroke centred on the geometry.
        outer = (l - k / 2 - ox, t - k / 2 - oy, r + k / 2 - ox, b + k / 2 - oy)
        kwargs = {"fill": fill, "outline": stroke if width_px else None, "width": width_px}
        if geom["kind"] == "ellipse":
            draw.ellipse(outer, **kwargs)
        elif geom["radius"] > 0:
            draw.rounded_rectangle(outer, radius=geom["radius"] + k / 2, **kwargs)
        else:
            draw.rectangle(outer, **kwargs)
    else:
        for poly in geom["polys"]:
            local = [(px - ox, py - oy) for px, py in poly]
            if fill[3]:
                draw.polygon(local, fill=fill)
            if stroke is not None and width_px:
                draw.line(local + [local[0]], fill=stroke, width=width_px, joint="curve")

    # Pivot as in createShapeFromOverlay: circles and ellipses turn around
    # their centre, every other shape around its top-left corner.
    if geom["kind"] == "ellipse":
        pivot = (sx + sw / 2.0, sy + sh / 2.0)
    else:
        pivot = (sx, sy)
    _composite_rotated(canvas, strip, (pivot[0] - ox, pivot[1] - oy), pivot, rotation)
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

    if v in ("transparent", "none"):
        a = 0
    elif v.startswith("#"):
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
