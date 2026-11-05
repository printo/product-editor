# Gives the two columns added on 2026-11-05 a default in the database itself.
#
# Migrations 0027 and 0028 added NOT NULL columns whose default lived only in
# Django. deploy.sh migrates BEFORE it swaps containers, and a rollback runs
# older code on the newer schema: in both cases code that has never heard of
# the column INSERTs without it, and Postgres refuses the row. For
# uploaded_files that is every photo upload. With a database default the older
# code's INSERT simply gets ''.
#
# api/tests/test_rollback_safe_columns.py fails on any future column that is
# NOT NULL with no database default.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0028_uploadedfile_source_key'),
    ]

    operations = [
        migrations.AlterField(
            model_name='apikey',
            name='allowed_photo_hosts',
            field=models.TextField(
                blank=True, db_default='', default='',
                help_text="Hosts our server may fetch this key's customer photos from, one per line "
                          "(for example files.example.com). Exact host names only: no https://, no path, "
                          "no wildcard. Blank = fetching photos by link is off for this key.",
            ),
        ),
        migrations.AlterField(
            model_name='uploadedfile',
            name='source_key',
            field=models.CharField(blank=True, db_default='', db_index=True, default='', max_length=64),
        ),
    ]
