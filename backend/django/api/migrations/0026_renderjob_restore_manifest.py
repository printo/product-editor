# RenderJob.restore_manifest: the restore.json a job's uploads ZIP carries
# (services/restore_manifest.py). Nullable, no backfill: a job rendered before
# this keeps NULL and its ZIP is built the old way.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0025_layouttemplate_sharing_and_orientation'),
    ]

    operations = [
        migrations.AddField(
            model_name='renderjob',
            name='restore_manifest',
            field=models.JSONField(blank=True, default=None, null=True),
        ),
    ]
