from django.contrib import admin
from django.urls import path, include
from django.views.generic import TemplateView
from django.conf import settings
from drf_spectacular.views import SpectacularAPIView
from api.views import SecureExportDownloadView

urlpatterns = [
    path("admin/django-admin/", admin.site.urls),
    path("api/", include("api.urls")),
    # OpenAPI 3 schema (JSON) — consumed by Scalar UI
    path("api/schema/", SpectacularAPIView.as_view(), name="openapi-schema"),
    # Scalar API reference UI
    path("api/docs", TemplateView.as_view(template_name="scalar.html"), name="api-docs"),
]
