"""
Colour-managed source-image loader — the single choke point for opening
customer photos server-side (Phase 2 item 3, colour management).

Why this exists:
    `Image.convert("RGBA")` re-labels raw channel values without converting
    them, silently discarding any embedded ICC profile. A Display-P3 iPhone
    photo composited as-if-sRGB desaturates in print, and a CMYK-tagged JPEG
    gets a naive inversion. Browsers colour-convert tagged images into the
    sRGB canvas when drawing the preview, so ignoring the profile here is
    exactly why print used to disagree with the editor.

Policy (mirrors the browser):
    - untagged source        → assume sRGB, pass through unchanged
    - sRGB-tagged source     → fast-path, no transform
    - other RGB/CMYK profile → lcms2 relative-colorimetric transform to sRGB
    - anything malformed     → log a warning and fail open (bad colour must
      never crash a render — same convention as engine._parse_hex_color)
"""
from __future__ import annotations

import io
import logging

from PIL import Image, ImageCms, ImageOps

logger = logging.getLogger(__name__)

# Built once per process; createProfile is pure-python-cheap but not free.
_SRGB_PROFILE = ImageCms.createProfile("sRGB")

# Modes lcms can transform directly to RGBA. Palette/greyscale sources fall
# through to the plain convert() path (their profiles are rare and low-risk).
_TRANSFORMABLE_MODES = ("RGB", "RGBA", "CMYK")


def srgb_profile_bytes() -> bytes:
    """ICC bytes for tagging output files as explicitly sRGB (~3 KB, cached)."""
    global _SRGB_BYTES
    try:
        return _SRGB_BYTES
    except NameError:
        _SRGB_BYTES = ImageCms.ImageCmsProfile(_SRGB_PROFILE).tobytes()
        return _SRGB_BYTES


def _convert_to_srgb(img: Image.Image) -> Image.Image:
    """Convert a profile-tagged image to sRGB RGBA; fail open on any error."""
    icc = img.info.get("icc_profile")
    if not icc:
        return img.convert("RGBA")
    try:
        src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        description = ImageCms.getProfileDescription(src_profile) or ""
        if "srgb" in description.lower():
            # Most common tag by far — skip the full-image transform.
            return img.convert("RGBA")
        if img.mode not in _TRANSFORMABLE_MODES:
            return img.convert("RGBA")
        # Request an alpha channel only when the source has one: lcms fills
        # the alpha of a CMYK→RGBA transform with 0, which would make the
        # photo print fully transparent (silently vanishing from the output).
        out_mode = "RGBA" if img.mode == "RGBA" else "RGB"
        converted = ImageCms.profileToProfile(
            img,
            src_profile,
            _SRGB_PROFILE,
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            outputMode=out_mode,
        )
        if converted is None:
            return img.convert("RGBA")
        return converted if converted.mode == "RGBA" else converted.convert("RGBA")
    except (ImageCms.PyCMSError, OSError, ValueError) as exc:
        logger.warning(
            "ICC conversion failed (%s: %s) — rendering with untransformed pixels",
            type(exc).__name__, exc,
        )
        return img.convert("RGBA")


def open_source_rgba(path: str) -> Image.Image:
    """
    Open a customer source image the way every render path must:
    EXIF-orientation applied, colour-managed into sRGB, mode RGBA.

    Raises OSError/ValueError like Image.open — callers keep their existing
    error handling.
    """
    with Image.open(path) as src:
        # Match the browser's display orientation (frame.rotation from the
        # editor is relative to the displayed-upright pixels).
        ImageOps.exif_transpose(src, in_place=True)
        return _convert_to_srgb(src)
