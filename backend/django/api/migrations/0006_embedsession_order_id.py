from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0005_canvasdata_api_key_scoped_uniqueness'),
    ]

    operations = [
        migrations.AddField(
            model_name='embedsession',
            name='order_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=100),
        ),
    ]
