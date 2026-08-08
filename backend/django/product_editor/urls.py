from django.contrib import admin
from django.urls import path, include
from django.views.generic import TemplateView
from drf_spectacular.views import SpectacularAPIView

urlpatterns = [
    path("admin/django-admin/", admin.site.urls),
    path("api/", include("api.urls")),
    # OpenAPI 3 schema (JSON) — consumed by Scalar UI
    path("api/schema/", SpectacularAPIView.as_view(), name="openapi-schema"),
    # Scalar API reference UI — lives outside /api/ since it's a docs page,
    # not an API endpoint. nginx must route /docs/ to the backend for this.
    path("docs/api/", TemplateView.as_view(template_name="scalar.html"), name="api-docs"),
]
