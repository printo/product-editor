# UploadedFile.source_key: which link a photo was fetched from, hashed
# (services.photo_fetch.source_key_for), so POST /api/upload/from-url returns
# the copy it already holds for an order instead of downloading it again.
# Blank on every existing row and on every ordinary upload.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0027_apikey_allowed_photo_hosts'),
    ]

    operations = [
        migrations.AddField(
            model_name='uploadedfile',
            name='source_key',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64),
        ),
    ]
