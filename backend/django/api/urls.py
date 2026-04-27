from django.urls import path
from .views import (
    GenerateLayoutView, ListLayoutsView, HealthView, GetLayoutView, SecureExportDownloadView,
    LayoutManagementView, ExternalLayoutDetailView, MaskDownloadView,
    EmbedSessionView, EmbedSessionValidateView, FontsView,
    RenderStatusView, CeleryMonitoringView, RenderJobDownloadView,
    CanvasStateView, SKULayoutView,
    ChunkedUploadInitView, ChunkedUploadChunkView, ChunkedUploadCompleteView,
    EditorRenderView,
)

urlpatterns = [
    # Existing endpoints
    path("layout/generate", GenerateLayoutView.as_view(), name="layout-generate"),
    path("layouts", ListLayoutsView.as_view(), name="layouts-list"),
    path("layouts/masks/<str:filename>", MaskDownloadView.as_view(), name="layout-mask-download"),
    path("layouts/<str:name>", GetLayoutView.as_view(), name="layout-detail"),
    path("health", HealthView.as_view(), name="health"),
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

    # External access (Secured)
    path("external/layouts/<str:name>", ExternalLayoutDetailView.as_view(), name="external-layout-detail"),

    # Editor server-side render (upload_ids → Celery job)
    path("editor/render", EditorRenderView.as_view(), name="editor-render"),

    # Embed session — create short-lived token & internal validation
    path("embed/session", EmbedSessionView.as_view(), name="embed-session-create"),
    path("embed/session/validate", EmbedSessionValidateView.as_view(), name="embed-session-validate"),

    # Fonts management
    path("fonts", FontsView.as_view(), name="fonts"),

    # SKU → layout resolution (B3 — auto-mapping for embed callers)
    path("sku-layouts/", SKULayoutView.as_view(), name="sku-layouts-list"),
    path("sku-layouts/<str:sku>/", SKULayoutView.as_view(), name="sku-layouts-detail"),
]
