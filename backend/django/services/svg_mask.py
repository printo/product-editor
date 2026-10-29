"""SVG layout masks: upload validation and rasterising at print size.

A PNG mask is a fixed grid of pixels that the print stretches to the canvas;
an SVG mask is drawn fresh at the canvas's exact pixel size, so its edges stay
sharp at 300 DPI however large the product is. Rendering uses resvg (a wheel,
no system libraries) and loads nothing from outside the file.
"""
from __future__ import annotations

import io
import re

from PIL import Image

MAX_SVG_BYTES = 5 * 1024 * 1024

_DOCTYPE_RE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.I)
_SCRIPT_RE = re.compile(rb"<\s*(script|foreignObject|iframe|embed|object)\b", re.I)
_EVENT_ATTR_RE = re.compile(rb"\son[a-z]+\s*=", re.I)
_EXTERNAL_REF_RE = re.compile(rb"""(?:href|src)\s*=\s*["']\s*(?!data:image/|#)""", re.I)
_URL_REF_RE = re.compile(rb"""url\(\s*["']?\s*(?!#)""", re.I)
_ROOT_RE = re.compile(rb"<svg\b[^>]*>", re.I | re.S)
_VIEWBOX_RE = re.compile(rb"""viewBox\s*=\s*["']""", re.I)
_SIZE_RE = re.compile(rb"""\b(width|height)\s*=\s*["']\s*[\d.]""", re.I)


def validate_svg_mask(data: bytes, what: str = "SVG masks") -> None:
    """Raise ValueError unless `data` is a self-contained SVG safe to store.

    Masks (and template stickers, which pass `what`) are served from the
    app's own origin and drawn by the print, so anything that runs code or
    reaches outside the file is refused.
    """
    if len(data) > MAX_SVG_BYTES:
        raise ValueError(f"{what} must be under 5 MB.")
    if b"\x00" in data:
        raise ValueError("That file is not a valid SVG.")
    root = _ROOT_RE.search(data)
    if not root:
        raise ValueError("That file is not a valid SVG.")
    if _DOCTYPE_RE.search(data):
        raise ValueError(f"{what} cannot contain a DOCTYPE or entity declarations.")
    if _SCRIPT_RE.search(data) or _EVENT_ATTR_RE.search(data):
        raise ValueError(f"{what} cannot contain scripts or embedded objects.")
    if _EXTERNAL_REF_RE.search(data) or _URL_REF_RE.search(data):
        raise ValueError(f"{what} cannot link to files outside themselves. Embed the artwork or remove the link.")
    tag = root.group(0)
    if not _VIEWBOX_RE.search(tag) and not (
        len(_SIZE_RE.findall(tag)) >= 2
    ):
        raise ValueError("The SVG needs a viewBox (or a width and a height) so it can be scaled to the canvas.")
    try:
        rasterize_svg_mask(data, 16, 16)
    except Exception as exc:
        raise ValueError(f"That SVG could not be rendered: {exc}") from exc


_VIEWBOX_VALUE_RE = re.compile(rb"""viewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']""", re.I)


def normalize_svg_mask(data: bytes) -> bytes:
    """Give the root `<svg>` a pixel width and height taken from its viewBox.

    A browser sizes an `<img>` from the SVG's own width and height; with only
    a viewBox Chrome reports a 100x150 box (fitted into 300x150), and the
    editor preview then draws the mask at the wrong scale. The print ignores
    these attributes (rasterize_svg_mask overrides them), so this only fixes
    the preview. An SVG that already has a numeric width and height is kept.
    """
    root = _ROOT_RE.search(data)
    if not root:
        return data
    tag = root.group(0)
    if len(_SIZE_RE.findall(tag)) >= 2:
        return data
    box = _VIEWBOX_VALUE_RE.search(tag)
    if not box:
        return data
    w, h = box.group(1).decode(), box.group(2).decode()
    for attr in (b"width", b"height"):
        tag_wo = re.sub(rb"""\s%s\s*=\s*(["']).*?\1""" % attr, b"", tag, flags=re.I | re.S)
        tag = tag_wo
    new = tag[:-1].rstrip(b"/") + (' width="%s" height="%s"' % (w, h)).encode() + (b"/>" if tag.rstrip().endswith(b"/>") else b">")
    return data[:root.start()] + new + data[root.end():]


def rasterize_svg_mask(data: bytes, width: int, height: int) -> Image.Image:
    """The SVG drawn at exactly width x height as RGBA.

    The artwork is stretched to the canvas, as the editor's preview stretches
    a PNG mask, so the print and the preview agree for any aspect ratio.
    """
    import resvg_py

    w, h = int(width), int(height)

    def _stretch(match: re.Match) -> bytes:
        # resvg fits artwork inside the target keeping its aspect ratio, so
        # give the root the canvas's own size and let the viewBox stretch.
        tag = match.group(0)
        for attr in (b"width", b"height", b"preserveAspectRatio"):
            tag = re.sub(rb"""\s%s\s*=\s*(["']).*?\1""" % attr, b"", tag, flags=re.I | re.S)
        return tag[:-1] + (' width="%d" height="%d" preserveAspectRatio="none">' % (w, h)).encode()

    text = _ROOT_RE.sub(_stretch, data, count=1).decode("utf-8", errors="replace")
    png = resvg_py.svg_to_bytes(svg_string=text, skip_system_fonts=True)
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    if img.size != (w, h):
        resized = img.resize((w, h), Image.Resampling.LANCZOS)
        img.close()
        img = resized
    return img
