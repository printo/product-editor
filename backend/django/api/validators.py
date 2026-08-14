"""
File validators for upload validation.
Validates file size, type, and content for JPEG, PNG, WebP, TIFF formats.
"""
import mimetypes
import logging
from PIL import Image
from django.conf import settings
from django.core.exceptions import ValidationError

logger = logging.getLogger(__name__)

# Configuration — single source via settings.MAX_UPLOAD_FILE_SIZE_MB (env-driven)
MAX_FILE_SIZE_MB = settings.MAX_UPLOAD_FILE_SIZE_MB
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

# Comprehensive format support
ALLOWED_IMAGE_TYPES = {
    'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
    'image/png': ['png'],
    'image/webp': ['webp'],
    'image/tiff': ['tiff', 'tif'],
    'image/gif': ['gif'],
}

MIN_IMAGE_DIMENSION = 50
# Env-driven (settings.MAX_IMAGE_DIMENSION_PX, default 16384). The engine caps
# total pixels at Image.MAX_IMAGE_PIXELS and smart-downscales sources, so this
# is a decompression-bomb guard, not a print-quality limit.
MAX_IMAGE_DIMENSION = settings.MAX_IMAGE_DIMENSION_PX


def validate_image_file(file_obj, max_size_mb=MAX_FILE_SIZE_MB):
    """
    Validate an image file for upload.
    """
    if not file_obj:
        raise ValidationError("No file provided")
    
    # Check file size
    if file_obj.size > (max_size_mb * 1024 * 1024):
        raise ValidationError(
            f"File size exceeds maximum of {max_size_mb}MB. "
            f"Your file is {file_obj.size / (1024*1024):.1f}MB"
        )
    
    # Check file extension
    file_ext = file_obj.name.rsplit('.', 1)[-1].lower() if '.' in file_obj.name else ''
    
    all_allowed_exts = [ext for exts in ALLOWED_IMAGE_TYPES.values() for ext in exts]
    if file_ext not in all_allowed_exts:
        allowed = ', '.join(all_allowed_exts)
        raise ValidationError(
            f"Invalid file type '.{file_ext}'. Allowed types: {allowed}"
        )
    
    # Validate image integrity and dimensions using PIL
    try:
        file_obj.seek(0)
        img = Image.open(file_obj)
        img.verify()
        
        file_obj.seek(0)
        img = Image.open(file_obj)
        width, height = img.size

        if width < MIN_IMAGE_DIMENSION or height < MIN_IMAGE_DIMENSION:
            raise ValidationError(
                f"Image dimensions too small. Minimum {MIN_IMAGE_DIMENSION}x{MIN_IMAGE_DIMENSION}px. "
                f"Your image is {width}x{height}px"
            )

        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise ValidationError(
                f"Image dimensions too large. Maximum {MAX_IMAGE_DIMENSION}x{MAX_IMAGE_DIMENSION}px. "
                f"Your image is {width}x{height}px"
            )

        # Reset position so callers can read the raw bytes after validation.
        file_obj.seek(0)

    except ValidationError:
        # Re-raise dimension/format errors unchanged so the user-facing
        # message is not double-wrapped as "Invalid image file: [...]".
        raise
    except Exception as e:
        logger.error(f"Image validation error: {e}")
        raise ValidationError(f"Invalid image file: {str(e)}")


def validate_image_files(files, max_size_mb=MAX_FILE_SIZE_MB):
    """Validate a list of image files."""
    for f in files:
        validate_image_file(f, max_size_mb)


# ─── Calendar product layout validator (CALENDAR_FEATURE_PRD §11.1, §11.15) ──

# Fields that are NEVER permitted inside surfaceOverrides[*]. Per PRD §10.2.1
# they're either customer-controllable on the preview page (so per-surface
# override would create merge ambiguity) or physical SKU dimensions that
# can't differ across months.
_BANNED_SURFACE_OVERRIDE_FIELDS = frozenset({
    'canvas',
    'monthRange',
    'productType',
    'themePreset',
    'calendarType',
    'weekStart',
})


def _check_overlays(overlay_list, where: str) -> None:
    """
    Overlays (template + per-surface/per-page) use PERCENT coords (0-100),
    not the 0..1 fractions frames/calendars use. An ops-authored overlay
    written in fractions would silently render collapsed into the top-left
    corner of every print — the exact silent-wrong-print class this
    codebase guards against. Shared by the calendar and book validators.
    """
    if not isinstance(overlay_list, list):
        return
    for i, o in enumerate(overlay_list):
        if not isinstance(o, dict):
            continue
        fields = {}
        for k in ('x', 'y', 'width', 'height'):
            if o.get(k) is None:
                continue
            try:
                fields[k] = float(o[k])
            except (ValueError, TypeError):
                raise ValidationError(
                    f"{where}[{i}].{k} = {o[k]!r} is not a number — overlay "
                    f"coordinates must be numeric PERCENT of the canvas (0-100)."
                )
        for k, v in fields.items():
            if not (0 <= v <= 100):
                raise ValidationError(
                    f"{where}[{i}].{k} = {v} is out of range — overlay "
                    f"coordinates are PERCENT of the canvas (0-100)."
                )
        sized = {k: v for k, v in fields.items() if k in ('width', 'height')}
        if sized and all(0 < v <= 1 for v in fields.values() if v):
            raise ValidationError(
                f"{where}[{i}] looks like it uses 0..1 fractions "
                f"({fields}) — overlay coordinates are PERCENT of the "
                f"canvas (0-100), unlike frames/calendars."
            )


def validate_calendar_layout(layout_data: dict) -> None:
    """
    Validate the calendar-specific fields on a layout JSON.

    Invoked from LayoutManagementView.post when productType == 'calendar'.
    Raises ValidationError with a specific message on first failure.
    Returns None on success.

    Enforces:
      §11.1  — monthRange.count × calendars.length === 12
      §11.1  — each calendar's monthOffset (if set) is in 0..11; unique within
               a surface; in [0, monthRange.count × calendars.length)
      §11.15 — surfaceOverrides[*] contains no banned fields
      §10.3  — themePreset / calendarType / weekStart take only allowed values
      §4.2.1 — calendar position fields x, y, width, height in [0, 1]
    """
    if not isinstance(layout_data, dict):
        raise ValidationError("layout_data must be a dict")

    # ── monthRange ───────────────────────────────────────────────────────
    month_range = layout_data.get('monthRange') or {}
    if not isinstance(month_range, dict):
        raise ValidationError("monthRange must be an object")
    count = month_range.get('count')
    if not isinstance(count, int) or count <= 0:
        raise ValidationError("monthRange.count must be a positive integer")
    default_year = month_range.get('defaultYear')
    if not (default_year == 'current' or (isinstance(default_year, int) and 2000 <= default_year <= 2100)):
        raise ValidationError("monthRange.defaultYear must be 'current' or an integer year 2000–2100")

    # ── calendars[] ──────────────────────────────────────────────────────
    calendars = layout_data.get('calendars')
    if not isinstance(calendars, list) or len(calendars) == 0:
        raise ValidationError("calendars must be a non-empty array")

    # PRD §11.1 hard constraint — v1 ships only 12-month layouts.
    if count * len(calendars) != 12:
        raise ValidationError(
            f"Calendar layout must show exactly 12 months total. "
            f"Got monthRange.count={count} × calendars.length={len(calendars)} = "
            f"{count * len(calendars)}."
        )

    offsets_seen: set[int] = set()
    for idx, cal in enumerate(calendars):
        if not isinstance(cal, dict):
            raise ValidationError(f"calendars[{idx}] must be an object")
        for field in ('x', 'y', 'width', 'height'):
            v = cal.get(field)
            if not isinstance(v, (int, float)) or not (0.0 <= float(v) <= 1.0):
                raise ValidationError(
                    f"calendars[{idx}].{field} must be a number in [0, 1] (got {v!r})"
                )
        if cal.get('width', 0) <= 0 or cal.get('height', 0) <= 0:
            raise ValidationError(f"calendars[{idx}] must have positive width and height")

        # Bounds check: the primitive must fit inside the canvas. Float
        # arithmetic with percentage coords (e.g. 0.05 + 0.95) sometimes
        # lands at 1.0000000002, so we allow a 1e-6 epsilon — anything
        # genuinely past the edge (e.g. x=0.8, width=0.5 → 1.3) still trips.
        cx = float(cal.get('x') or 0)
        cy = float(cal.get('y') or 0)
        cw = float(cal.get('width') or 0)
        ch = float(cal.get('height') or 0)
        _EPS = 1e-6
        if cx + cw > 1.0 + _EPS:
            raise ValidationError(
                f"calendars[{idx}] extends past the right canvas edge: "
                f"x ({cx}) + width ({cw}) = {cx + cw:.4f}, must be ≤ 1.0"
            )
        if cy + ch > 1.0 + _EPS:
            raise ValidationError(
                f"calendars[{idx}] extends past the bottom canvas edge: "
                f"y ({cy}) + height ({ch}) = {cy + ch:.4f}, must be ≤ 1.0"
            )

        # monthOffset is optional in multi-surface mode (defaults to 0,
        # meaning "surface index drives the month"). In multi-calendar
        # single-page mode every entry needs a unique offset.
        offset = cal.get('monthOffset')
        if offset is None:
            offset = 0
        if not isinstance(offset, int) or not (0 <= offset < count * len(calendars)):
            raise ValidationError(
                f"calendars[{idx}].monthOffset must be an integer in "
                f"[0, {count * len(calendars)}) — got {offset!r}"
            )
        if offset in offsets_seen:
            raise ValidationError(
                f"calendars[{idx}].monthOffset={offset} duplicates an earlier entry. "
                "Each calendar primitive on the same surface must have a unique offset."
            )
        offsets_seen.add(offset)

    # ── calendar style block (ops defaults) ──────────────────────────────
    # Required for calendar layouts so ops can't accidentally publish a
    # layout without setting a theme + calendar type. Defaults are sensible
    # at the renderer level but the explicit block is the source of truth
    # for downstream UIs (customer preview, ops authoring).
    style = layout_data.get('calendar')
    if not isinstance(style, dict):
        raise ValidationError(
            "calendar layouts must include a 'calendar' object with at least "
            "themePreset + calendarType + weekStart fields"
        )
    for required in ('themePreset', 'calendarType', 'weekStart'):
        if style.get(required) is None:
            raise ValidationError(
                f"calendar.{required} is required on a productType='calendar' layout"
            )
    if style:
        theme = style.get('themePreset')
        if theme is not None and theme not in {'modern-minimalist', 'modern-genz', 'weekday-highlight'}:
            raise ValidationError(
                f"calendar.themePreset must be one of "
                f"'modern-minimalist' / 'modern-genz' / 'weekday-highlight' "
                f"(got {theme!r})"
            )
        ctype = style.get('calendarType')
        if ctype is not None and ctype not in {'english', 'financial'}:
            raise ValidationError(
                f"calendar.calendarType must be 'english' or 'financial' (got {ctype!r})"
            )
        wstart = style.get('weekStart')
        if wstart is not None and wstart not in {'sunday', 'monday'}:
            raise ValidationError(
                f"calendar.weekStart must be 'sunday' or 'monday' (got {wstart!r})"
            )
        max_entries = style.get('maxEntriesPerCell')
        if max_entries is not None and (not isinstance(max_entries, int) or not (1 <= max_entries <= 10)):
            raise ValidationError("calendar.maxEntriesPerCell must be an integer 1..10")

        # Optional month-title block (Phase 2) — validate at save time so a
        # bad value fails the ops PUT with a message instead of crashing
        # every render of the layout.
        month_title = style.get('monthTitle')
        if month_title is not None:
            if not isinstance(month_title, dict):
                raise ValidationError("calendar.monthTitle must be an object")
            for k, lo, hi in (('x', 0, 100), ('y', 0, 100), ('fontSize', 1, 500)):
                v = month_title.get(k)
                if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not (lo <= v <= hi)):
                    raise ValidationError(
                        f"calendar.monthTitle.{k} must be a number in [{lo}, {hi}]"
                    )
            fw = month_title.get('fontWeight')
            if fw is not None and (isinstance(fw, bool) or not isinstance(fw, int) or not (100 <= fw <= 900)):
                raise ValidationError("calendar.monthTitle.fontWeight must be an integer 100..900")
            ta = month_title.get('textAlign')
            if ta is not None and ta not in {'left', 'center', 'right'}:
                raise ValidationError("calendar.monthTitle.textAlign must be 'left' / 'center' / 'right'")
            col = month_title.get('color')
            if col is not None and not isinstance(col, str):
                raise ValidationError("calendar.monthTitle.color must be a string")

    # ── surfaceOverrides (sparse, per-month) ─────────────────────────────
    overrides = layout_data.get('surfaceOverrides')
    if overrides is not None:
        if not isinstance(overrides, dict):
            raise ValidationError("surfaceOverrides must be an object keyed by surface key")
        for surface_key, ovr in overrides.items():
            if not isinstance(ovr, dict):
                raise ValidationError(
                    f"surfaceOverrides['{surface_key}'] must be an object"
                )
            banned_present = _BANNED_SURFACE_OVERRIDE_FIELDS.intersection(ovr.keys())
            if banned_present:
                # Surface the first banned field by name so ops can fix it.
                bad = sorted(banned_present)[0]
                raise ValidationError(
                    f"surfaceOverrides['{surface_key}'].{bad} is not allowed. "
                    f"Per-surface override is forbidden for: "
                    f"{', '.join(sorted(_BANNED_SURFACE_OVERRIDE_FIELDS))}. "
                    "These fields are either customer-controllable on the preview "
                    "page or physical SKU dimensions and must stay layout-global."
                )
            # Bounds check on override frames + calendars (P6.2 review L1).
            # An invalid override would render outside the canvas, so reject
            # at save time rather than at render time.
            ovr_frames = ovr.get('frames')
            if isinstance(ovr_frames, list):
                # Frame COUNT is pinned to the template: the render payload
                # is sliced per month with a uniform template stride, so an
                # override that adds/removes frames would desync photo
                # slicing and emit spurious extra pages into the ZIP.
                template_frame_count = len(layout_data.get('frames') or [])
                if len(ovr_frames) != template_frame_count:
                    raise ValidationError(
                        f"surfaceOverrides['{surface_key}'].frames must contain exactly "
                        f"{template_frame_count} frame(s) to match the template — per-month "
                        f"overrides may reposition frames but not change their count."
                    )
                for i, f in enumerate(ovr_frames):
                    if not isinstance(f, dict):
                        continue
                    fx = float(f.get('x') or 0)
                    fy = float(f.get('y') or 0)
                    fw = float(f.get('width') or 0)
                    fh = float(f.get('height') or 0)
                    if fx < 0 or fy < 0 or fw <= 0 or fh <= 0:
                        raise ValidationError(
                            f"surfaceOverrides['{surface_key}'].frames[{i}] "
                            f"must have positive dimensions and non-negative origin."
                        )
                    if fx + fw > 1.0 + 1e-6:
                        raise ValidationError(
                            f"surfaceOverrides['{surface_key}'].frames[{i}] "
                            f"extends past the right canvas edge: "
                            f"x ({fx}) + width ({fw}) = {fx + fw:.4f}, must be ≤ 1.0"
                        )
                    if fy + fh > 1.0 + 1e-6:
                        raise ValidationError(
                            f"surfaceOverrides['{surface_key}'].frames[{i}] "
                            f"extends past the bottom canvas edge: "
                            f"y ({fy}) + height ({fh}) = {fy + fh:.4f}, must be ≤ 1.0"
                        )
            ovr_calendars = ovr.get('calendars')
            if isinstance(ovr_calendars, list):
                for i, c in enumerate(ovr_calendars):
                    if not isinstance(c, dict):
                        continue
                    cx = float(c.get('x') or 0)
                    cy = float(c.get('y') or 0)
                    cw = float(c.get('width') or 0)
                    ch = float(c.get('height') or 0)
                    if cx < 0 or cy < 0 or cw <= 0 or ch <= 0:
                        raise ValidationError(
                            f"surfaceOverrides['{surface_key}'].calendars[{i}] "
                            f"must have positive dimensions and non-negative origin."
                        )
                    if cx + cw > 1.0 + 1e-6:
                        raise ValidationError(
                            f"surfaceOverrides['{surface_key}'].calendars[{i}] "
                            f"extends past the right canvas edge: "
                            f"x ({cx}) + width ({cw}) = {cx + cw:.4f}, must be ≤ 1.0"
                        )
                    if cy + ch > 1.0 + 1e-6:
                        raise ValidationError(
                            f"surfaceOverrides['{surface_key}'].calendars[{i}] "
                            f"extends past the bottom canvas edge: "
                            f"y ({cy}) + height ({ch}) = {cy + ch:.4f}, must be ≤ 1.0"
                        )

    # ── Overlays (template + per-month) use PERCENT coords, not fractions ──
    # See the module-level _check_overlays() docstring above.
    _check_overlays(layout_data.get('overlays'), "overlays")
    if isinstance(overrides, dict):
        for surface_key, ovr in overrides.items():
            if isinstance(ovr, dict):
                _check_overlays(
                    ovr.get('overlays'), f"surfaceOverrides['{surface_key}'].overlays"
                )


# ─── Book product layout validator (BOOK_LAYOUT_PRD.md §5, D1/D2/D2a/D5/D7) ──

_BOOK_ROLE_TEMPLATE_KEYS = ('cover', 'innerPage', 'backCover')


def _validate_canvas_block(canvas, where: str) -> None:
    if not isinstance(canvas, dict):
        raise ValidationError(f"{where}.canvas must be an object")
    for dim in ('width', 'height'):
        v = canvas.get(dim)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
            raise ValidationError(f"{where}.canvas.{dim} must be a positive number")


def validate_book_layout(layout_data: dict) -> None:
    """
    Validate the book-specific fields on a layout JSON.

    Invoked from LayoutManagementView.post when productType == 'book'.
    Raises ValidationError with a specific message on first failure.
    Returns None on success.

    Enforces (BOOK_LAYOUT_PRD.md):
      D2   book.pageCount is a well-formed {min, max, step, default} block,
           min/max on the step grid, step ≥ 1.
      D2a  Exactly the cover + innerPage authored templates are required;
           backCover may be omitted (falls back to the cover's canvas at
           materialize time) but if present must be well-formed.
      D7   Every present role template carries its OWN canvas with a
           positive width/height — the whole reason a role can differ in
           size from the others.
      D5   book.gutterMm, when present, is a non-negative number.
      —    pageOverrides (the escape hatch) keys are page-index strings
           whose int value is ≥ 1; frame/overlay shape inside an override
           follows the same bounds checks as the calendar's surfaceOverrides.
    """
    if not isinstance(layout_data, dict):
        raise ValidationError("layout_data must be a dict")

    book = layout_data.get('book')
    if not isinstance(book, dict):
        raise ValidationError(
            "book layouts must include a 'book' object with pageCount, cover "
            "and innerPage templates"
        )

    # ── pageCount (D2) ──────────────────────────────────────────────────
    page_count = book.get('pageCount')
    if not isinstance(page_count, dict):
        raise ValidationError("book.pageCount must be an object with min/max/step/default")
    lo = page_count.get('min')
    hi = page_count.get('max')
    step = page_count.get('step')
    default = page_count.get('default')
    for name, v in (('min', lo), ('max', hi), ('step', step)):
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise ValidationError(f"book.pageCount.{name} must be a positive integer")
    if hi < lo:
        raise ValidationError("book.pageCount.max must be ≥ book.pageCount.min")
    if (hi - lo) % step:
        raise ValidationError(
            f"book.pageCount.max ({hi}) must be reachable from min ({lo}) in "
            f"steps of {step} — books step in multiples of the signature size"
        )
    if default is not None:
        if not isinstance(default, int) or isinstance(default, bool):
            raise ValidationError("book.pageCount.default must be an integer")
        if not (lo <= default <= hi) or (default - lo) % step:
            raise ValidationError(
                f"book.pageCount.default ({default}) must be within "
                f"[{lo}, {hi}] and on the step-{step} grid"
            )

    # ── Role templates (D2a / D7) ───────────────────────────────────────
    for key in ('cover', 'innerPage'):
        template = book.get(key)
        if not isinstance(template, dict):
            raise ValidationError(f"book.{key} is required and must be an object")
        _validate_canvas_block(template.get('canvas'), f"book.{key}")
        frames = template.get('frames')
        if frames is not None and not isinstance(frames, list):
            raise ValidationError(f"book.{key}.frames must be an array")

    back_cover = book.get('backCover')
    if back_cover is not None:
        if not isinstance(back_cover, dict):
            raise ValidationError("book.backCover must be an object")
        # backCover may omit `canvas` entirely to inherit the front cover's
        # (materialize_pages falls back), but if present it must be valid —
        # a half-specified canvas (e.g. width only) is worse than none.
        if 'canvas' in back_cover:
            _validate_canvas_block(back_cover.get('canvas'), "book.backCover")
        frames = back_cover.get('frames')
        if frames is not None and not isinstance(frames, list):
            raise ValidationError("book.backCover.frames must be an array")

    # ── gutterMm / bleedMm / paperThicknessMm (D5) ──────────────────────
    for field in ('gutterMm', 'bleedMm', 'paperThicknessMm', 'coverThicknessMm'):
        v = book.get(field)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0):
            raise ValidationError(f"book.{field} must be a non-negative number")

    # ── pageOverrides (ops escape hatch) ────────────────────────────────
    overrides = layout_data.get('pageOverrides')
    if overrides is not None:
        if not isinstance(overrides, dict):
            raise ValidationError("pageOverrides must be an object keyed by page index")
        template_frame_count = len(book.get('innerPage', {}).get('frames') or [])
        for page_key, ovr in overrides.items():
            try:
                idx = int(page_key)
            except (TypeError, ValueError):
                raise ValidationError(f"pageOverrides key '{page_key}' must be a page index (integer string)")
            if idx < 1:
                raise ValidationError(f"pageOverrides key '{page_key}' must be ≥ 1 (page indices are 1-based)")
            if not isinstance(ovr, dict):
                raise ValidationError(f"pageOverrides['{page_key}'] must be an object")
            ovr_frames = ovr.get('frames')
            if isinstance(ovr_frames, list):
                if template_frame_count and len(ovr_frames) != template_frame_count:
                    raise ValidationError(
                        f"pageOverrides['{page_key}'].frames must contain exactly "
                        f"{template_frame_count} frame(s) to match book.innerPage — "
                        "per-page overrides may reposition frames but not change their count."
                    )
                for i, f in enumerate(ovr_frames):
                    if not isinstance(f, dict):
                        continue
                    fx = float(f.get('x') or 0)
                    fy = float(f.get('y') or 0)
                    fw = float(f.get('width') or 0)
                    fh = float(f.get('height') or 0)
                    if fx < 0 or fy < 0 or fw <= 0 or fh <= 0:
                        raise ValidationError(
                            f"pageOverrides['{page_key}'].frames[{i}] must have "
                            "positive dimensions and non-negative origin."
                        )
                    if fx + fw > 1.0 + 1e-6 or fy + fh > 1.0 + 1e-6:
                        raise ValidationError(
                            f"pageOverrides['{page_key}'].frames[{i}] extends past "
                            "the canvas edge."
                        )
            _check_overlays(ovr.get('overlays'), f"pageOverrides['{page_key}'].overlays")

    _check_overlays(book.get('innerPage', {}).get('overlays'), "book.innerPage.overlays")
    _check_overlays(book.get('cover', {}).get('overlays'), "book.cover.overlays")
    if isinstance(back_cover, dict):
        _check_overlays(back_cover.get('overlays'), "book.backCover.overlays")
