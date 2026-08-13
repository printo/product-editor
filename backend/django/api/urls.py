from django.urls import path
from .views import (
    GenerateLayoutView, ListLayoutsView, HealthView, ConfigView, GetLayoutView, SecureExportDownloadView,
    LayoutManagementView, OrderDataPurgeView, ExternalLayoutDetailView, MaskDownloadView,
    EmbedSessionView, EmbedSessionValidateView, FontsView,
    RenderStatusView, CeleryMonitoringView, RenderJobDownloadView,
    CanvasStateView, SKULayoutView, CalendarStylesView, HolidaysView,
    ChunkedUploadInitView, ChunkedUploadChunkView, ChunkedUploadCompleteView,
    OrientationDetectView, HeicConvertView,
    EditorRenderView, EditorInitView,
)

urlpatterns = [
    # Existing endpoints
    path("layout/generate", GenerateLayoutView.as_view(), name="layout-generate"),
    path("layouts", ListLayoutsView.as_view(), name="layouts-list"),
    path("layouts/masks/<str:filename>", MaskDownloadView.as_view(), name="layout-mask-download"),
    path("layouts/<str:name>", GetLayoutView.as_view(), name="layout-detail"),
    path("health", HealthView.as_view(), name="health"),
    path("config", ConfigView.as_view(), name="config"),
    path("orientation/detect", OrientationDetectView.as_view(), name="orientation-detect"),
    path("heic/convert", HeicConvertView.as_view(), name="heic-convert"),
    path("exports/<path:file_path>", SecureExportDownloadView.as_view(), name="export-download"),

    # Async rendering endpoints
    path("render-status/<uuid:job_id>/", RenderStatusView.as_view(), name="render-status"),
    path("jobs/<uuid:job_id>/download/", RenderJobDownloadView.as_view(), name="job-download"),
    path("celery/monitor/", CeleryMonitoringView.as_view(), name="celery-monitor"),

    # Canvas state persistence (P0 — survives page refresh)
    path("canvas-state/<str:order_id>/", CanvasStateView.as_view(), name="canvas-state"),

    # Chunked / resumable upload
    path("upload/init", ChunkedUploadInitView.as_view(), name="upload-init"),
    path("upload/<str:upload_id>/chunk", ChunkedUploadChunkView.as_view(), name="upload-chunk"),
    path("upload/<str:upload_id>/complete", ChunkedUploadCompleteView.as_view(), name="upload-complete"),

    # Layout management (Ops Team only)
    path("ops/layouts", LayoutManagementView.as_view(), name="ops-layouts-list"),
    path("ops/layouts/<str:name>", LayoutManagementView.as_view(), name="ops-layouts-detail"),

    # DPDP right-to-erasure — immediate purge of one order (Ops Team only)
    path("ops/orders/<str:order_id>/purge", OrderDataPurgeView.as_view(), name="ops-order-purge"),

    # External access (Secured)
    path("external/layouts/<str:name>", ExternalLayoutDetailView.as_view(), name="external-layout-detail"),

    # Editor server-side render (upload_ids → Celery job)
    path("editor/render", EditorRenderView.as_view(), name="editor-render"),

    # Editor mount payload — batched layout + fonts (C6, saves 1 RTT on cold start)
    path("editor/init", EditorInitView.as_view(), name="editor-init"),

    # Embed session — create short-lived token & internal validation
    path("embed/session", EmbedSessionView.as_view(), name="embed-session-create"),
    path("embed/session/validate", EmbedSessionValidateView.as_view(), name="embed-session-validate"),

    # Fonts management
    path("fonts", FontsView.as_view(), name="fonts"),

    # SKU → layout resolution (B3 — auto-mapping for embed callers)
    path("sku-layouts/", SKULayoutView.as_view(), name="sku-layouts-list"),
    path("sku-layouts/<str:sku>/", SKULayoutView.as_view(), name="sku-layouts-detail"),

    # Calendar style presets (PRD §10.3 + §6.3 + Phase 3)
    # Public GETs — customer preview page fetches these through the embed proxy.
    path("calendar-styles/", CalendarStylesView.as_view(), name="calendar-styles-list"),
    path("calendar-styles/<str:name>", CalendarStylesView.as_view(), name="calendar-styles-detail"),
    # Ops mutation path — PUT /api/ops/calendar-styles/<name> (audit fix #5).
    # Mirrors the /api/ops/layouts/<name> and /api/ops/holidays/... convention
    # so the embed proxy allowlist (which allows "calendar-styles" for GETs)
    # never forwards a mutation without an explicit ops-path allow entry.
    path("ops/calendar-styles/<str:name>", CalendarStylesView.as_view(), name="ops-calendar-styles-detail"),

    # Holiday data (PRD §11.9 / §11.11 / Phase 3)
    path("holidays/<str:locale>/<str:year>", HolidaysView.as_view(), name="holidays-detail"),
    path("ops/holidays/<str:locale>/<str:year>", HolidaysView.as_view(), name="holidays-ops-detail"),
]
