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
        # Show only the trailing 4 chars — avoids leaking key material in
        # Django error pages, admin search results, or log strings.
        return f"{self.name} (...{self.key[-4:]})"
    
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

    # Chunked upload — groups chunks belonging to the same resumable session.
    upload_session_id = models.CharField(
        max_length=64, null=True, blank=True, db_index=True,
        help_text="Groups chunks belonging to the same resumable upload session.",
    )

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


class EmbedSession(models.Model):
    """Short-lived session token for embedding the editor in external sites.

    External systems exchange their real API key (via POST /api/embed/session)
    for a disposable token.  Only the token appears in the iframe URL; the
    real key is never exposed to the browser.
    """

    token = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True)
    api_key = models.ForeignKey(APIKey, on_delete=models.CASCADE, related_name='embed_sessions')
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    is_revoked = models.BooleanField(default=False)

    class Meta:
        db_table = 'embed_sessions'
        verbose_name = 'Embed Session'
        verbose_name_plural = 'Embed Sessions'
        indexes = [
            models.Index(fields=['token']),
            models.Index(fields=['expires_at']),
        ]

    def is_valid(self) -> bool:
        return not self.is_revoked and self.expires_at > timezone.now()

    def __str__(self):
        return f"EmbedSession({self.api_key.name}, expires={self.expires_at:%Y-%m-%d %H:%M})"



class CanvasData(models.Model):
    """Persisted canvas design for async rendering and editor state recovery."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    # Not globally unique — scoped per API key so embed tenants are isolated.
    # Uniqueness is enforced by unique_together = ('order_id', 'api_key') below.
    order_id = models.CharField(max_length=100, db_index=True)
    api_key = models.ForeignKey(APIKey, on_delete=models.CASCADE, related_name='canvas_data')

    # Canvas configuration
    layout_name = models.CharField(max_length=255)
    image_paths = models.JSONField(help_text="List of uploaded file paths")
    fit_mode = models.CharField(max_length=20, default='cover')
    export_format = models.CharField(max_length=20, default='png')
    soft_proof = models.BooleanField(default=False)

    # Full editor state — persisted on every meaningful change so the design
    # survives page refresh / navigation away before checkout.
    # Structure: { canvases: [...], surfaceStates: [...], globalFitMode: str }
    editor_state = models.JSONField(
        null=True, blank=True,
        help_text="Full editor state JSON (frames, overlays, colours, surfaces).",
    )

    # Callback URL to notify when rendering completes (optional, per-request)
    callback_url = models.URLField(max_length=2000, null=True, blank=True)

    # Metadata
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField()
    requires_manual_review = models.BooleanField(default=False)
    
    class Meta:
        db_table = 'canvas_data'
        verbose_name = 'Canvas Data'
        verbose_name_plural = 'Canvas Data'
        # Tenant-scoped uniqueness: the same order_id can exist for different
        # API keys (e.g. two separate embed customers) without colliding.
        unique_together = [('order_id', 'api_key')]
        indexes = [
            models.Index(fields=['order_id']),
            models.Index(fields=['created_at']),
            # Added via migration 0004 — keeps model in sync with DB so
            # `makemigrations` doesn't generate a spurious drop-index migration.
            models.Index(fields=['expires_at'], name='canvas_data_expires_idx'),
        ]
    
    def __str__(self):
        return f"Canvas {self.order_id} - {self.layout_name}"


class RenderJob(models.Model):
    """Async rendering job status and results."""
    
    STATUS_CHOICES = [
        ('queued', 'Queued'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    canvas_data = models.ForeignKey(CanvasData, on_delete=models.CASCADE, related_name='render_jobs')
    celery_task_id = models.CharField(max_length=255, unique=True, db_index=True, null=True, blank=True)
    
    # Status tracking
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='queued',
        db_index=True
    )
    
    # Queue assignment
    queue_name = models.CharField(max_length=50)
    
    # Results
    output_paths = models.JSONField(null=True, blank=True, help_text="List of generated file paths")
    error_message = models.TextField(null=True, blank=True)
    
    # Timing
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    generation_time_ms = models.IntegerField(null=True, blank=True)
    
    # Retry tracking
    retry_count = models.IntegerField(default=0)
    
    class Meta:
        db_table = 'render_jobs'
        verbose_name = 'Render Job'
        verbose_name_plural = 'Render Jobs'
        indexes = [
            # celery_task_id is already unique=True on the field, which creates
            # a unique index in Postgres.  An explicit Index here would be a
            # duplicate, so only the composite status/created_at index is needed.
            models.Index(fields=['status', 'created_at']),
        ]
    
    def __str__(self):
        return f"RenderJob {self.id} - {self.status} ({self.queue_name})"
