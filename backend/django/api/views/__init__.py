"""API views, split by area (see docs/LARGE_FILE_SPLIT_PLAN.md).

Every view is re-exported here, so `from api.views import X` (urls.py, tests,
management commands) keeps working. Patch a name where the view looks it up:
`api.views.calendar_assets._write_holidays`, not `api.views._write_holidays`.
"""
# Imported for its side effect: engine.py sets Image.MAX_IMAGE_PIXELS to 500 MP
# at import time, and this is the only place the web process imports it.
# Without it, upload validation falls back to Pillow's ~179 MP bomb limit.
from layout_engine.engine import LayoutEngine  # noqa: F401

from .system import HealthView, ConfigView, CSPReportView  # noqa: F401
from .ops import (  # noqa: F401
    CeleryMonitoringView,
    OrderDataPurgeView,
    _jobs_per_day_status,
    _disk_status,
)
from .media import OrientationDetectView, HeicConvertView  # noqa: F401
from .layouts import (  # noqa: F401
    ListLayoutsView,
    GetLayoutView,
    ExternalLayoutDetailView,
    MaskDownloadView,
    _read_layout_def,
    _summarize_layout,
)
from .layout_admin import (  # noqa: F401
    LayoutManagementView,
    invalidate_layout_caches,
    LAYOUT_ID_NOTE,
)
from .calendar_assets import (  # noqa: F401
    FontsView,
    CalendarStylesView,
    HolidaysView,
    DEFAULT_FONTS,
    OPS_WRITE_AUTH,
    _FONTS_CACHE_KEY,
    _STORAGE_CACHE_TTL,
    _ASSET_UNAVAILABLE_503,
    _OPS_GATE_RESPONSES,
    _CALENDAR_STYLES_CACHE_KEY,
    _CALENDAR_STYLE_CACHE_KEY,
    _HOLIDAYS_CACHE_KEY,
    _read_fonts,
    _write_fonts,
    _asset_unavailable_response,
    _list_calendar_styles,
    _read_calendar_style,
    _write_calendar_style,
    _safe_locale_year,
    _read_holidays,
    _write_holidays,
)
from .render import GenerateLayoutView, EditorRenderView, RenderStatusView  # noqa: F401
from .downloads import RenderJobDownloadView, SecureExportDownloadView  # noqa: F401
from .embed import (  # noqa: F401
    EmbedSessionView,
    EmbedSessionValidateView,
    EditorInitView,
    CanvasStateView,
)
from .uploads import (  # noqa: F401
    ChunkedUploadInitView,
    ChunkedUploadChunkView,
    ChunkedUploadCompleteView,
    _AnyContentTypeParser,
    UUID_GUARD,
)
