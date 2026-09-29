from django.contrib import admin
from django.core.exceptions import PermissionDenied
from django.shortcuts import get_object_or_404, redirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods

from .models import APIKey, APIRequest, UploadedFile, ExportedResult


@admin.register(APIKey)
class APIKeyAdmin(admin.ModelAdmin):
    change_form_template = 'admin/api/apikey/change_form.html'
    list_display = ('name', 'key_preview', 'is_active', 'last_used_at', 'created_at')
    list_filter = ('is_active', 'created_at', 'last_used_at')
    search_fields = ('name', 'key')
    # The full key is shown exactly once — right after it is created or
    # regenerated — and only its last 4 characters everywhere after that.
    readonly_fields = ('key_preview', 'created_at', 'updated_at')
    fieldsets = (
        ('Key Information', {
            'fields': ('name', 'key_preview', 'description', 'user')
        }),
        ('Permissions', {
            'fields': (
                'can_generate_layouts',
                'can_list_layouts',
                'can_access_exports',
                'max_requests_per_day'
            )
        }),
        ('Status', {
            'fields': ('is_active', 'last_used_at', 'created_at', 'updated_at')
        }),
    )
    
    def key_preview(self, obj):
        """Show only the trailing 4 characters — avoids leaking significant
        key material in screenshots, browser history, or audit logs."""
        return f"...{obj.key[-4:]}" if obj.key else "N/A"
    key_preview.short_description = "API Key"
    
    def has_add_permission(self, request):
        """Only superusers can add keys."""
        return request.user.is_superuser
    
    def has_delete_permission(self, request, obj=None):
        """Only superusers can delete keys."""
        return request.user.is_superuser

    def get_urls(self):
        return [
            path(
                '<int:object_id>/regenerate/',
                self.admin_site.admin_view(self.regenerate_view),
                name='api_apikey_regenerate',
            ),
        ] + super().get_urls()

    def save_model(self, request, obj, form, change):
        if not change and not obj.key:
            obj.key = APIKey.generate_key(obj.name)
        super().save_model(request, obj, form, change)

    def response_add(self, request, obj, post_url_continue=None):
        return self._reveal_key(request, obj, obj.key, created=True)

    def _reveal_key(self, request, obj, new_key, created):
        context = {
            **self.admin_site.each_context(request),
            'opts': self.model._meta,
            'original': obj,
            'title': 'New API key' if created else 'API key regenerated',
            'new_key': new_key,
            'created': created,
            'change_url': reverse('admin:api_apikey_change', args=[obj.pk]),
        }
        response = TemplateResponse(request, 'admin/api/apikey/key_reveal.html', context)
        response['Cache-Control'] = 'no-store'
        return response

    @method_decorator(never_cache)
    @method_decorator(require_http_methods(['GET', 'POST']))
    def regenerate_view(self, request, object_id):
        if not request.user.is_superuser:
            raise PermissionDenied
        obj = get_object_or_404(APIKey, pk=object_id)
        change_url = reverse('admin:api_apikey_change', args=[obj.pk])

        if obj.is_env_seeded:
            self.message_user(
                request,
                f"'{obj.name}' is set from the server's .env file and re-applied on "
                "every deploy. Rotate it by changing .env, not here.",
                level='error',
            )
            return redirect(change_url)

        if request.method == 'POST':
            new_key = obj.regenerate()
            self.log_change(request, obj, 'Regenerated API key')
            return self._reveal_key(request, obj, new_key, created=False)

        context = {
            **self.admin_site.each_context(request),
            'opts': self.model._meta,
            'original': obj,
            'title': 'Regenerate API key',
            'key_preview': self.key_preview(obj),
            'change_url': change_url,
        }
        return TemplateResponse(request, 'admin/api/apikey/regenerate_confirm.html', context)


@admin.register(APIRequest)
class APIRequestAdmin(admin.ModelAdmin):
    list_display = ('api_key', 'endpoint', 'method', 'status_code', 'response_time_ms', 'created_at')
    list_filter = ('method', 'status_code', 'created_at', 'api_key')
    search_fields = ('endpoint', 'api_key__name')
    readonly_fields = ('api_key', 'endpoint', 'method', 'status_code', 'response_time_ms', 'created_at')
    date_hierarchy = 'created_at'
    
    def has_add_permission(self, request):
        """Requests are created automatically."""
        return False
    
    def has_delete_permission(self, request, obj=None):
        """Only superusers can delete."""
        return request.user.is_superuser


@admin.register(UploadedFile)
class UploadedFileAdmin(admin.ModelAdmin):
    list_display = ('original_filename', 'api_key', 'file_type', 'file_size_display', 'created_at')
    list_filter = ('file_type', 'is_deleted', 'created_at', 'api_key')
    search_fields = ('original_filename', 'api_key__name')
    readonly_fields = ('file_path', 'created_at')
    date_hierarchy = 'created_at'
    
    def file_size_display(self, obj):
        """Display file size in human readable format."""
        size = obj.file_size_bytes
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024:
                return f"{size:.2f}{unit}"
            size /= 1024
        return f"{size:.2f}TB"
    file_size_display.short_description = "File Size"
    
    def has_add_permission(self, request):
        """Files are tracked automatically."""
        return False


@admin.register(ExportedResult)
class ExportedResultAdmin(admin.ModelAdmin):
    list_display = ('layout_name', 'api_key', 'file_size_display', 'generation_time_display', 'created_at')
    list_filter = ('layout_name', 'is_deleted', 'created_at', 'api_key')
    search_fields = ('layout_name', 'api_key__name', 'export_file_path')
    readonly_fields = ('export_file_path', 'input_files', 'created_at')
    date_hierarchy = 'created_at'
    
    def file_size_display(self, obj):
        """Display file size in human readable format."""
        size = obj.file_size_bytes
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024:
                return f"{size:.2f}{unit}"
            size /= 1024
        return f"{size:.2f}TB"
    file_size_display.short_description = "File Size"
    
    def generation_time_display(self, obj):
        """Display generation time."""
        return f"{obj.generation_time_ms}ms"
    generation_time_display.short_description = "Generation Time"
    
    def has_add_permission(self, request):
        """Exports are tracked automatically."""
        return False
