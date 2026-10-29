"""Layout templates: the pure rules, no Django, no DB.

A template is ops-authored decoration (background and paper colour, text,
stickers) for one layout. The customer picks it and the editor copies the
decoration onto every card as the card is created, so the print needs no
new step: a card's overlays already print, and a sticker is an image overlay
with an https `src`, which the editor draws to a PNG at submit and uploads
with the photos (the icon path, `lib/icon-raster.ts`). The server therefore
never resolves a sticker at print time and `src` stays a client-only field
(services/overlay_renderer.py, PR #239).

Shape, mirrored by `template.ts` on the client:

    {
      "surfaces": {
        "<surface key>": {
          "bgColor": "#ffffff",      # optional
          "paperColor": "#ffffff",   # optional
          "overlays": [ <Overlay> ]  # text | shape | image(clipart/icon)
        }
      }
    }

The one rule that matters for data lifecycle: a template never holds a
customer file. Image overlays must be `clipart` (an ops sticker) or `icon`
(an Iconify URL); `local` is refused, and so is any `fileId`, because a
customer upload is deleted after `EXPORT_RETENTION_DAYS` and the template
would then print without it.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Mapping
from urllib.parse import quote

TEMPLATE_ID_RE = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$')
_HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
_SURFACE_KEY_RE = re.compile(r'^[A-Za-z0-9_\-]{1,64}$')

STICKER_URL_PREFIX = '/api/templates/assets/'
MAX_OVERLAYS_PER_SIDE = 50
MAX_TEXT_CHARS = 2000
MAX_STICKER_BYTES = 5 * 1024 * 1024
MAX_STICKER_SIDE_PX = 4096

STATUS_DRAFT = 'draft'
STATUS_PUBLISHED = 'published'
STATUSES = (STATUS_DRAFT, STATUS_PUBLISHED)


class InvalidTemplate(ValueError):
    """The decoration or template fields are not something the editor can apply."""


def is_template_id(value: Any) -> bool:
    return isinstance(value, str) and bool(TEMPLATE_ID_RE.match(value))


def _check_pct(o: Mapping[str, Any], where: str, keys=('x', 'y', 'width', 'height')) -> None:
    for k in keys:
        v = o.get(k)
        if v is None:
            if k in ('x', 'y'):
                raise InvalidTemplate(f"{where}.{k} is required")
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise InvalidTemplate(f"{where}.{k} must be a number (percent of the canvas)")
        if not (0 <= float(v) <= 100):
            raise InvalidTemplate(f"{where}.{k} = {v} is out of range 0-100 (percent of the canvas)")


def _check_color(value: Any, where: str) -> None:
    if value is None:
        return
    if not isinstance(value, str) or not _HEX_COLOR_RE.match(value):
        raise InvalidTemplate(f"{where} must be a #rrggbb colour")


def _check_overlay(o: Any, where: str) -> None:
    if not isinstance(o, Mapping):
        raise InvalidTemplate(f"{where} must be an object")
    kind = o.get('type')
    if kind not in ('text', 'shape', 'image'):
        raise InvalidTemplate(f"{where}.type must be text, shape or image")
    if 'fileId' in o or 'originalFile' in o:
        raise InvalidTemplate(f"{where} references a customer upload; templates hold only ops stickers")
    if kind == 'text':
        _check_pct(o, where, keys=('x', 'y'))
        text = o.get('text')
        if not isinstance(text, str):
            raise InvalidTemplate(f"{where}.text is required")
        if len(text) > MAX_TEXT_CHARS:
            raise InvalidTemplate(f"{where}.text is longer than {MAX_TEXT_CHARS} characters")
        size = o.get('fontSize')
        if size is not None and (isinstance(size, bool) or not isinstance(size, (int, float)) or size <= 0):
            raise InvalidTemplate(f"{where}.fontSize must be a positive number")
        _check_color(o.get('color'), f"{where}.color")
        return
    if kind == 'shape':
        _check_pct(o, where)
        _check_color(o.get('fill'), f"{where}.fill")
        _check_color(o.get('stroke'), f"{where}.stroke")
        return
    # image
    _check_pct(o, where)
    source = o.get('source')
    if source not in ('clipart', 'icon'):
        raise InvalidTemplate(f"{where}.source must be clipart (an ops sticker) or icon")
    src = o.get('src')
    if not isinstance(src, str) or not src:
        raise InvalidTemplate(f"{where}.src is required")
    if not (src.startswith('https://') or src.startswith(STICKER_URL_PREFIX)):
        raise InvalidTemplate(f"{where}.src must be an https address or an ops sticker")


def validate_decoration(decoration: Any) -> dict:
    """Return the decoration as a plain dict, or raise InvalidTemplate."""
    if not isinstance(decoration, Mapping):
        raise InvalidTemplate("decoration must be an object")
    surfaces = decoration.get('surfaces')
    if not isinstance(surfaces, Mapping) or not surfaces:
        raise InvalidTemplate("decoration.surfaces must name at least one side")
    out: dict = {'surfaces': {}}
    for key, side in surfaces.items():
        if not isinstance(key, str) or not _SURFACE_KEY_RE.match(key):
            raise InvalidTemplate(f"decoration.surfaces has an invalid side key {key!r}")
        if not isinstance(side, Mapping):
            raise InvalidTemplate(f"decoration.surfaces[{key}] must be an object")
        where = f"decoration.surfaces[{key}]"
        _check_color(side.get('bgColor'), f"{where}.bgColor")
        _check_color(side.get('paperColor'), f"{where}.paperColor")
        overlays = side.get('overlays') or []
        if not isinstance(overlays, list):
            raise InvalidTemplate(f"{where}.overlays must be a list")
        if len(overlays) > MAX_OVERLAYS_PER_SIDE:
            raise InvalidTemplate(f"{where}.overlays holds more than {MAX_OVERLAYS_PER_SIDE} items")
        for i, o in enumerate(overlays):
            _check_overlay(o, f"{where}.overlays[{i}]")
        clean = {'overlays': [dict(o) for o in overlays]}
        for k in ('bgColor', 'paperColor'):
            if side.get(k) is not None:
                clean[k] = side[k]
        out['surfaces'][key] = clean
    return out


STICKER_EXTENSIONS = ('png', 'svg')


def png_filename(data: bytes, stem: str = 'sticker', ext: str = 'png') -> str:
    """Content-fingerprinted name, so a re-upload of the same file shares it
    and a changed sticker gets a new, cache-safe address. Stickers are PNG
    or SVG (an SVG is checked like an SVG mask before it is stored)."""
    if not re.match(r'^[a-z]{1,16}$', stem):
        raise ValueError("stem must be a short lowercase word")
    if ext not in STICKER_EXTENSIONS:
        raise ValueError(f"ext must be one of {STICKER_EXTENSIONS}")
    return f"{stem}_{hashlib.sha256(data).hexdigest()[:16]}.{ext}"


def sticker_url(filename: str) -> str:
    return STICKER_URL_PREFIX + filename


def editor_url(layout_name: str, token: str, template_id: str | None = None,
               template_flow: bool = False) -> str:
    """The iframe address for an embed session. The template rides on the
    address, like `order_id` does for the dashboard: the session row stores
    nothing new, the proxy injects nothing, and init re-validates the id."""
    url = f"/editor/layout/{quote(layout_name, safe='')}?token={quote(str(token), safe='')}"
    if template_id:
        url += f"&template={quote(template_id, safe='')}"
    if template_flow:
        url += "&template_flow=1"
    return url


def parse_template_flow(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


# ── Where a template was authored ────────────────────────────────────────────
#
# Since 2026-10-28 a template can be offered on every layout whose window box
# (services/print_sheet.py) is the same size as its home layout's. Its
# decoration is still stored in percent of the home canvas, so the editor
# needs the home geometry to place it on another canvas: every read adds it
# under `authoredOn`, derived from the home layout as it is NOW (so moving
# the home layout's print areas moves the art on every layout the same way
# it moves on the home), and the client (`layout-template.ts`) moves each
# overlay by its millimetre offset from the window box's centre. Nothing is
# stored: `validate_decoration` keeps only `surfaces`, so a client cannot
# plant a stamp of its own.

AUTHORED_ON = 'authoredOn'


def _num(value: Any):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0
    if n != n:
        return 0
    return int(n) if n == int(n) else n


def authored_on(definition: Any, layout_name: str) -> dict:
    """The home layout's geometry per surface: canvas (px and mm) and window box."""
    from services.print_sheet import surface_blocks, window_box_mm

    surfaces = {}
    for key, block in surface_blocks(definition if isinstance(definition, dict) else {}):
        canvas = block.get('canvas') if isinstance(block.get('canvas'), dict) else {}
        surfaces[key] = {
            'canvas': {
                'width': _num(canvas.get('width')), 'height': _num(canvas.get('height')),
                'widthMm': _num(canvas.get('widthMm')), 'heightMm': _num(canvas.get('heightMm')),
            },
            'windowBox': window_box_mm(block),
        }
    return {'layout': layout_name, 'surfaces': surfaces}


def with_authored_on(decoration: Any, definition: Any, layout_name: str) -> dict:
    """A copy of a stored decoration with the home layout's current geometry
    under `authoredOn`, for every read."""
    out = dict(decoration) if isinstance(decoration, dict) else {}
    out[AUTHORED_ON] = authored_on(definition, layout_name)
    return out
