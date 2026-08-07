import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Make APIRequest usable as a real audit trail.

    The table has existed since the initial commit and nothing ever wrote to it,
    so a "0 requests for this key" query looked like proof a credential had
    never been used when it only proved nothing was ever recorded.

    Two changes are needed before the middleware can populate it:

      * api_key becomes nullable (SET_NULL). PIA-authenticated and anonymous
        calls carry no APIKey, and those staff-initiated ops actions are the
        ones most worth reconstructing — a trail that silently drops them is
        worse than none. SET_NULL also keeps history intact when a key is
        rotated or deleted, which CASCADE would have erased.

      * auth_source records who acted, denormalised, so the row still names the
        actor after the key row is gone.
    """

    dependencies = [
        ('api', '0012_stamp_file_expiry'),
    ]

    operations = [
        migrations.AlterField(
            model_name='apirequest',
            name='api_key',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='requests',
                to='api.apikey',
            ),
        ),
        migrations.AddField(
            model_name='apirequest',
            name='auth_source',
            field=models.CharField(blank=True, db_index=True, default='', max_length=100),
        ),
    ]
