# APIKey.allowed_photo_hosts: the hosts POST /api/upload/from-url may fetch this
# key's customer photos from (services/photo_fetch.py). Blank on every existing
# key, which keeps the endpoint switched off until an admin names a host.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0026_renderjob_restore_manifest'),
    ]

    operations = [
        migrations.AddField(
            model_name='apikey',
            name='allowed_photo_hosts',
            field=models.TextField(
                blank=True, default='',
                help_text="Hosts our server may fetch this key's customer photos from, one per line "
                          "(for example files.example.com). Exact host names only: no https://, no path, "
                          "no wildcard. Blank = fetching photos by link is off for this key.",
            ),
        ),
    ]
