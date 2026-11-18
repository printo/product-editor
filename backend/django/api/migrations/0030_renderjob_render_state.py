# RenderJob.render_state: the render contract as submitted with THIS job.
#
# Nullable with no default needed in the database, so code that predates the
# column (a rollback, or a deploy that has migrated but not yet swapped
# containers) INSERTs without it. Existing rows stay NULL, which the worker
# reads as "use the order's render_state", exactly as before.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0029_rollback_safe_defaults'),
    ]

    operations = [
        migrations.AddField(
            model_name='renderjob',
            name='render_state',
            field=models.JSONField(blank=True, default=None, null=True),
        ),
    ]
