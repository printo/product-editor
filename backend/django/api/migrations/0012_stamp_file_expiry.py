from datetime import timedelta

from django.conf import settings
from django.db import migrations, models
from django.db.models import F

import api.models


def backfill_expiry(apps, schema_editor):
    """
    Stamp the retention deadline onto rows that pre-date it.

    Without this, every existing row keeps expires_at = NULL and falls through
    to the legacy `created_at + EXPORT_RETENTION_DAYS` branch in the GC — which
    is exactly the retroactive behaviour this change exists to remove. Anyone
    lowering the env var right after deploying would still have shortened the
    window on files already on disk.

    The window used is whatever EXPORT_RETENTION_DAYS is at migration time, so
    deploy this BEFORE changing that value.
    """
    days = settings.EXPORT_RETENTION_DAYS
    for model_name in ('UploadedFile', 'ExportedResult'):
        model = apps.get_model('api', model_name)
        model.objects.filter(expires_at__isnull=True).update(
            expires_at=F('created_at') + timedelta(days=days)
        )


def unstamp_expiry(apps, schema_editor):
    """
    Reverse is intentionally a no-op.

    Blanking expires_at would drop rows back onto age-based sweeping and could
    delete files earlier than promised — the opposite of safe. Leaving the
    stamps in place is harmless: the GC treats a populated expires_at the same
    way before and after this migration.
    """
    return None


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0011_uploadedfile_order_id'),
    ]

    operations = [
        migrations.AlterField(
            model_name='uploadedfile',
            name='expires_at',
            field=models.DateTimeField(
                blank=True,
                default=api.models.default_file_expiry,
                help_text='File will be auto-deleted after this date',
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name='exportedresult',
            name='expires_at',
            field=models.DateTimeField(
                blank=True,
                default=api.models.default_file_expiry,
                null=True,
            ),
        ),
        migrations.RunPython(backfill_expiry, unstamp_expiry),
    ]
