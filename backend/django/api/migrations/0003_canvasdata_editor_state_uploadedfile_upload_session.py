"""
Add editor_state JSON field to CanvasData for canvas persistence across
page refreshes, and add upload_session_id to UploadedFile for chunked uploads.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0002_canvasdata_add_callback_url"),
    ]

    operations = [
        # ── CanvasData: full editor state persistence ─────────────────────────
        migrations.AddField(
            model_name="canvasdata",
            name="editor_state",
            field=models.JSONField(
                null=True,
                blank=True,
                help_text=(
                    "Full editor state JSON — frames (offsets, scales, rotations), "
                    "overlays (text, shapes, images), background colours, surface states. "
                    "Persisted by the frontend on every meaningful change so the design "
                    "survives page refreshes."
                ),
            ),
        ),
        # ── UploadedFile: link uploads to a chunked-upload session ────────────
        migrations.AddField(
            model_name="uploadedfile",
            name="upload_session_id",
            field=models.CharField(
                max_length=64,
                null=True,
                blank=True,
                db_index=True,
                help_text="Groups chunks belonging to the same resumable upload session.",
            ),
        ),
    ]
