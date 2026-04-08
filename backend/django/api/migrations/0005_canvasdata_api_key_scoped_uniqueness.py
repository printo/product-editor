"""
Scope CanvasData uniqueness from (order_id globally unique) to
(order_id, api_key) unique together.

Why:
  Previously order_id had a global UNIQUE constraint, meaning two different
  embed tenants could never share the same order_id value.  More critically,
  the GET endpoint had no api_key filter, so any valid key could read any
  order's canvas state by guessing the order_id.

After this migration:
  - The global unique constraint on order_id is dropped.
  - A composite UNIQUE constraint on (order_id, api_key) is added instead.
  - GET and PUT both filter by api_key so each tenant only sees its own records.
  - Two different API keys can legitimately reuse the same order_id without
    colliding (useful for embed customers who control their own order namespacing).
"""

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0004_canvasdata_updated_at"),
    ]

    operations = [
        # 1. Drop the old global unique constraint on order_id alone.
        migrations.AlterField(
            model_name="canvasdata",
            name="order_id",
            field=models.CharField(
                max_length=100,
                db_index=True,
                # unique=True removed — uniqueness is now enforced by
                # unique_together = [('order_id', 'api_key')] below.
            ),
        ),
        # 2. Add the composite (order_id, api_key) unique constraint.
        migrations.AlterUniqueTogether(
            name="canvasdata",
            unique_together={("order_id", "api_key")},
        ),
    ]
