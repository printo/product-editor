"""
Server-side font loader for the Pillow-based overlay + calendar renderer.

Per PRD §11.7: a single bundled font (Inter Variable) is used for every
text element across overlays and the calendar grid. No font picker is
exposed to ops or customer. Hardcoding one well-engineered variable
font eliminates an entire class of production failure (missing fonts,
licence drift, ttf-not-matching-fonts.json) and matches the editor
preview byte-for-byte at 300 DPI.

How it works
============
  * The .ttf lives at `backend/django/services/fonts_assets/Inter-Variable.ttf`
    (Apache 2.0; sourced from https://rsms.me/inter/).
  * `get_font(size_px, weight=400)` returns a cached `PIL.ImageFont` for
    the requested pixel size + weight. The variable axis is set on the
    PIL font object so a single .ttf serves every weight (400, 500, 600,
    700) without bundling four files.
  * Misses fall back to PIL's default bitmap font (load_default) so a
    deploy that forgets to copy the .ttf still renders text — just
    ugly text — instead of crashing the worker.

Concurrency / caching
=====================
PIL Font objects are immutable post-construction. We cache one per
(size, weight) tuple in a process-local dict, guarded by a Lock for the
first-touch insert. Reads are lock-free.
"""
from __future__ import annotations

import functools
import logging
import struct
import threading
from pathlib import Path
from typing import Optional

from PIL import ImageFont

logger = logging.getLogger(__name__)

# Bundled font path — single source of truth. Drop the .ttf alongside
# this module per the README in fonts_assets/.
_FONT_PATH = Path(__file__).parent / "fonts_assets" / "Inter-Variable.ttf"

# Variable-axis tag for weight. Inter exposes "wght" continuously over
# 100..900 — we clamp callers to {400, 500, 600, 700} since the editor
# only emits those four.
#
# Inter also has an "opsz" (optical size) axis, and it comes FIRST in the
# font's fvar table: [opsz, wght]. Pillow's set_variation_by_axes is
# positional, so passing [weight] alone wrote the weight into opsz and
# left wght at 400 — every weight printed as Regular. Axes are therefore
# set by tag (see _axis_values), never by assumed position.
_WGHT_AXIS = "wght"
_ALLOWED_WEIGHTS = (400, 500, 600, 700)

# Process-local cache. Key = (px_size_int, weight_int). Value = ImageFont.
_FONT_CACHE: dict[tuple[int, int], ImageFont.ImageFont] = {}
_CACHE_LOCK = threading.Lock()

# Sentinel used when the .ttf is missing — we cache the PIL default font
# once so we don't log the "font missing" warning on every render.
_FALLBACK_LOGGED = False
# Same, for a runtime that can't apply variation axes. The calendar's
# autofit binary-searches font sizes, so this would otherwise log per size.
_VARIATION_FAILURE_LOGGED = False


def get_font(size_px: int, weight: int = 400) -> ImageFont.ImageFont:
    """
    Return a cached PIL ImageFont for the requested pixel size + weight.

    Args:
        size_px: integer pixel size at the target DPI. The caller is
            responsible for scaling pt → px (e.g. 14pt @ 300 DPI ≈ 58 px).
        weight: one of 400 / 500 / 600 / 700. Clamped to the nearest
            allowed weight if a non-allowed value is passed.

    Returns:
        ImageFont.FreeTypeFont when the bundled .ttf is available;
        PIL's default bitmap font otherwise (with a one-time warning).
    """
    # Clamp weight to allowed set without throwing — renderer should never
    # fail because of a stray weight value coming from layout JSON.
    if weight not in _ALLOWED_WEIGHTS:
        weight = min(_ALLOWED_WEIGHTS, key=lambda w: abs(w - weight))

    # Round down odd sizes so cache entries don't proliferate. 1-px
    # quantization is invisible on 300 DPI output.
    size_px = max(1, int(size_px))
    key = (size_px, weight)

    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached

    with _CACHE_LOCK:
        # Double-check after acquiring the lock — another thread may have
        # populated the cache between our miss and the lock.
        cached = _FONT_CACHE.get(key)
        if cached is not None:
            return cached

        font = _load_font(size_px, weight)
        _FONT_CACHE[key] = font
        return font


@functools.lru_cache(maxsize=None)
def _read_axis_records(font_path: str) -> tuple[tuple[str, float, float, float], ...]:
    """
    Return the font's variation axes as (tag, min, default, max), in fvar
    order — the order set_variation_by_axes expects its values in.

    Pillow's get_variation_axes() reports each axis's display name but not
    its tag, and that name is a localisable, encoding-dependent string, so
    the tags are read from the fvar table directly. Returns () for a static
    font or anything unparseable; the caller then leaves the font's default
    instance untouched.
    """
    try:
        data = Path(font_path).read_bytes()
        num_tables = struct.unpack_from(">H", data, 4)[0]
        for i in range(num_tables):
            tag, _checksum, offset, _length = struct.unpack_from(">4sIII", data, 12 + 16 * i)
            if tag != b"fvar":
                continue
            _major, _minor, axes_offset, _reserved, axis_count, axis_size = (
                struct.unpack_from(">6H", data, offset)
            )
            records = []
            for j in range(axis_count):
                axis_tag, min_v, default_v, max_v = struct.unpack_from(
                    ">4siii", data, offset + axes_offset + j * axis_size,
                )
                # Fixed 16.16 → float.
                records.append((
                    axis_tag.decode("ascii"),
                    min_v / 65536, default_v / 65536, max_v / 65536,
                ))
            return tuple(records)
    except (OSError, struct.error, UnicodeDecodeError) as exc:
        logger.warning("Could not read variation axes from %s: %s", font_path, exc)
    return ()


def _axis_values(
    records: tuple[tuple[str, float, float, float], ...], weight: int,
) -> Optional[list[float]]:
    """
    Build the positional value list for set_variation_by_axes: the requested
    weight on "wght", every other axis at its default. Returns None when the
    font has no weight axis, so the caller leaves it alone.

    Holding opsz at its default (14 for Inter, the "text" design) matches the
    editor preview, which requests Inter from Google Fonts with only a wght
    axis and so always renders the default optical size.
    """
    if not any(tag == _WGHT_AXIS for tag, *_ in records):
        return None
    return [
        min(max_v, max(min_v, float(weight))) if tag == _WGHT_AXIS else default_v
        for tag, min_v, default_v, max_v in records
    ]


def _load_font(size_px: int, weight: int) -> ImageFont.ImageFont:
    """Construct a fresh ImageFont. Falls back to PIL default on miss."""
    global _FALLBACK_LOGGED, _VARIATION_FAILURE_LOGGED

    if not _FONT_PATH.exists():
        if not _FALLBACK_LOGGED:
            logger.warning(
                "Bundled font missing at %s — falling back to PIL default. "
                "Drop Inter-Variable.ttf into services/fonts_assets/ to "
                "restore 300 DPI text quality.",
                _FONT_PATH,
            )
            _FALLBACK_LOGGED = True
        return ImageFont.load_default()

    try:
        font = ImageFont.truetype(str(_FONT_PATH), size=size_px)
        # Set the variable-axis weight if Pillow's build supports it.
        # set_variation_by_axes was added in Pillow 9.4, and raises
        # NotImplementedError when FreeType is older than 2.9.1. Either
        # way we get the .ttf's default instance (Inter ships it at 400)
        # — acceptable fallback, but logged, since it silently un-bolds
        # every heading in print.
        values = _axis_values(_read_axis_records(str(_FONT_PATH)), weight)
        if values is not None:
            try:
                font.set_variation_by_axes(values)
            except (AttributeError, NotImplementedError, OSError) as exc:
                if not _VARIATION_FAILURE_LOGGED:
                    logger.warning(
                        "Could not set font weight on %s (%s) — all text will "
                        "render at the font's default weight.",
                        _FONT_PATH, exc,
                    )
                    _VARIATION_FAILURE_LOGGED = True
        return font
    except (OSError, ValueError) as exc:
        logger.warning(
            "Failed to load %s at size=%d weight=%d: %s — falling back to default",
            _FONT_PATH, size_px, weight, exc,
        )
        return ImageFont.load_default()


def startup_check() -> bool:
    """
    Log whether the bundled font is present at startup. Called from
    a Django AppConfig.ready() hook so missing-font deployments are
    visible in the boot log, not just on first render.

    Returns True if the font file exists, False otherwise.
    """
    if _FONT_PATH.exists():
        logger.info("Bundled font OK: %s", _FONT_PATH)
        return True
    logger.error(
        "BUNDLED FONT MISSING: %s. Text overlays + calendar grids will "
        "render with PIL's default bitmap font (low quality). Drop "
        "Inter-Variable.ttf into services/fonts_assets/.",
        _FONT_PATH,
    )
    return False
