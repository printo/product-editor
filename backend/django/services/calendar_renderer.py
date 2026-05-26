"""
Server-side calendar grid renderer (CALENDAR_FEATURE_PRD.md §5 Phase 4).

Draws a single month's grid (weekday header + 35/42 date cells) onto a
PIL canvas at 300 DPI. The math here mirrors `frontend/nextjs/src/lib/
calendar.ts` 1:1 — both sides produce identical (year, month) and
identical grid topology for any (calendarType, baseYear, monthOffset,
surfaceIndex) input so the editor preview lines up with the printed
output.

Rendering order, called from `_composite_canvas` after `render_overlays`
and before the layout mask (PRD z-order in §10.3):

    frames composited (existing engine logic)
    └── render_overlays()        (Phase 1)
    └── render_calendar()        ← THIS MODULE
    └── mask composited          (existing engine logic)

Each call renders ONE calendar primitive. A surface with multiple
primitives (poster-on-one-page mode) calls render_calendar() N times,
once per primitive in `surface['calendars']`.

Key spec points enforced here:
    §10.4   baseYear derivation (IST + calendar type)
    §11.1   (surface_index + monthOffset) → (year, month) formula
    §11.6   ZIP filename label, but we don't write filenames here
    §11.10  Hard cap of 3 entries per cell, no "+N more" badge
    §11.12  Out-of-month cells render the date number only, no entries
    §11.13  IST-only for v1; ISO strings end-to-end
    §11.14  User-first precedence (user entries fill cap first, holidays after)
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw

from services.fonts import get_font

logger = logging.getLogger(__name__)


# ── Constants (mirror frontend/lib/calendar.ts) ─────────────────────────────

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]
WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

MAX_ENTRIES_PER_CELL = 3   # §11.10 — hard cap, no overflow badge
_IST = ZoneInfo("Asia/Kolkata")

# Theme color defaults — used when the layout's calendar.style block omits a role.
# These intentionally match the storage/calendar_styles/modern-minimalist.json.
_DEFAULT_COLORS = {
    "background":       "#FFFFFF",
    "monthText":        "#18181B",
    "weekdayText":      "#71717A",
    "weekdaySunday":    "#71717A",
    "dateNumber":       "#18181B",
    "dateNumberSunday": "#18181B",
    "outOfMonth":       "#CCCCCC",
    "grid":             "#E5E5E5",
    "pillBackground":   "#F7F7F7",
    "pillText":         "#1A1A1A",
}


# ── Public API ──────────────────────────────────────────────────────────────


def render_calendar(
    canvas: Image.Image,
    calendar_def: dict,
    *,
    year: int,
    month: int,
    style: Optional[dict] = None,
    week_start: str = "sunday",
    user_cells: Optional[dict[str, list[dict]]] = None,
    holidays: Optional[list[dict]] = None,
    canvas_w_px: Optional[int] = None,
    canvas_h_px: Optional[int] = None,
    palette: Optional[dict] = None,
    uploaded_files: Optional[dict[str, str]] = None,
) -> Image.Image:
    """
    Draw ONE calendar primitive onto `canvas` in place. Returns the same
    canvas for chaining.

    Args:
        canvas: PIL Image (RGB or RGBA). Mutated.
        calendar_def: layout's `calendars[i]` entry with x, y, width, height
            (fractional canvas coords).
        year, month: the (year, 1..12) this primitive should render. Caller
            resolved via `services.calendar_layout.resolve_surface_month`.
        style: layout-level `calendar` style block; merged with per-theme
            colour defaults. Optional.
        week_start: 'sunday' or 'monday'.
        user_cells: per-cell customer overrides, keyed by ISO date string.
            Each value is a list of dicts shaped like `CalendarCellOverride`
            (`{type, text}` / `{type, uploadId}` / `{type: 'hide'}`).
        holidays: list of holiday dicts loaded for the matching (locale, year)
            file. Each dict: `{ date, name, color? }`. Filtered to the
            displayed month here.
        canvas_w_px, canvas_h_px: total canvas dims; if omitted we read
            them from the canvas image. Used to convert fractional positions
            into pixel positions.
        palette: when style.themePreset == 'modern-genz', the active Gen-Z
            palette dict (with `bg`, `month`, `weekday`, `grid`, `date`,
            `pill`, `dotCycle`). Overrides the corresponding role colors.
    """
    if canvas_w_px is None:
        canvas_w_px = canvas.width
    if canvas_h_px is None:
        canvas_h_px = canvas.height

    style = style or {}
    colors = _resolve_colors(style, palette)
    dot_cycle = _resolve_dot_cycle(style, palette)

    # ── Resolve the rectangle in pixel space ────────────────────────────
    x_px = int(float(calendar_def.get("x", 0.0)) * canvas_w_px)
    y_px = int(float(calendar_def.get("y", 0.0)) * canvas_h_px)
    w_px = int(float(calendar_def.get("width", 0.0)) * canvas_w_px)
    h_px = int(float(calendar_def.get("height", 0.0)) * canvas_h_px)
    if w_px <= 0 or h_px <= 0:
        logger.warning("Calendar primitive has zero area; skipping render.")
        return canvas

    # Work on a transparent strip then composite — simplifies alpha blends.
    strip = Image.new("RGBA", (w_px, h_px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(strip)

    # ── Layout: header band + grid area ────────────────────────────────
    # Reserve ~10% of the calendar's height for the weekday header band.
    header_h = max(20, int(h_px * 0.10))
    grid_top = header_h
    grid_h = h_px - header_h

    grid = build_month_grid(year, month, week_start)
    rows = len(grid) // 7
    cell_w = w_px / 7.0
    cell_h = grid_h / rows

    # No month-title draw here — the existing layout overlay system is
    # how ops places month / year labels on calendar layouts. Drawing one
    # here would double-print. The calendar primitive is grid + cells only.

    # ── Weekday header row ─────────────────────────────────────────────
    labels = _weekday_labels(week_start)
    header_font_size = max(8, int(header_h * 0.45))
    header_font = get_font(header_font_size, weight=600)
    # Vertically centre the labels within the header band (band is 0..grid_top).
    header_cy = header_h // 2
    for col, label in enumerate(labels):
        is_sunday = (
            (week_start == "sunday" and col == 0)
            or (week_start == "monday" and col == 6)
        )
        color = colors["weekdaySunday"] if is_sunday else colors["weekdayText"]
        cx = int(col * cell_w + cell_w / 2)
        draw.text(
            (cx, header_cy), label,
            font=header_font, fill=_hex_to_rgba(color),
            anchor="mm",
        )

    # ── Header underline ───────────────────────────────────────────────
    draw.line(
        [(0, grid_top - 1), (w_px, grid_top - 1)],
        fill=_hex_to_rgba(colors["grid"]),
        width=1,
    )

    # ── Date cells ─────────────────────────────────────────────────────
    # Bucket holidays by ISO date for O(1) lookup. Filter to current month
    # only — out-of-month cells never render entries per §11.12.
    holiday_index: dict[str, list[dict]] = {}
    for h in holidays or []:
        d = h.get("date")
        if d:
            holiday_index.setdefault(d, []).append(h)

    date_font_size = max(8, int(min(cell_w, cell_h) * 0.22))
    date_font = get_font(date_font_size, weight=600)
    pill_font_size = max(6, int(min(cell_w, cell_h) * 0.13))
    pill_font = get_font(pill_font_size, weight=500)

    date_pad = max(2, int(min(cell_w, cell_h) * 0.05))
    pill_h = max(12, int(min(cell_w, cell_h) * 0.20))
    pill_gap = max(1, int(pill_h * 0.15))

    for idx, gc in enumerate(grid):
        col = idx % 7
        row = idx // 7
        cx0 = int(col * cell_w)
        cy0 = int(grid_top + row * cell_h)
        cx1 = int((col + 1) * cell_w)
        cy1 = int(grid_top + (row + 1) * cell_h)

        # Grid lines (right + bottom of each cell — top + left covered by neighbour).
        if col < 6:
            draw.line([(cx1, cy0), (cx1, cy1)], fill=_hex_to_rgba(colors["grid"]), width=1)
        if row < rows - 1:
            draw.line([(cx0, cy1), (cx1, cy1)], fill=_hex_to_rgba(colors["grid"]), width=1)

        is_sunday = gc["dayOfWeek"] == 0
        in_month = gc["inMonth"]

        # ── Customer override check FIRST ─────────────────────────────────
        # Image / hide overrides blank the cell entirely (§4.2.2). Checking
        # before the date-number draw avoids the leak-bug where the date
        # number rendered on top of an override.
        iso = gc["iso"]
        user_entries = (user_cells or {}).get(iso) or [] if in_month else []
        image_override = next((o for o in user_entries if o.get("type") == "image"), None)
        has_hide_override = any(o.get("type") == "hide" for o in user_entries)

        if has_hide_override:
            # type='hide' → render nothing at all in this cell (still keep
            # grid lines, which are above the per-cell branch).
            continue

        if image_override:
            # Replace the entire cell content with the uploaded image.
            # Cell padding is applied so the image doesn't crash into the
            # grid lines. Falls back to drawing nothing if the upload
            # can't be resolved (GC'd file etc. per §11.3).
            _draw_cell_image(
                strip, image_override,
                cx0=cx0, cy0=cy0, cx1=cx1, cy1=cy1,
                pad=date_pad, uploaded_files=uploaded_files or {},
            )
            continue

        # ── Normal cell: date number + (optional) entry pills ─────────────
        date_color = (
            colors["outOfMonth"] if not in_month
            else (colors["dateNumberSunday"] if is_sunday else colors["dateNumber"])
        )
        draw.text(
            (cx1 - date_pad, cy0 + date_pad), str(gc["day"]),
            font=date_font, fill=_hex_to_rgba(date_color),
            anchor="rt",
        )

        # Out-of-month cells render no entries / no holiday pills (§11.12).
        if not in_month:
            continue

        # Merge user text entries + holidays, applying §11.14 precedence
        # and §11.10 hard cap of 3.
        text_entries = [o for o in user_entries if o.get("type") == "text"]
        pills = _merge_cell_pills(
            text_entries,
            holiday_index.get(iso, []),
            dot_cycle,
            colors,
        )

        # Pills stack below the date number. Limit to 3 (already capped above).
        pill_x = cx0 + date_pad
        pill_y = cy0 + int(cell_h * 0.35)
        for pill in pills:
            _draw_pill(
                draw,
                x=pill_x, y=pill_y,
                w=int(cell_w - 2 * date_pad), h=pill_h,
                text=pill["text"],
                dot_color=pill["dotColor"],
                bg=colors["pillBackground"],
                text_color=colors["pillText"],
                font=pill_font,
            )
            pill_y += pill_h + pill_gap
            if pill_y + pill_h > cy1:
                break  # ran out of vertical room — silent drop per §11.10

    # Composite the strip onto the canvas.
    if canvas.mode != "RGBA":
        rgba = canvas.convert("RGBA")
        rgba.alpha_composite(strip, (x_px, y_px))
        flat = rgba.convert("RGB")
        canvas.paste(flat)
        flat.close()
        rgba.close()
    else:
        canvas.alpha_composite(strip, (x_px, y_px))
    strip.close()

    return canvas


# ── Month-grid construction (mirror of frontend lib/calendar.ts::buildMonthGrid) ─

def build_month_grid(year: int, month: int, week_start: str) -> list[dict]:
    """
    Build 35- or 42-cell month grid. Each cell: {iso, year, month, day,
    dayOfWeek, inMonth}. Row-major; length is always a multiple of 7.
    """
    first_of_month = date(year, month, 1)
    # Days in month — handle Dec separately so we don't roll the year.
    if month == 12:
        next_first = date(year + 1, 1, 1)
    else:
        next_first = date(year, month + 1, 1)
    days_in_month = (next_first - first_of_month).days
    first_dow = first_of_month.weekday()  # Mon=0..Sun=6
    # Convert Python weekday() to JS-style Sun=0..Sat=6 for parity with frontend.
    first_dow_js = (first_dow + 1) % 7
    week_start_idx = 1 if week_start == "monday" else 0
    leading_blanks = (first_dow_js - week_start_idx + 7) % 7
    total_cells = ((leading_blanks + days_in_month + 6) // 7) * 7

    cells = []
    for i in range(total_cells):
        day_num = i - leading_blanks + 1
        in_month = 1 <= day_num <= days_in_month
        # Use date arithmetic for out-of-month cells too.
        cell_date = first_of_month + timedelta(days=day_num - 1)
        dow_js = (cell_date.weekday() + 1) % 7
        cells.append({
            "iso": cell_date.isoformat(),
            "year": cell_date.year,
            "month": cell_date.month,
            "day": cell_date.day,
            "dayOfWeek": dow_js,
            "inMonth": in_month,
        })
    return cells


# ── Helpers ─────────────────────────────────────────────────────────────────


def _weekday_labels(week_start: str) -> list[str]:
    if week_start == "monday":
        return WEEKDAY_SHORT[1:] + [WEEKDAY_SHORT[0]]
    return list(WEEKDAY_SHORT)


def _resolve_colors(style: dict, palette: Optional[dict]) -> dict:
    """
    Merge layout style block + active Gen-Z palette + defaults.
    Result has every key in _DEFAULT_COLORS populated with a hex string.
    """
    out = dict(_DEFAULT_COLORS)
    # 1) Layout's calendar.style.colors block (if present) overrides defaults.
    style_colors = style.get("colors") if isinstance(style, dict) else None
    if isinstance(style_colors, dict):
        out.update({k: v for k, v in style_colors.items() if isinstance(v, str)})
    # 2) Active Gen-Z palette maps swatch roles → our color roles.
    if palette:
        if "bg" in palette:
            out["background"] = palette["bg"]
        if "month" in palette:
            out["monthText"] = palette["month"]
        if "weekday" in palette:
            out["weekdayText"] = palette["weekday"]
        if "grid" in palette:
            out["grid"] = palette["grid"]
        if "date" in palette:
            out["dateNumber"] = palette["date"]
            out["dateNumberSunday"] = palette["date"]
        if "pill" in palette:
            out["pillBackground"] = palette["pill"]
    return out


def _resolve_dot_cycle(style: dict, palette: Optional[dict]) -> list[str]:
    """Returns a 3-slot cycle for user-entry dot colours."""
    if palette and isinstance(palette.get("dotCycle"), list):
        return list(palette["dotCycle"])[:3]
    if isinstance(style.get("dotCycle"), list):
        return list(style["dotCycle"])[:3]
    # Sensible default — matches modern-minimalist's dotCycle.
    return ["#F59E0B", "#EC4899", "#3B82F6"]


def _merge_cell_pills(
    user_entries: list[dict],
    holiday_entries: list[dict],
    dot_cycle: list[str],
    colors: dict,
) -> list[dict]:
    """
    Apply §11.14 user-first + §11.10 hard cap.
    Returns up to 3 pills: [{text, dotColor}].
    """
    pills: list[dict] = []
    for i, ov in enumerate(user_entries):
        if len(pills) >= MAX_ENTRIES_PER_CELL:
            return pills
        text = (ov.get("text") or "").strip()
        if not text:
            continue
        dot = dot_cycle[i % max(1, len(dot_cycle))]
        pills.append({"text": text, "dotColor": dot})

    for h in holiday_entries:
        if len(pills) >= MAX_ENTRIES_PER_CELL:
            return pills
        pills.append({
            "text": h.get("name") or "",
            "dotColor": h.get("color") or colors.get("monthText") or "#000",
        })
    return pills


def _draw_cell_image(
    strip: Image.Image,
    override: dict,
    *,
    cx0: int, cy0: int, cx1: int, cy1: int,
    pad: int,
    uploaded_files: dict[str, str],
) -> None:
    """
    Draw a customer's image override into a cell (PRD §4.2.2 — replaces the
    whole cell content). The image is cover-fit to (cell - 2*pad) so it
    fills the cell without crashing into the grid lines.

    Falls back to a no-op when the upload can't be resolved (file GC'd or
    upload_id not in the map — PRD §11.3 "re-upload on reopen" path).
    """
    upload_id = override.get("uploadId")
    if not upload_id:
        return
    src_path = uploaded_files.get(str(upload_id))
    if not src_path or not os.path.exists(src_path):
        logger.info(
            "Cell image override skipped — upload %r not on disk (likely GC'd; "
            "customer should re-upload). cell=(%d,%d)..(%d,%d).",
            upload_id, cx0, cy0, cx1, cy1,
        )
        return

    target_w = max(1, (cx1 - cx0) - 2 * pad)
    target_h = max(1, (cy1 - cy0) - 2 * pad)
    paste_x = cx0 + pad
    paste_y = cy0 + pad

    try:
        with Image.open(src_path) as _src:
            img = _src.convert("RGBA")
    except (OSError, ValueError) as exc:
        logger.warning(
            "Failed to open cell image override %s: %s — skipping", src_path, exc,
        )
        return

    # Cover-fit: scale so the smaller axis matches the target, then crop centre.
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    new_w = max(1, int(src_w * scale))
    new_h = max(1, int(src_h * scale))
    img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    crop_x = (new_w - target_w) // 2
    crop_y = (new_h - target_h) // 2
    if crop_x > 0 or crop_y > 0:
        img = img.crop((crop_x, crop_y, crop_x + target_w, crop_y + target_h))

    # Apply optional opacity from the override (default 1.0).
    opacity = float(override.get("opacity") if override.get("opacity") is not None else 1.0)
    opacity = max(0.0, min(1.0, opacity))
    if opacity < 1.0:
        alpha = img.split()[-1]
        alpha = alpha.point(lambda v: int(v * opacity))
        img.putalpha(alpha)

    strip.alpha_composite(img, (paste_x, paste_y))
    img.close()


def _draw_pill(
    draw: ImageDraw.ImageDraw,
    *,
    x: int, y: int, w: int, h: int,
    text: str,
    dot_color: str,
    bg: str,
    text_color: str,
    font,
) -> None:
    """Draw a single rounded-rect pill with a dot + auto-fit text."""
    radius = max(2, h // 4)
    draw.rounded_rectangle(
        [x, y, x + w, y + h],
        radius=radius,
        fill=_hex_to_rgba(bg),
    )
    # Dot at left
    dot_d = max(3, h - 6)
    dot_x = x + 4
    dot_y = y + (h - dot_d) // 2
    draw.ellipse(
        [dot_x, dot_y, dot_x + dot_d, dot_y + dot_d],
        fill=_hex_to_rgba(dot_color),
    )
    # Text auto-fit: shrink until it fits, but only once down to a sensible floor.
    text_x = dot_x + dot_d + 4
    text_y = y + h // 2
    text_max_w = max(1, x + w - text_x - 4)
    fit_text, fit_font = _autofit_text(text, font, text_max_w)
    draw.text(
        (text_x, text_y), fit_text,
        font=fit_font, fill=_hex_to_rgba(text_color),
        anchor="lm",
    )


def _autofit_text(text: str, font, max_w: int):
    """
    Binary-search for the largest font size that fits `text` inside `max_w`.
    Returns (possibly-truncated text, font of the chosen size).

    Cheap path: if the original font already fits, return as-is. We only
    pay the binary search when shrinking is necessary.
    """
    bbox = font.getbbox(text)
    if bbox[2] - bbox[0] <= max_w:
        return text, font

    # Pull current size off the font; truetype fonts expose it as `.size`.
    cur_size = getattr(font, "size", 14)
    lo, hi = 6, cur_size
    chosen_font = font
    while lo <= hi:
        mid = (lo + hi) // 2
        f = get_font(mid, weight=500)
        b = f.getbbox(text)
        if b[2] - b[0] <= max_w:
            chosen_font = f
            lo = mid + 1
        else:
            hi = mid - 1

    # If even at floor=6 the text doesn't fit, truncate with an ellipsis.
    b = chosen_font.getbbox(text)
    if b[2] - b[0] <= max_w:
        return text, chosen_font

    truncated = text
    while truncated and chosen_font.getbbox(truncated + "…")[2] > max_w:
        truncated = truncated[:-1]
    return truncated + "…", chosen_font


def _hex_to_rgba(value: str) -> tuple:
    """Parse "#rgb" / "#rrggbb" / "#rrggbbaa" → (r, g, b, a)."""
    v = (value or "").strip().lstrip("#").lower()
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    r = g = b = 0
    a = 255
    try:
        r = int(v[0:2], 16)
        g = int(v[2:4], 16)
        b = int(v[4:6], 16)
        if len(v) == 8:
            a = int(v[6:8], 16)
    except ValueError:
        pass
    return (r, g, b, a)
