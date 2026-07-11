"""CanvasData.render_state — submit-time render payload snapshot.

Separates the two writers that previously shared editor_state (autosave vs
submit) so a Save & Continue no longer wipes the customer's auto-saved design,
and an autosave landing while a render job is queued can no longer strip the
job's transforms/overlays/colours (a silent wrong-print vector).
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0007_exportedresult_gc_partial_index'),
    ]

    operations = [
        migrations.AddField(
            model_name='canvasdata',
            name='render_state',
            field=models.JSONField(
                blank=True,
                help_text='Render payload snapshot (transforms, overlays, colours, calendar) frozen at submit.',
                null=True,
            ),
        ),
    ]
