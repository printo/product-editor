from django.urls import path
from .views import (
    GenerateLayoutView, ListLayoutsView, HealthView, GetLayoutView, SecureExportDownloadView,
    LayoutManagementView, ExternalLayoutDetailView, MaskDownloadView,
    EmbedSessionView, EmbedSessionValidateView, FontsView,
    RenderStatusView, CeleryMonitoringView,
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
    path("celery/monitor/", CeleryMonitoringView.as_view(), name="celery-monitor"),
    
    # Layout management (Ops Team only)
    path("ops/layouts", LayoutManagementView.as_view(), name="ops-layouts-list"),
    path("ops/layouts/<str:name>", LayoutManagementView.as_view(), name="ops-layouts-detail"),
    
    # External access (Secured)
    path("external/layouts/<str:name>", ExternalLayoutDetailView.as_view(), name="external-layout-detail"),

    # Embed session — create short-lived token & internal validation
    path("embed/session", EmbedSessionView.as_view(), name="embed-session-create"),
    path("embed/session/validate", EmbedSessionValidateView.as_view(), name="embed-session-validate"),
    
    # Fonts management
    path("fonts", FontsView.as_view(), name="fonts"),
]
