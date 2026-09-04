import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.contrib.auth.models import User
from django.core.validators import MinValueValidator
from django.db.models import Q


def default_file_expiry():
    """
    Retention deadline stamped onto a file row when it is created.

    Stamped per row rather than recomputed at sweep time, because the GC used
    to delete exports and uploads on `created_at + EXPORT_RETENTION_DAYS`
    evaluated at sweep time. Shortening that env var therefore acted
    RETROACTIVELY: files whose expiry had already been promised to a partner in
    the completion webhook (`expires_at`) could vanish before that date, and the
    download endpoint would then hand back a ZIP silently missing the customer's
    originals. CanvasData and the async render outputs already worked off a
    stored `expires_at`; this brings the other two sweeps onto the same clock.
    """
    return timezone.now() + timedelta(days=settings.EXPORT_RETENTION_DAYS)


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
    
    # Nullable: PIA-authenticated and anonymous calls carry no APIKey, and an
    # audit trail that silently drops them is worse than none — those are the
    # staff-initiated ops actions most worth being able to reconstruct.
    api_key = models.ForeignKey(
        APIKey, on_delete=models.SET_NULL, related_name='requests',
        null=True, blank=True,
    )
    # Who acted, denormalised so the record survives key deletion/rotation:
    # the API key's name, "PIA" for a staff token, or "anonymous".
    auth_source = models.CharField(max_length=100, blank=True, default='', db_index=True)
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

    # Which order this file was uploaded for. Recorded at upload time from the
    # X-Order-ID header (embed proxy) or the request, and it is what makes DPDP
    # erasure provable.
    #
    # Before this existed, purge_order_data() could only find a customer's files
    # through CanvasData.image_paths / render_state['image_paths']. Autosave
    # blanks image_paths every 2s, and a file uploaded but never placed in a
    # canvas was referenced by neither — so the purge deleted the rows, reported
    # files_deleted: 0, and left the photographs on disk. See
    # docs/DPDP_ERASURE_GAP_PRD.md.
    #
    # Blank (not null) when unknown: the direct partner API uploads without any
    # order context. Those rows are still swept by the GC on age.
    order_id = models.CharField(
        max_length=100, blank=True, default='', db_index=True,
        help_text="Order this upload belongs to; blank when uploaded without order context.",
    )

    # Chunked upload — groups chunks belonging to the same resumable session.
    upload_session_id = models.CharField(
        max_length=64, null=True, blank=True, db_index=True,
        help_text="Groups chunks belonging to the same resumable upload session.",
    )

    # Tracking
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(
        null=True, blank=True, default=default_file_expiry,
        help_text="File will be auto-deleted after this date",
    )
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
    expires_at = models.DateTimeField(null=True, blank=True, default=default_file_expiry)
    is_deleted = models.BooleanField(default=False)

    class Meta:
        db_table = 'exported_results'
        verbose_name = 'Exported Result'
        verbose_name_plural = 'Exported Results'
        indexes = [
            models.Index(fields=['api_key', 'created_at']),
            models.Index(fields=['layout_name']),
            # Hot path for garbage_collector_task — filters on
            # (is_deleted=False, created_at < cutoff). Leading on is_deleted
            # so the partial scan avoids touching already-deleted rows.
            models.Index(fields=['is_deleted', 'created_at']),
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
    # Caller's own job/order identifier — stored here so the proxy can inject it
    # as X-Order-ID without ever exposing it in the iframe URL.
    order_id = models.CharField(max_length=100, blank=True, default='', db_index=True)
    # Webhook URL the caller wants notified when the render completes. Single
    # source of truth for embed-flow callbacks; the embed proxy injects it as
    # X-Callback-URL on every forwarded request, EditorRenderView captures it
    # onto CanvasData, and notify_caller_webhook_task POSTs the result.
    callback_url = models.URLField(max_length=2000, blank=True, default='')
    # Whether the completion webhook's download_url ZIP includes the customer's
    # original uploads (1_customer_uploads/). Set by the caller at session
    # creation; flows via X-Include-Uploads → CanvasData.render_state → webhook.
    # Defaults True so existing integrations are unchanged.
    include_uploads = models.BooleanField(default=True)
    # Number of items the customer ordered. Set by the caller at session
    # creation and injected as X-Order-Qty on every forwarded request, so the
    # count the editor enforces cannot be edited in the iframe URL the way the
    # legacy ?qty=N param could. NULL means "the caller did not say" — the
    # editor then falls back to that URL param and nothing server-side is
    # enforced, which is what every pre-existing session does.
    qty = models.PositiveIntegerField(null=True, blank=True, default=None)
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
    # default=list is load-bearing, not tidiness. CanvasStateView.put keeps
    # image_paths OUT of update_or_create's `defaults` on purpose: the autosave
    # payload is {layout_name, editor_state} and writing `image_paths or []`
    # blanked the recorded paths every 2 seconds, which is what broke DPDP
    # erasure (see docs/DPDP_ERASURE_GAP_PRD.md).
    #
    # The field being NOT NULL with no default made that correct decision fail
    # on INSERT: the first autosave for a new order sent no paths, Django wrote
    # NULL, and Postgres rejected it — "null value in column image_paths
    # violates not-null constraint", a 500. Since no row was created, the next
    # autosave took the same path, so a new order never got its state saved at
    # all. A model-level default applies on INSERT only and is untouched by
    # UPDATE, which is exactly the required behaviour: creates succeed, and
    # autosave still cannot clobber paths recorded at submit time.
    image_paths = models.JSONField(default=list, help_text="List of uploaded file paths")
    fit_mode = models.CharField(max_length=20, default='cover')
    # Output format — choices enforced server-side and at the API surface.
    # Future formats can be added here once the engine + frontend support them.
    EXPORT_FORMAT_CHOICES = (
        ('png', 'PNG'),
        ('pdf', 'PDF'),
    )
    export_format = models.CharField(
        max_length=20, default='png', choices=EXPORT_FORMAT_CHOICES,
    )

    # Full editor state — persisted on every meaningful change so the design
    # survives page refresh / navigation away before checkout.
    # Frontend-owned autosave blob: { surfaces: [...], activeSurfaceKey, layoutName, calendarState? }
    # Written ONLY by CanvasStateView; submit must never touch it (see render_state).
    editor_state = models.JSONField(
        null=True, blank=True,
        help_text="Full editor state JSON (frames, overlays, colours, surfaces).",
    )

    # Render payload snapshot written by EditorRenderView at submit and consumed
    # by render_canvas_task. Kept separate from editor_state so submit never
    # clobbers the auto-saved design, and so a post-submit autosave can never
    # strip the payload out from under a queued render job.
    # Structure: { canvases: [...], image_paths: [...], format_version: 1 }
    render_state = models.JSONField(
        null=True, blank=True,
        help_text="Render payload snapshot (transforms, overlays, colours, calendar) frozen at submit.",
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
            # Covers the wait-time estimation query in RenderStatusView:
            #   RenderJob.objects.filter(queue_name=..., status='queued', created_at__lt=...)
            models.Index(fields=['queue_name', 'status', 'created_at']),
            # Covers completed_at filters in CeleryMonitoringView aggregation
            models.Index(fields=['status', 'completed_at']),
        ]
    
    def __str__(self):
        return f"RenderJob {self.id} - {self.status} ({self.queue_name})"


class LayoutCatalogue(models.Model):
    """
    Single source of truth for layout definitions.

    Replaces storage/layouts/*.json. The `name` field is the layout identifier
    (was the filesystem stem, e.g. "circle_48mm"). Case-sensitive at the DB
    level — Postgres text columns default to C-collation-compatible comparison
    when using a C-locale database, which matches prod Linux filesystem behaviour.
    """

    name = models.CharField(
        max_length=255, unique=True, db_index=True,
        help_text="Layout identifier (e.g., 'circle_48mm'). Case-sensitive."
    )
    definition = models.JSONField(
        help_text="Full layout schema — same structure as the former .json files."
    )
    product_type = models.CharField(
        max_length=100,
        blank=True,
        default='single_canvas',
        db_index=True,
        help_text="Inferred from definition.productType at import time.",
    )
    category = models.CharField(
        max_length=100, blank=True, default='', db_index=True,
        help_text="Optional grouping tag, e.g. 'polaroid', 'passport'.",
    )
    is_public = models.BooleanField(
        default=True,
        help_text="If False, access controlled via LayoutPermission rows (future)."
    )
    is_deprecated = models.BooleanField(
        default=False, db_index=True,
        help_text="Hidden from public listings but still renderable."
    )

    version = models.PositiveIntegerField(
        default=1,
        validators=[MinValueValidator(1)],
        help_text="Bumped on each definition write. Starts at 1.",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Provenance — set during data migration and manual imports only.
    # Both must be set together or both left blank (validated in clean()).
    imported_at = models.DateTimeField(
        null=True, blank=True,
        help_text="When this layout was imported into Postgres."
    )
    imported_by = models.CharField(
        max_length=255, blank=True, default='',
        help_text="'migration_0016', 'manual', etc. Must be set iff imported_at is set.",
    )

    class Meta:
        db_table = 'layout_catalogue'
        indexes = [
            models.Index(fields=['name']),
            models.Index(fields=['product_type', 'is_deprecated']),
            models.Index(fields=['category']),
            models.Index(fields=['is_deprecated', 'is_public']),
        ]
        constraints = [
            models.CheckConstraint(
                check=Q(imported_by='') | Q(imported_by__isnull=False),
                name='layout_catalogue_imported_by_consistency',
            ),
        ]

    def clean(self):
        """Co-validate imported_at / imported_by — both set or both blank."""
        from django.core.exceptions import ValidationError
        has_at = bool(self.imported_at)
        has_by = bool(self.imported_by)
        if has_at != has_by:
            raise ValidationError(
                "imported_at and imported_by must both be set together or both left blank."
            )

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"LayoutCatalogue({self.name}, v{self.version})"
