# APIKey.max_requests_per_day becomes enforced (services/request_quota.py).
#
# Until now the field was stored, shown in the admin and never checked, so
# every row carries a number nobody chose: the model default (1000) or the
# entrypoint's seed (10000 / 1000 / 5000). Enforcing those as-is would cap
# real traffic on deploy — the storefront key alone sends hundreds of autosave
# PUTs per customer. So the default becomes "no cap" and every existing value
# is blanked; ops set a cap deliberately in the admin from here on.

from django.db import migrations, models


def blank_unchosen_caps(apps, schema_editor):
    APIKey = apps.get_model('api', 'APIKey')
    APIKey.objects.update(max_requests_per_day=None)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0021_layouttemplate'),
    ]

    operations = [
        migrations.AlterField(
            model_name='apikey',
            name='max_requests_per_day',
            field=models.PositiveIntegerField(
                blank=True, default=None, null=True,
                help_text='Audited API calls this key may make per day (IST). Blank = no cap. '
                          'Once reached, the key gets 429 until midnight IST. Enforced since migration 0022; '
                          'before that the number was recorded and never checked.',
            ),
        ),
        migrations.RunPython(blank_unchosen_caps, migrations.RunPython.noop),
    ]
