# Database defaults for three older NOT NULL columns.
#
# `embed_sessions.orientation` (0023), `layout_catalogue.display_name` (0020)
# and `layout_templates.orientation` (0025) were added NOT NULL with a default
# that lives only in Django. deploy.sh migrates BEFORE it swaps containers, and
# a rollback runs an older image on the newer schema: code that predates a
# column INSERTs without it and Postgres refuses the row (a new embed session,
# a layout save, a template create). With a database default the older code's
# INSERT simply gets ''. Same remedy as 0029.
#
# Not a data change: existing rows are untouched, and Django still supplies ''
# itself. api/tests/test_rollback_safe_columns.py no longer grandfathers these.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0030_renderjob_render_state'),
    ]

    operations = [
        migrations.AlterField(
            model_name='embedsession',
            name='orientation',
            field=models.CharField(blank=True, db_default='', default='', max_length=16),
        ),
        migrations.AlterField(
            model_name='layoutcatalogue',
            name='display_name',
            field=models.CharField(
                blank=True, db_default='', default='', max_length=255,
                help_text=(
                    "Ops-editable customer-facing name, independent of `name`. Freely "
                    "editable at any time, unlike the identifier. Blank means no one has "
                    "set one yet \u2014 callers should fall back to default_display_name_for(name)."
                ),
            ),
        ),
        migrations.AlterField(
            model_name='layouttemplate',
            name='orientation',
            field=models.CharField(
                blank=True, db_default='', default='', max_length=16,
                help_text=(
                    "Which way the template faces: 'portrait' or 'landscape' turns the home layout "
                    "a quarter turn when it is drawn the other way (as a customer order with that "
                    "orientation does); blank is the layout as drawn. Fixed at creation."
                ),
            ),
        ),
    ]
