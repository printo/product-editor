import uuid
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # ------------------------------------------------------------------ #
        # APIKey                                                               #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='APIKey',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(help_text="Name of the API consumer (e.g., 'Mobile App', 'Web Client')", max_length=100, unique=True)),
                ('key', models.CharField(db_index=True, max_length=255, unique=True)),
                ('description', models.TextField(blank=True, help_text='Description of API key usage')),
                ('is_active', models.BooleanField(default=True)),
                ('is_ops_team', models.BooleanField(default=False, help_text='Whether this key belongs to the internal operations team')),
                ('can_generate_layouts', models.BooleanField(default=True)),
                ('can_list_layouts', models.BooleanField(default=True)),
                ('can_access_exports', models.BooleanField(default=True)),
                ('max_requests_per_day', models.IntegerField(blank=True, default=1000, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_used_at', models.DateTimeField(blank=True, null=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'API Key',
                'verbose_name_plural': 'API Keys',
                'db_table': 'api_keys',
            },
        ),
        migrations.AddIndex(
            model_name='apikey',
            index=models.Index(fields=['key'], name='api_keys_key_291dcc_idx'),
        ),
        migrations.AddIndex(
            model_name='apikey',
            index=models.Index(fields=['is_active'], name='api_keys_is_acti_73be43_idx'),
        ),
        migrations.AddIndex(
            model_name='apikey',
            index=models.Index(fields=['last_used_at'], name='api_keys_last_us_fbf652_idx'),
        ),

        # ------------------------------------------------------------------ #
        # APIRequest                                                           #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='APIRequest',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('endpoint', models.CharField(db_index=True, max_length=255)),
                ('method', models.CharField(choices=[('GET', 'GET'), ('POST', 'POST'), ('PUT', 'PUT'), ('DELETE', 'DELETE')], max_length=10)),
                ('status_code', models.IntegerField(default=200)),
                ('response_time_ms', models.IntegerField(help_text='Response time in milliseconds')),
                ('request_size_bytes', models.IntegerField(blank=True, default=0, null=True)),
                ('response_size_bytes', models.IntegerField(blank=True, default=0, null=True)),
                ('error_message', models.TextField(blank=True, null=True)),
                ('ip_address', models.GenericIPAddressField(blank=True, null=True)),
                ('user_agent', models.CharField(blank=True, max_length=500)),
                ('request_metadata', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('api_key', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='requests', to='api.apikey')),
            ],
            options={
                'verbose_name': 'API Request',
                'verbose_name_plural': 'API Requests',
                'db_table': 'api_requests',
            },
        ),
        migrations.AddIndex(
            model_name='apirequest',
            index=models.Index(fields=['api_key', 'created_at'], name='api_request_api_key_dd9736_idx'),
        ),
        migrations.AddIndex(
            model_name='apirequest',
            index=models.Index(fields=['endpoint', 'created_at'], name='api_request_endpoin_30f05a_idx'),
        ),
        migrations.AddIndex(
            model_name='apirequest',
            index=models.Index(fields=['status_code'], name='api_request_status__f5b5a7_idx'),
        ),

        # ------------------------------------------------------------------ #
        # ExportedResult                                                       #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='ExportedResult',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('layout_name', models.CharField(max_length=255)),
                ('export_file_path', models.CharField(db_index=True, max_length=500)),
                ('input_files', models.JSONField(default=list, help_text='List of input file paths')),
                ('generation_time_ms', models.IntegerField()),
                ('file_size_bytes', models.BigIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('is_deleted', models.BooleanField(default=False)),
                ('api_key', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='exports', to='api.apikey')),
            ],
            options={
                'verbose_name': 'Exported Result',
                'verbose_name_plural': 'Exported Results',
                'db_table': 'exported_results',
            },
        ),
        migrations.AddIndex(
            model_name='exportedresult',
            index=models.Index(fields=['api_key', 'created_at'], name='exported_re_api_key_6eabb5_idx'),
        ),
        migrations.AddIndex(
            model_name='exportedresult',
            index=models.Index(fields=['layout_name'], name='exported_re_layout__021b64_idx'),
        ),

        # ------------------------------------------------------------------ #
        # UploadedFile                                                         #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='UploadedFile',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('file_path', models.CharField(db_index=True, max_length=500, unique=True)),
                ('original_filename', models.CharField(max_length=255)),
                ('file_size_bytes', models.BigIntegerField()),
                ('file_type', models.CharField(default='image', max_length=50)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('expires_at', models.DateTimeField(blank=True, help_text='File will be auto-deleted after this date', null=True)),
                ('is_deleted', models.BooleanField(default=False)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('api_key', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='uploaded_files', to='api.apikey')),
            ],
            options={
                'verbose_name': 'Uploaded File',
                'verbose_name_plural': 'Uploaded Files',
                'db_table': 'uploaded_files',
            },
        ),
        migrations.AddIndex(
            model_name='uploadedfile',
            index=models.Index(fields=['api_key', 'created_at'], name='uploaded_fi_api_key_def084_idx'),
        ),
        migrations.AddIndex(
            model_name='uploadedfile',
            index=models.Index(fields=['expires_at'], name='uploaded_fi_expires_8df13c_idx'),
        ),
        migrations.AddIndex(
            model_name='uploadedfile',
            index=models.Index(fields=['is_deleted'], name='uploaded_fi_is_dele_45ff28_idx'),
        ),

        # ------------------------------------------------------------------ #
        # EmbedSession                                                         #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='EmbedSession',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('token', models.UUIDField(db_index=True, default=uuid.uuid4, unique=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('expires_at', models.DateTimeField()),
                ('is_revoked', models.BooleanField(default=False)),
                ('api_key', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='embed_sessions', to='api.apikey')),
            ],
            options={
                'verbose_name': 'Embed Session',
                'verbose_name_plural': 'Embed Sessions',
                'db_table': 'embed_sessions',
            },
        ),
        migrations.AddIndex(
            model_name='embedsession',
            index=models.Index(fields=['token'], name='embed_sessi_token_0e7d0a_idx'),
        ),
        migrations.AddIndex(
            model_name='embedsession',
            index=models.Index(fields=['expires_at'], name='embed_sessi_expires_b9a39e_idx'),
        ),

        # ------------------------------------------------------------------ #
        # CanvasData                                                           #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='CanvasData',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ('order_id', models.CharField(db_index=True, max_length=100, unique=True)),
                ('layout_name', models.CharField(max_length=255)),
                ('image_paths', models.JSONField(help_text='List of uploaded file paths')),
                ('fit_mode', models.CharField(default='cover', max_length=20)),
                ('export_format', models.CharField(default='png', max_length=20)),
                ('soft_proof', models.BooleanField(default=False)),
                ('callback_url', models.URLField(blank=True, help_text='Optional URL to POST when rendering completes (per-request)', max_length=2000, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('expires_at', models.DateTimeField()),
                ('requires_manual_review', models.BooleanField(default=False)),
                ('api_key', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='canvas_data', to='api.apikey')),
            ],
            options={
                'verbose_name': 'Canvas Data',
                'verbose_name_plural': 'Canvas Data',
                'db_table': 'canvas_data',
            },
        ),
        migrations.AddIndex(
            model_name='canvasdata',
            index=models.Index(fields=['order_id'], name='canvas_data_order_i_86b782_idx'),
        ),
        migrations.AddIndex(
            model_name='canvasdata',
            index=models.Index(fields=['created_at'], name='canvas_data_created_07f7ab_idx'),
        ),

        # ------------------------------------------------------------------ #
        # RenderJob                                                            #
        # ------------------------------------------------------------------ #
        migrations.CreateModel(
            name='RenderJob',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ('celery_task_id', models.CharField(blank=True, db_index=True, max_length=255, null=True, unique=True)),
                ('status', models.CharField(choices=[('queued', 'Queued'), ('processing', 'Processing'), ('completed', 'Completed'), ('failed', 'Failed')], db_index=True, default='queued', max_length=20)),
                ('queue_name', models.CharField(max_length=50)),
                ('output_paths', models.JSONField(blank=True, help_text='List of generated file paths', null=True)),
                ('error_message', models.TextField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('started_at', models.DateTimeField(blank=True, null=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('generation_time_ms', models.IntegerField(blank=True, null=True)),
                ('retry_count', models.IntegerField(default=0)),
                ('canvas_data', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='render_jobs', to='api.canvasdata')),
            ],
            options={
                'verbose_name': 'Render Job',
                'verbose_name_plural': 'Render Jobs',
                'db_table': 'render_jobs',
            },
        ),
        migrations.AddIndex(
            model_name='renderjob',
            index=models.Index(fields=['celery_task_id'], name='render_jobs_celery__8d3cd8_idx'),
        ),
        migrations.AddIndex(
            model_name='renderjob',
            index=models.Index(fields=['status', 'created_at'], name='render_jobs_status_8b4c5f_idx'),
        ),
    ]
