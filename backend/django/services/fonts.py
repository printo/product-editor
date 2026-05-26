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

import logging
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
_WGHT_AXIS = "wght"
_ALLOWED_WEIGHTS = (400, 500, 600, 700)

# Process-local cache. Key = (px_size_int, weight_int). Value = ImageFont.
_FONT_CACHE: dict[tuple[int, int], ImageFont.ImageFont] = {}
_CACHE_LOCK = threading.Lock()

# Sentinel used when the .ttf is missing — we cache the PIL default font
# once so we don't log the "font missing" warning on every render.
_FALLBACK_LOGGED = False


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


def _load_font(size_px: int, weight: int) -> ImageFont.ImageFont:
    """Construct a fresh ImageFont. Falls back to PIL default on miss."""
    global _FALLBACK_LOGGED

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
        # set_variation_by_axes was added in Pillow 9.4. If the runtime
        # has an older Pillow, we silently get the .ttf's default weight
        # (which Inter ships at 400) — acceptable fallback.
        try:
            font.set_variation_by_axes([weight])
        except (AttributeError, OSError):
            pass
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
