"""
Add updated_at to CanvasData so the canvas-state endpoint can report
when the design was last saved, and so the GC task can use it for
age-based decisions.

updated_at uses auto_now=True, so it stamps itself on every save.
The initial population value (for rows that already exist) must be
provided as a non-callable default — we use the current timestamp.
"""

import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0003_canvasdata_editor_state_uploadedfile_upload_session"),
    ]

    operations = [
        migrations.AddField(
            model_name="canvasdata",
            name="updated_at",
            field=models.DateTimeField(
                auto_now=True,
                # Back-fill existing rows with the migration run time.
                # auto_now=True fields require a default for AddField so that
                # pre-existing rows get a valid timestamp instead of NULL.
                default=django.utils.timezone.now,
            ),
            preserve_default=False,
        ),
        # Index expires_at so the garbage-collector query
        # (filter expires_at__lt=now) is a fast index scan, not a full table scan.
        migrations.AddIndex(
            model_name="canvasdata",
            index=models.Index(
                fields=["expires_at"],
                name="canvas_data_expires_idx",
            ),
        ),
    ]
