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
MAX_IMAGE_DIMENSION = 8192


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
