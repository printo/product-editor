"""
CMYK soft-proof conversion for print-ready export.

Workflow
--------
1. RGB canvas  →  CMYK TIFF          (send this file to press)
2. CMYK TIFF   →  RGB soft-proof PNG (on-screen simulation of printed colours)
3. Diff original RGB vs soft-proof   →  colour-shift report for the user

Colour profile
--------------
ISOcoated_v2 — industry standard for offset printing on coated paper (ISO 12647-2).
Used by the vast majority of Indian and European commercial print shops.

To activate ICC-calibrated conversion:
  - Download ISOcoated_v2_eci.icc from http://www.eci.org (free, ~2 MB)
  - Place at:   backend/django/icc_profiles/ISOcoated_v2_eci.icc
  - OR set env: ICC_CMYK_PROFILE_PATH=/absolute/path/to/profile.icc

Without the file, Pillow's built-in profile-less conversion is used as a fallback.
Colours are approximate — saturated blues, vivid greens, and bright oranges shift most.
"""

import os
import logging
from PIL import Image, ImageCms, ImageChops, ImageStat

logger = logging.getLogger(__name__)

# Default ICC profile path — relative to backend/django/
_DEFAULT_PROFILE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),  # backend/django/
    "icc_profiles",
    "ISOcoated_v2_eci.icc",
)

# Colour-shift threshold on 0–255 scale.
# avg_diff > 8 (~3 %) → significant warning shown to user.
_SIGNIFICANT_THRESHOLD = 8


class CmykConverter:
    """
    ICC-aware RGB ↔ CMYK converter.

    Instantiate once per Gunicorn worker (use module-level get_converter()).
    ICC transforms are expensive to build; caching them amortises cost across requests.
    """

    def __init__(self) -> None:
        self._rgb_to_cmyk: "ImageCms.ImageCmsTransform | None" = None
        self._cmyk_to_rgb: "ImageCms.ImageCmsTransform | None" = None
        self._icc_loaded = False
        self._profile_name = "basic Pillow (no ICC profile)"
        self._init_transforms()

    def _init_transforms(self) -> None:
        profile_path = os.getenv("ICC_CMYK_PROFILE_PATH", _DEFAULT_PROFILE_PATH)
        if not os.path.exists(profile_path):
            logger.warning(
                "[CMYK] ICC profile not found at '%s' — using profile-less fallback. "
                "Download ISOcoated_v2_eci.icc from http://www.eci.org and place it "
                "at that path for calibrated colour management.",
                profile_path,
            )
            return
        try:
            srgb = ImageCms.createProfile("sRGB")
            cmyk_profile = ImageCms.getOpenProfile(profile_path)
            self._rgb_to_cmyk = ImageCms.buildTransform(
                srgb,
                cmyk_profile,
                "RGB",
                "CMYK",
                renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            )
            self._cmyk_to_rgb = ImageCms.buildTransform(
                cmyk_profile,
                srgb,
                "CMYK",
                "RGB",
                renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            )
            self._icc_loaded = True
            self._profile_name = os.path.basename(profile_path)
            logger.info("[CMYK] ICC profile loaded: %s", profile_path)
        except Exception as exc:
            logger.error(
                "[CMYK] Failed to load ICC profile '%s': %s — using fallback.",
                profile_path,
                exc,
            )

    @property
    def using_icc(self) -> bool:
        return self._icc_loaded

    def to_cmyk(self, rgb_img: Image.Image) -> Image.Image:
        """Convert an RGB image to CMYK using ICC profile (or fallback)."""
        if self._rgb_to_cmyk:
            return ImageCms.applyTransform(rgb_img, self._rgb_to_cmyk)
        return rgb_img.convert("CMYK")

    def to_rgb_preview(self, cmyk_img: Image.Image) -> Image.Image:
        """
        Convert CMYK back to RGB — simulates how printed colours appear on screen.
        This is the soft-proof: out-of-gamut colours are visibly remapped.
        """
        if self._cmyk_to_rgb:
            return ImageCms.applyTransform(cmyk_img, self._cmyk_to_rgb)
        return cmyk_img.convert("RGB")

    def colour_shift_report(
        self,
        original_rgb: Image.Image,
        preview_rgb: Image.Image,
    ) -> dict:
        """
        Pixel-level perceptual comparison between original RGB and CMYK roundtrip preview.

        Uses ImageChops + ImageStat (no external dependencies).
        avg_diff is on a 0–255 scale; > 8 is flagged as significant.

        Returns
        -------
        dict with keys: avg_diff, max_pixel_diff, significant, using_icc_profile,
                        profile, message
        """
        o = original_rgb.convert("RGB")
        p = preview_rgb.convert("RGB")
        if o.size != p.size:
            p = p.resize(o.size, Image.Resampling.NEAREST)

        diff = ImageChops.difference(o, p)
        stat = ImageStat.Stat(diff)
        avg_diff = sum(stat.mean[:3]) / 3
        max_diff = int(max(stat.extrema[i][1] for i in range(3)))
        significant = avg_diff > _SIGNIFICANT_THRESHOLD

        icc_note = (
            f"ISOcoated_v2 ICC profile ({self._profile_name})"
            if self._icc_loaded
            else "basic conversion — install ISOcoated_v2_eci.icc for calibrated output"
        )

        if significant:
            message = (
                f"Colour shift detected when converting to CMYK for print "
                f"(average shift {avg_diff:.1f} / 255, {icc_note}). "
                f"Saturated blues, bright greens, and vivid oranges are most affected — "
                f"these colours fall outside the CMYK gamut. "
                f"Review the CMYK preview before sending to press."
            )
        else:
            message = (
                f"Colours look accurate for print "
                f"(average shift {avg_diff:.1f} / 255, {icc_note}). "
                f"The CMYK preview closely matches your original design."
            )

        return {
            "avg_diff": round(avg_diff, 2),
            "max_pixel_diff": max_diff,
            "significant": significant,
            "using_icc_profile": self._icc_loaded,
            "profile": self._profile_name,
            "message": message,
        }


# ── Module-level singleton — built once per Gunicorn worker ──────────────────
# ICC transform construction is expensive (~50–200 ms); caching avoids rebuilding
# it on every request. Each Gunicorn worker process gets its own instance.

_converter: "CmykConverter | None" = None


def get_converter() -> CmykConverter:
    global _converter
    if _converter is None:
        _converter = CmykConverter()
    return _converter
