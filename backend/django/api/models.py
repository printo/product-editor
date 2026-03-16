import secrets
import uuid
from django.db import models
from django.utils import timezone
from django.contrib.auth.models import User


class APIKey(models.Model):
    """Model to store and track API keys for external integrations."""
    
    name = models.CharField(max_length=100, unique=True, help_text="Name of the API consumer (e.g., 'Mobile App', 'Web Client')")
    key = models.CharField(max_length=255, unique=True, db_index=True)  # Bearer token
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    description = models.TextField(blank=True, help_text="Description of API key usage")
    
    # Status and permissions
    is_active = models.BooleanField(default=True)
    is_ops_team = models.BooleanField(default=False, help_text="Whether this key belongs to the internal operations team")
    can_generate_layouts = models.BooleanField(default=True)
    can_list_layouts = models.BooleanField(default=True)
    can_access_exports = models.BooleanField(default=True)
    max_requests_per_day = models.IntegerField(default=1000, null=True, blank=True)
    
    # Tracking
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'api_keys'
        verbose_name = 'API Key'
        verbose_name_plural = 'API Keys'
        indexes = [
            models.Index(fields=['key']),
            models.Index(fields=['is_active']),
            models.Index(fields=['last_used_at']),
        ]
    
    def __str__(self):
        return f"{self.name} ({self.key[:20]}...)"
    
    @staticmethod
    def generate_key(name: str) -> str:
        """Generate a secure random API key."""
        # Format: editor_{timestamp}_{random}
        import time
        timestamp = int(time.time())
        random_part = secrets.token_urlsafe(32)
        return f"editor_{timestamp}_{random_part}"
    
    @staticmethod
    def create_key(name: str, **kwargs) -> 'APIKey':
        """Create a new API key."""
        key = APIKey.generate_key(name)
        api_key = APIKey(name=name, key=key, **kwargs)
        api_key.save()
        return api_key


class APIRequest(models.Model):
    """Model to track all API requests for auditing and analytics."""
    
    api_key = models.ForeignKey(APIKey, on_delete=models.CASCADE, related_name='requests')
    endpoint = models.CharField(max_length=255, db_index=True)
    method = models.CharField(max_length=10, choices=[('GET', 'GET'), ('POST', 'POST'), ('PUT', 'PUT'), ('DELETE', 'DELETE')])
    
    # Request details
    status_code = models.IntegerField(default=200)
    response_time_ms = models.IntegerField(help_text="Response time in milliseconds")
    request_size_bytes = models.IntegerField(default=0, null=True, blank=True)
    response_size_bytes = models.IntegerField(default=0, null=True, blank=True)
    
    # Error tracking
    error_message = models.TextField(blank=True, null=True)
    
    # Additional context
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    request_metadata = models.JSONField(default=dict, blank=True)  # Extra data like layout_name, etc.
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    
    class Meta:
        db_table = 'api_requests'
        verbose_name = 'API Request'
        verbose_name_plural = 'API Requests'
        indexes = [
            models.Index(fields=['api_key', 'created_at']),
            models.Index(fields=['endpoint', 'created_at']),
            models.Index(fields=['status_code']),
        ]
    
    def __str__(self):
        return f"{self.api_key.name} - {self.method} {self.endpoint} ({self.status_code})"


class UploadedFile(models.Model):
    """Model to track uploaded files for management and cleanup."""
    
    api_key = models.ForeignKey(APIKey, on_delete=models.CASCADE, related_name='uploaded_files')
    file_path = models.CharField(max_length=500, unique=True, db_index=True)
    original_filename = models.CharField(max_length=255)
    file_size_bytes = models.BigIntegerField()
    file_type = models.CharField(max_length=50, default='image')  # image, layout, export
    
    # Tracking
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(null=True, blank=True, help_text="File will be auto-deleted after this date")
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    
    class Meta:
        db_table = 'uploaded_files'
        verbose_name = 'Uploaded File'
        verbose_name_plural = 'Uploaded Files'
        indexes = [
            models.Index(fields=['api_key', 'created_at']),
            models.Index(fields=['expires_at']),
            models.Index(fields=['is_deleted']),
        ]
    
    def __str__(self):
        return f"{self.original_filename} ({self.file_size_bytes} bytes)"


class ExportedResult(models.Model):
    """Model to track generated exports for analytics and user management."""
    
    api_key = models.ForeignKey(APIKey, on_delete=models.CASCADE, related_name='exports')
    layout_name = models.CharField(max_length=255)
    export_file_path = models.CharField(max_length=500, db_index=True)
    input_files = models.JSONField(default=list, help_text="List of input file paths")
    
    # Generation metadata
    generation_time_ms = models.IntegerField()
    file_size_bytes = models.BigIntegerField()
    
    # Tracking
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    is_deleted = models.BooleanField(default=False)
    
    class Meta:
        db_table = 'exported_results'
        verbose_name = 'Exported Result'
        verbose_name_plural = 'Exported Results'
        indexes = [
            models.Index(fields=['api_key', 'created_at']),
            models.Index(fields=['layout_name']),
        ]
    
    def __str__(self):
        return f"{self.layout_name} - {self.export_file_path} ({self.file_size_bytes} bytes)"


# AI Processing Models

class AIProcessingJob(models.Model):
    """Model to track AI processing jobs for analytics and user management."""
    
    JOB_TYPES = [
        ('background_removal', 'Background Removal'),
        ('product_detection', 'Product Detection'),
        ('design_placement', 'Design Placement'),
        ('realistic_blending', 'Realistic Blending'),
        ('complete_processing', 'Complete AI Processing'),
    ]
    
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('cancelled', 'Cancelled'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    api_key = models.ForeignKey(APIKey, on_delete=models.CASCADE, related_name='ai_jobs')
    job_type = models.CharField(max_length=50, choices=JOB_TYPES)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    
    # File references
    input_image = models.FileField(upload_to='ai_processing/input/')
    output_image = models.FileField(upload_to='ai_processing/output/', null=True, blank=True)
    
    # Processing parameters and results
    parameters = models.JSONField(default=dict, help_text="Processing parameters (blend mode, opacity, etc.)")
    result_data = models.JSONField(default=dict, help_text="Processing results (detected products, confidence, etc.)")
    
    # Timing and performance
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    processing_time = models.FloatField(null=True, blank=True, help_text="Processing time in seconds")
    
    # Error handling
    error_message = models.TextField(blank=True)
    retry_count = models.IntegerField(default=0)
    
    class Meta:
        db_table = 'ai_processing_jobs'
        verbose_name = 'AI Processing Job'
        verbose_name_plural = 'AI Processing Jobs'
        indexes = [
            models.Index(fields=['api_key', 'created_at']),
            models.Index(fields=['job_type', 'status']),
            models.Index(fields=['status', 'created_at']),
        ]
    
    def __str__(self):
        return f"{self.job_type} - {self.status} ({self.id})"


class ModelCache(models.Model):
    """Model to track cached AI models for management and cleanup."""
    
    STATUS_CHOICES = [
        ('available', 'Available'),
        ('loading', 'Loading'),
        ('error', 'Error'),
        ('disabled', 'Disabled'),
    ]
    
    model_name = models.CharField(max_length=100, unique=True)
    version = models.CharField(max_length=50)
    file_path = models.CharField(max_length=500)
    file_size = models.BigIntegerField()
    
    # Usage tracking
    last_used = models.DateTimeField(auto_now=True)
    load_time = models.FloatField(help_text="Time to load model in seconds")
    memory_usage = models.BigIntegerField(help_text="Memory usage in bytes")
    
    # Capabilities
    is_gpu_compatible = models.BooleanField(default=False)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='available')
    
    # Metadata
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'model_cache'
        verbose_name = 'Model Cache Entry'
        verbose_name_plural = 'Model Cache Entries'
        indexes = [
            models.Index(fields=['model_name']),
            models.Index(fields=['status']),
            models.Index(fields=['last_used']),
        ]
    
    def __str__(self):
        return f"{self.model_name} v{self.version} - {self.status}"
