from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Give UploadedFile an order linkage so DPDP erasure can actually find a
    customer's files.

    purge_order_data() previously located uploads only through
    CanvasData.image_paths / render_state['image_paths']. Autosave overwrites
    image_paths with [] every 2 seconds, and a file uploaded but never placed in
    a canvas appeared in neither — so the purge deleted the rows, reported
    files_deleted: 0, and left the photographs on disk.

    Blank (not null) default so existing rows migrate without a backfill and the
    column is cheap to add. Those rows stay unreachable by order and are cleaned
    by the GC on age; see docs/DPDP_ERASURE_GAP_PRD.md.
    """

    dependencies = [
        ('api', '0010_embedsession_include_uploads'),
    ]

    operations = [
        migrations.AddField(
            model_name='uploadedfile',
            name='order_id',
            field=models.CharField(
                blank=True, default='', db_index=True, max_length=100,
                help_text='Order this upload belongs to; blank when uploaded without order context.',
            ),
        ),
    ]
