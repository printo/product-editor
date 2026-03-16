from django.contrib import admin
from django.urls import path, include, re_path
from rest_framework.schemas import get_schema_view
from django.views.generic import TemplateView
from django.conf import settings
from api.views import SecureExportDownloadView

urlpatterns = [
    path("admin/django-admin/", admin.site.urls),
    path("api/", include("api.urls")),
    path("api/schema/", get_schema_view(title="Product Editor API", description="API schema", version="1.0.0"), name="openapi-schema"),
    path("api/docs", TemplateView.as_view(template_name="scalar.html"), name="api-docs"),
]
