"""
Server-side helpers for the calendar product type
(CALENDAR_FEATURE_PRD.md §10 + §11).

A calendar layout is stored as a single template — one canvas, one
frame layout, one calendar primitive (or N for the poster variant).
The engine consumes calendar layouts via the existing multi-surface
dispatch path. This module bridges between the two by materializing
the template into N surfaces (one per visible month), applying any
per-month surfaceOverrides, and stamping each surface with a
displayLabel for the ZIP filename convention.

Resolution rules
================

`startMonth` is derived from the customer's calendar-type choice
(English ⇒ January = 1; Financial ⇒ April = 4 — Indian FY).

`baseYear` is derived from today's date + calendarType (PRD §10.4):
  english   → today.year
  financial → today.year if today.month >= 4 else today.year - 1

For surface index `i` and a calendar primitive's `monthOffset` j:
  totalOffset = i + (j or 0)
  realMonth   = ((startMonth - 1 + totalOffset) % 12) + 1
  realYear    = baseYear + (startMonth - 1 + totalOffset) // 12

The two valid v1 product shapes (PRD §11.1):
  multi-surface:     monthRange.count = 12, len(calendars) = 1
  poster-on-one:     monthRange.count = 1,  len(calendars) = 12

Constraint: monthRange.count × len(calendars) == 12. Enforced by the
PUT validator (`api.validators.validate_calendar_layout`); this
module trusts the layout is already valid by the time it gets called.
"""
from __future__ import annotations

import copy
import logging
from datetime import date
from typing import Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)


# ── Constants ───────────────────────────────────────────────────────────────

_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

# PRD §11.13: All customers in India for v1.
_IST = ZoneInfo("Asia/Kolkata")


# ── Time / year resolution (§10.4) ──────────────────────────────────────────

def today_ist() -> date:
    """Return today's date in IST. v1 customers are India-only (§11.13)."""
    from datetime import datetime
    return datetime.now(tz=_IST).date()


def resolve_base_year(calendar_type: str, today: Optional[date] = None) -> int:
    """
    Implement the PRD §10.4 baseYear formula.

    Args:
        calendar_type: 'english' (Jan–Dec) or 'financial' (Apr–Mar, India FY).
        today: defaults to today's date in IST.

    Returns:
        The base Gregorian year that the materialized surfaces span.
    """
    if today is None:
        today = today_ist()

    if calendar_type == "financial":
        # Apr–Dec → current calendar year is the FY-start year
        # Jan–Mar → previous calendar year is the FY-start year
        return today.year if today.month >= 4 else today.year - 1
    return today.year


def resolve_default_year(default_year, calendar_type: str) -> int:
    """
    Resolve a layout's `monthRange.defaultYear` to a concrete year.

    `"current"` triggers auto-roll via today + calendar_type (PRD §10.4);
    any concrete integer year is passed through. Invalid values fall back
    to today's calendar year — defensive only; validator should have
    rejected them at save time.
    """
    if default_year == "current" or default_year is None:
        return resolve_base_year(calendar_type)
    if isinstance(default_year, int):
        return default_year
    logger.warning(
        "Unexpected monthRange.defaultYear=%r — falling back to current year",
        default_year,
    )
    return resolve_base_year(calendar_type)


# ── Surface-index → (year, month) (§11.1) ───────────────────────────────────

def start_month_for(calendar_type: str) -> int:
    """1 for English (Jan), 4 for Financial (Apr)."""
    return 4 if calendar_type == "financial" else 1


def resolve_surface_month(
    surface_index: int,
    month_offset: int,
    calendar_type: str,
    base_year: int,
) -> tuple[int, int]:
    """
    Resolve a (year, month) pair for a given (surface, primitive) position.

    The formula handles both v1 modes uniformly:
      - Multi-surface (12 surfaces × 1 calendar):
            surface_index = 0..11, month_offset = 0
      - Poster (1 surface × 12 calendars):
            surface_index = 0, month_offset = 0..11

    Returns:
        (year, month) — month is 1..12.
    """
    start = start_month_for(calendar_type)
    total = surface_index + (month_offset or 0)
    real_month = ((start - 1 + total) % 12) + 1
    real_year = base_year + (start - 1 + total) // 12
    return real_year, real_month


def display_label_for(year: int, month: int) -> str:
    """ZIP-filename-friendly month/year label (PRD §11.6)."""
    return f"{_MONTH_NAMES[month - 1]} {year}"


# ── Surface materialization (§10.2) ─────────────────────────────────────────

def materialize_surfaces(
    layout: dict,
    *,
    calendar_type_override: Optional[str] = None,
    base_year_override: Optional[int] = None,
    theme_preset_override: Optional[str] = None,
    palette_name_override: Optional[str] = None,
) -> list[dict]:
    """
    Expand a calendar template into a list of concrete surfaces.

    Args:
        layout: parsed layout JSON for a `productType == 'calendar'` layout.
            Must already pass `validate_calendar_layout()`.
        calendar_type_override: customer's calendar-type pick on the preview
            page. Falls back to the layout's ops-default.
        base_year_override: explicit year (e.g. when the customer changes
            it via a future UI). Falls back to the auto-roll formula.

    Returns:
        A list of N surface dicts shaped like a regular multi-surface
        layout's `surfaces[]`. Each surface has:
            key:          "month_NN"
            displayLabel: "January 2026"  (PRD §11.6)
            canvas:       inherited from layout (mutated through overrides)
            frames:       template OR surfaceOverride[key].frames
            calendars:    template OR surfaceOverride[key].calendars
            overlays:     template overlays + surfaceOverride[key].overlays
            month:        1..12 (Gregorian)
            year:         resolved Gregorian year
            monthOffset:  the calendar primitive's monthOffset value
                          (relevant in poster mode)

    The returned list has length = monthRange.count × len(calendars). For
    v1 that's always 12.
    """
    if layout.get("productType") != "calendar":
        raise ValueError("materialize_surfaces() requires productType == 'calendar'")

    month_range = layout.get("monthRange") or {}
    count = int(month_range.get("count") or 12)
    calendars_template = list(layout.get("calendars") or [])
    if not calendars_template:
        raise ValueError("calendar layout has no calendars[]")

    style = dict(layout.get("calendar") or {})
    # Customer-side overrides layer on top of the layout's ops-set defaults.
    # Mutating a shallow copy of the style dict keeps downstream surface
    # bubble-throughs (which copy `style`) consistent with the resolved
    # values rather than stale layout defaults.
    if theme_preset_override:
        style["themePreset"] = theme_preset_override
    if palette_name_override:
        style["defaultGenzPalette"] = palette_name_override

    calendar_type = calendar_type_override or style.get("calendarType") or "english"
    base_year = base_year_override if base_year_override is not None else (
        resolve_default_year(month_range.get("defaultYear"), calendar_type)
    )

    # ── Resolve auto-loaded data once per layout ──────────────────────────
    # Holidays (PRD §11.9 / §11.11): when the layout opts in via
    # holidaySource.enabled, load the year's events from disk. We may end
    # up loading 2 years if the FY range spans baseYear and baseYear+1.
    holiday_source = style.get("holidaySource") if isinstance(style, dict) else None
    holidays_by_year: dict[int, list[dict]] = {}
    if isinstance(holiday_source, dict) and holiday_source.get("enabled"):
        from services.calendar_holidays import load_holidays_for_year
        locale = holiday_source.get("locale") or "generic"
        for y in (base_year, base_year + 1):
            holidays_by_year[y] = load_holidays_for_year(locale, y)

    # Gen-Z palette (PRD §10.3): when themePreset == 'modern-genz', resolve
    # the active palette JSON (customer's choice or layout default) from
    # storage/calendar_palettes/genz/<name>.json once and bubble it onto
    # every surface so the renderer doesn't re-read the file 12 times.
    active_palette = _resolve_genz_palette(style) if style.get("themePreset") == "modern-genz" else None

    overrides = layout.get("surfaceOverrides") or {}
    template_canvas = layout.get("canvas") or {}
    template_frames = layout.get("frames") or []
    template_overlays = layout.get("overlays") or []
    # Mask is layout-global per PRD §10.2.1 (not in the allowed per-surface
    # override list — same treatment as canvas dimensions). Every
    # materialized surface inherits the layout's mask config; ops can't
    # override it per month in v1.
    template_mask_url = layout.get("maskUrl")
    template_mask_on_export = bool(layout.get("maskOnExport", False))

    surfaces: list[dict] = []

    # Multi-surface mode (count > 1, 1 calendar per surface) vs
    # multi-calendar-single-page mode (count == 1, N calendars on one page).
    # The loop below produces one surface entry per (surface_index, calendar)
    # pair — for count=12,cal=1 that's 12 entries; for count=1,cal=12 that's
    # also 12 entries but all sharing surface_index=0.
    seen_keys: set[str] = set()
    for surface_index in range(count):
        for cal_idx, calendar in enumerate(calendars_template):
            month_offset = int(calendar.get("monthOffset") or 0)
            year, month = resolve_surface_month(
                surface_index, month_offset, calendar_type, base_year,
            )

            # In multi-surface mode there's one calendar per surface — the
            # surface key keys off the resolved month. In poster mode, all
            # 12 calendars are on one surface; we still emit 12 surface
            # entries so the renderer / customer-preview UI can address
            # each month-card individually, but they share a real surface.
            key = f"month_{month:02d}"
            # Guard against accidental key collisions if validator missed
            # something (defensive — shouldn't happen if validator passed).
            if key in seen_keys:
                key = f"month_{month:02d}_idx{cal_idx:02d}"
            seen_keys.add(key)

            override = overrides.get(key) or {}

            # Deep-copy the template fields we hand back so callers can
            # mutate without poisoning the original layout dict.
            surface = {
                "key": key,
                "displayLabel": display_label_for(year, month),
                "canvas": copy.deepcopy(template_canvas),
                "frames": copy.deepcopy(override.get("frames", template_frames)),
                "calendars": copy.deepcopy(override.get("calendars", [calendar])),
                "overlays": copy.deepcopy(
                    override.get("overlays", template_overlays)
                ),
                # Mask config is layout-global (§10.2.1) — inherited unchanged
                # on every materialized surface. The engine's existing
                # multi-surface dispatch already knows how to load + composite
                # masks from these two fields, so no further wire-up needed.
                "maskUrl": template_mask_url,
                "maskOnExport": template_mask_on_export,
                # Holidays + palette resolved at the layout level above —
                # bubble onto every surface so the renderer doesn't re-read.
                # The renderer filters holidays by cell ISO date itself, so
                # we hand it the full year's list (events outside the
                # visible window just never match).
                "holidays": list(holidays_by_year.get(year) or []),
                "activePalette": copy.deepcopy(active_palette) if active_palette else None,
                "month": month,
                "year": year,
                "monthOffset": month_offset,
                "calendarType": calendar_type,
                "baseYear": base_year,
                # Bubble the style block down so per-surface rendering has
                # the colors / theme / holidaySource without reading back
                # to the parent layout.
                "calendar": copy.deepcopy(style),
            }
            surfaces.append(surface)

    return surfaces


# ── Gen-Z palette resolution (PRD §10.3) ────────────────────────────────────

def _resolve_genz_palette(style: dict) -> Optional[dict]:
    """
    Load the active Gen-Z palette JSON from disk.

    Args:
        style: layout's `calendar` style block. Reads `defaultGenzPalette`
            for the layout's ops-set default; in v2 a customer override
            field will sit on top of this.

    Returns:
        The full palette dict from `storage/calendar_palettes/genz/<name>.json`,
        or None if the file can't be read. Caller (renderer) treats None
        as "fall through to theme defaults" — never crashes.
    """
    import json
    import os
    import re
    from django.conf import settings

    name = style.get("defaultGenzPalette") or "butter"
    # Path-traversal guard mirrors api/views.py::_safe_locale_year.
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        logger.warning("Bogus genz palette name %r — falling back to defaults", name)
        return None

    # S3-readiness (PRD §11.17 / audit fix #10): use Django's default_storage
    # instead of raw open() so the v2 swap to S3 is a contained config change
    # rather than a code change. The storage path is relative to STORAGE_ROOT.
    storage_path = os.path.join("calendar_palettes", "genz", f"{name}.json")
    from django.core.files.storage import default_storage
    if not default_storage.exists(storage_path):
        logger.warning(
            "Gen-Z palette file missing: %s — renderer will use theme defaults", storage_path,
        )
        return None
    try:
        with default_storage.open(storage_path, "r") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to load palette %s: %s", storage_path, exc)
        return None
