from django.db import migrations, models


class Migration(migrations.Migration):
    """v1.8 schema cleanup — bundles four independent changes that all happen
    to land at this migration boundary so deploys don't have to apply them in
    sequence.

    1. Partial-friendly index for the garbage collector hot path.
       `garbage_collector_task` filters ExportedResult on
       `(is_deleted=False, created_at < cutoff)`. The pre-existing index
       `(api_key, created_at)` had the wrong leading column for that scan,
       forcing the planner into a full table scan. Adding
       `(is_deleted, created_at)` puts the filter columns at the front of the
       index so daily GC scales linearly with matched rows, not table size.

    2. Drop CanvasData.soft_proof. The CMYK soft-proof + ICC pipeline was
       retired with the move to PNG/PDF-only output. Unused by both
       GenerateLayoutView and EditorRenderView going forward.

    3. Constrain CanvasData.export_format to ('png', 'pdf'). Removes the
       legacy 'tiff_cmyk' option, making the column reflect the new contract
       enforced at both API surfaces.

    4. Add EmbedSession.callback_url. Single source of truth for embed-flow
       webhook delivery — the embed proxy injects this as X-Callback-URL on
       forwarded requests so EditorRenderView can capture it onto CanvasData
       without needing the iframe customer to type a URL.
    """

    dependencies = [
        ('api', '0006_embedsession_order_id'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='exportedresult',
            index=models.Index(
                fields=['is_deleted', 'created_at'],
                name='exported_results_is_del_ctd_idx',
            ),
        ),
        migrations.RemoveField(
            model_name='canvasdata',
            name='soft_proof',
        ),
        migrations.AlterField(
            model_name='canvasdata',
            name='export_format',
            field=models.CharField(
                choices=[('png', 'PNG'), ('pdf', 'PDF')],
                default='png',
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name='embedsession',
            name='callback_url',
            field=models.URLField(blank=True, default='', max_length=2000),
        ),
    ]
