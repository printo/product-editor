import uuid
import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0002_apikey_is_ops_team'),
    ]

    operations = [
        migrations.CreateModel(
            name='EmbedSession',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('token', models.UUIDField(default=uuid.uuid4, unique=True)),
                ('api_key', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='embed_sessions',
                    to='api.apikey',
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('expires_at', models.DateTimeField()),
                ('is_revoked', models.BooleanField(default=False)),
            ],
            options={
                'verbose_name': 'Embed Session',
                'verbose_name_plural': 'Embed Sessions',
                'db_table': 'embed_sessions',
            },
        ),
        migrations.AddIndex(
            model_name='embedsession',
            index=models.Index(fields=['token'], name='embed_sessions_token_idx'),
        ),
        migrations.AddIndex(
            model_name='embedsession',
            index=models.Index(fields=['expires_at'], name='embed_sessions_expires_idx'),
        ),
    ]
