from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0009_renderjob_status_completed_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='embedsession',
            name='include_uploads',
            field=models.BooleanField(default=True),
        ),
    ]
