# Shared templates (PR #304). Two fields on LayoutTemplate:
#
# - `extra_layouts`: a template can be offered on every layout whose window box
#   matches its home layout's (services/print_sheet.py::template_size). Ops
#   tick those layouts; the home layout stays `layout`.
# - `orientation`: a template faces one way, the orientation its home layout is
#   served in when ops design it and customers are offered it
#   (services/layout_orientation turns the layout; the template records which
#   way it was designed for). Blank is the layout as drawn, which every template
#   until now was.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0024_layouttag'),
    ]

    operations = [
        migrations.AddField(
            model_name='layouttemplate',
            name='extra_layouts',
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Other layouts this template is also offered on. Ops tick them; each must have "
                    "the same window box as `layout`, the home layout it was authored on."
                ),
                related_name='shared_templates',
                to='api.layoutcatalogue',
            ),
        ),
        migrations.AddField(
            model_name='layouttemplate',
            name='orientation',
            field=models.CharField(
                blank=True,
                default='',
                help_text=(
                    "Which way the template faces: 'portrait' or 'landscape' turns the home layout "
                    "a quarter turn when it is drawn the other way (as a customer order with that "
                    "orientation does); blank is the layout as drawn. Fixed at creation."
                ),
                max_length=16,
            ),
        ),
    ]
