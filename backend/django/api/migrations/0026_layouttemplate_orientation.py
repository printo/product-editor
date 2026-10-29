# A template faces one way: the orientation its home layout is served in when
# ops design it and when customers are offered it (services/layout_orientation
# turns the layout; the template records which way it was designed for).
# Blank is the layout as drawn, which every template until now was.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0025_layouttemplate_extra_layouts'),
    ]

    operations = [
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
