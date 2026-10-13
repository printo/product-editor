# Layout templates: ops-authored decoration for a layout (see services/template_decoration.py).

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0020_layoutcatalogue_display_name'),
    ]

    operations = [
        migrations.CreateModel(
            name='LayoutTemplate',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('template_id', models.CharField(db_index=True, help_text="Public identifier, e.g. 'retro-birthday'. Lowercase letters, digits and hyphens. Immutable.", max_length=80, unique=True)),
                ('display_name', models.CharField(max_length=255)),
                ('status', models.CharField(choices=[('draft', 'Draft'), ('published', 'Published')], db_index=True, default='draft', max_length=16)),
                ('decoration', models.JSONField(default=dict)),
                ('thumbnail_url', models.CharField(blank=True, default='', max_length=512)),
                ('layout_version', models.PositiveIntegerField(default=1)),
                ('is_deleted', models.BooleanField(db_index=True, default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('layout', models.ForeignKey(db_column='layout_name', on_delete=django.db.models.deletion.CASCADE, related_name='templates', to='api.layoutcatalogue', to_field='name')),
            ],
            options={
                'db_table': 'layout_templates',
                'ordering': ['display_name', 'template_id'],
                'indexes': [models.Index(fields=['layout', 'status', 'is_deleted'], name='layout_temp_layout__95b247_idx')],
            },
        ),
    ]
