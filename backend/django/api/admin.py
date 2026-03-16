from django.contrib import admin
from .models import APIKey, APIRequest, UploadedFile, ExportedResult


@admin.register(APIKey)
class APIKeyAdmin(admin.ModelAdmin):
    list_display = ('name', 'key_preview', 'is_active', 'last_used_at', 'created_at')
    list_filter = ('is_active', 'created_at', 'last_used_at')
    search_fields = ('name', 'key')
    readonly_fields = ('key', 'created_at', 'updated_at')
    fieldsets = (
        ('Key Information', {
            'fields': ('name', 'key', 'description', 'user')
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
        """Show truncated key in admin list."""
        return f"{obj.key[:20]}..." if obj.key else "N/A"
    key_preview.short_description = "API Key"
    
    def has_add_permission(self, request):
        """Only superusers can add keys."""
        return request.user.is_superuser
    
    def has_delete_permission(self, request, obj=None):
        """Only superusers can delete keys."""
        return request.user.is_superuser


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
