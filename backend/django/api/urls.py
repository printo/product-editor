from django.urls import path
from .views import (
    GenerateLayoutView, ListLayoutsView, HealthView, GetLayoutView, SecureExportDownloadView,
    AIStatusView, BackgroundRemovalView, ProductDetectionView, DesignPlacementView, BlendPreviewView,
    CompleteAIProcessingView, AIJobStatusView, ManualOverrideOptionsView, BackgroundJobStatusView,
    CircuitBreakerResetView, LayoutManagementView, ExternalLayoutDetailView, MaskDownloadView,
    EmbedSessionView, EmbedSessionValidateView,
)

urlpatterns = [
    # Existing endpoints
    path("layout/generate", GenerateLayoutView.as_view(), name="layout-generate"),
    path("layouts", ListLayoutsView.as_view(), name="layouts-list"),
    path("layouts/masks/<str:filename>", MaskDownloadView.as_view(), name="layout-mask-download"),
    path("layouts/<str:name>", GetLayoutView.as_view(), name="layout-detail"),
    path("health", HealthView.as_view(), name="health"),
    path("exports/<path:file_path>", SecureExportDownloadView.as_view(), name="export-download"),
    
    # Layout management (Ops Team only)
    path("ops/layouts", LayoutManagementView.as_view(), name="ops-layouts-list"),
    path("ops/layouts/<str:name>", LayoutManagementView.as_view(), name="ops-layouts-detail"),
    
    # External access (Secured)
    path("external/layouts/<str:name>", ExternalLayoutDetailView.as_view(), name="external-layout-detail"),

    # Embed session — create short-lived token & internal validation
    path("embed/session", EmbedSessionView.as_view(), name="embed-session-create"),
    path("embed/session/validate", EmbedSessionValidateView.as_view(), name="embed-session-validate"),
    
    # AI Processing endpoints
    path("ai/status", AIStatusView.as_view(), name="ai-status"),
    path("ai/remove-background", BackgroundRemovalView.as_view(), name="ai-background-removal"),
    path("ai/detect-products", ProductDetectionView.as_view(), name="ai-product-detection"),
    path("ai/place-design", DesignPlacementView.as_view(), name="ai-design-placement"),
    path("ai/blend-preview", BlendPreviewView.as_view(), name="ai-blend-preview"),
    path("ai/process-complete", CompleteAIProcessingView.as_view(), name="ai-complete-processing"),
    path("ai/jobs", AIJobStatusView.as_view(), name="ai-jobs-list"),
    path("ai/jobs/<uuid:job_id>", AIJobStatusView.as_view(), name="ai-job-detail"),
    
    # Failure handling and manual override endpoints
    path("ai/manual-override-options", ManualOverrideOptionsView.as_view(), name="ai-manual-override-options"),
    path("ai/manual-override-options/<str:service_name>", ManualOverrideOptionsView.as_view(), name="ai-manual-override-options-service"),
    path("ai/background-jobs/<str:job_id>/status", BackgroundJobStatusView.as_view(), name="ai-background-job-status"),
    path("ai/circuit-breaker/<str:service_name>/reset", CircuitBreakerResetView.as_view(), name="ai-circuit-breaker-reset"),
]
