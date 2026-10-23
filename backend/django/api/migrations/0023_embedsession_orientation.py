# EmbedSession.orientation: the orientation the caller's CMS chose for the
# product. Blank means "as authored", which is what every existing session
# keeps. See services/layout_orientation.py.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0022_apikey_daily_cap_opt_in'),
    ]

    operations = [
        migrations.AddField(
            model_name='embedsession',
            name='orientation',
            field=models.CharField(blank=True, default='', max_length=16),
        ),
    ]
