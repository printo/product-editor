# A template can be offered on every layout whose window box matches its home
# layout's (services/print_sheet.py::template_size). Ops tick those layouts;
# the home layout stays `layout`.

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
    ]
