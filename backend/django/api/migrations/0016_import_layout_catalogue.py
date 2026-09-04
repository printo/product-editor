import json
import logging
import os
from datetime import timedelta

from django.db import migrations, models
from django.core.validators import MinValueValidator

logger = logging.getLogger(__name__)

# Path to the baked prod catalogue dump, relative to the Django project root.
# Populated by backend/scripts/export_layout_catalogue.py before deploy.
_DUMP_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__),   # .../api/migrations/
    '..', '..', 'migrations', 'prod_layouts.json'  # .../backend/migrations/prod_layouts.json
))


def _infer_product_type(definition: dict) -> str:
    pt = definition.get('productType', '')
    mapping = {
        'calendar': 'calendar',
        'book': 'book',
        'multi_surface': 'multi_surface',
        'single_canvas': 'single_canvas',
    }
    return mapping.get(pt, 'single_canvas')


def import_layouts_from_filesystem(apps, schema_editor):
    """
    RunPython forward: load prod_layouts.json into LayoutCatalogue.

    Idempotent — uses update_or_create so re-running on a populated table
    is safe. Skips individual bad entries without aborting the whole import.
    """
    LayoutCatalogue = apps.get_model('api', 'LayoutCatalogue')
    from django.utils import timezone

    dump_path = _DUMP_PATH

    if not os.path.exists(dump_path):
        logger.warning(
            "Migration 0016: Layout dump not found at %s — skipping import. "
            "Run export_layout_catalogue.py on prod before deploying.",
            dump_path,
        )
        return

    try:
        with open(dump_path, 'r', encoding='utf-8') as fh:
            raw = json.load(fh)
    except json.JSONDecodeError as exc:
        logger.error(
            "Migration 0016: prod_layouts.json is not valid JSON (%s) — skipping all import.",
            exc,
        )
        return

    if not isinstance(raw, list):
        logger.error(
            "Migration 0016: prod_layouts.json top-level structure is %s, expected a JSON array — skipping all import.",
            type(raw).__name__,
        )
        return

    created = updated = skipped = 0
    for entry in raw:
        if not isinstance(entry, dict):
            logger.warning("Migration 0016: Skipping non-dict entry: %r", entry)
            skipped += 1
            continue

        name = entry.get('name')
        definition = entry.get('definition')

        if not name or not isinstance(name, str):
            logger.warning(
                "Migration 0016: Skipping entry missing 'name': %r",
                {k: v for k, v in entry.items() if k != 'definition'},  # don't log big blobs
            )
            skipped += 1
            continue

        if not isinstance(definition, dict):
            logger.warning("Migration 0016: Skipping '%s' — 'definition' is missing or not a dict.", name)
            skipped += 1
            continue

        product_type = _infer_product_type(definition)

        obj, was_created = LayoutCatalogue.objects.update_or_create(
            name=name,
            defaults={
                'definition': definition,
                'product_type': product_type,
                'category': entry.get('category', ''),
                'is_public': entry.get('is_public', True),
                'is_deprecated': entry.get('is_deprecated', False),
                'version': entry.get('version', 1),
                'imported_at': timezone.now(),
                'imported_by': 'migration_0016',
            },
        )

        if was_created:
            created += 1
            logger.info("Migration 0016: Imported layout '%s'.", name)
        else:
            updated += 1
            logger.info("Migration 0016: Updated layout '%s'.", name)

    logger.info(
        "Migration 0016: Import complete — %d created, %d updated, %d skipped.",
        created, updated, skipped,
    )


def noop_reverse(apps, schema_editor):
    """
    Intentional NOP.

    Rows stay in Postgres to avoid accidental data loss during a rollback.
    Revert to disk-based layout serving by setting STORAGE_BACKEND=local
    rather than by rolling back this migration.
    """
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0015_embedsession_qty'),
    ]

    operations = [
        migrations.CreateModel(
            name='LayoutCatalogue',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(db_index=True, help_text="Layout identifier (e.g., 'circle_48mm'). Case-sensitive.", max_length=255, unique=True)),
                ('definition', models.JSONField(help_text='Full layout schema — same structure as the former .json files.')),
                ('product_type', models.CharField(blank=True, db_index=True, default='single_canvas', help_text='Inferred from definition.productType at import time.', max_length=100)),
                ('category', models.CharField(blank=True, db_index=True, default='', help_text="Optional grouping tag, e.g. 'polaroid', 'passport'.", max_length=100)),
                ('is_public', models.BooleanField(default=True, help_text='If False, access controlled via LayoutPermission rows (future).')),
                ('is_deprecated', models.BooleanField(db_index=True, default=False, help_text='Hidden from public listings but still renderable.')),
                ('version', models.PositiveIntegerField(default=1, help_text='Bumped on each definition write. Starts at 1.', validators=[MinValueValidator(1)])),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('imported_at', models.DateTimeField(blank=True, help_text='When this layout was imported into Postgres.', null=True)),
                ('imported_by', models.CharField(blank=True, default='', help_text="'migration_0016', 'manual', etc. Must be set iff imported_at is set.", max_length=255)),
            ],
            options={
                'db_table': 'layout_catalogue',
                'indexes': [
                    models.Index(fields=['name'], name='layout_catalogue_name_idx'),
                    models.Index(fields=['product_type', 'is_deprecated'], name='layout_catalogue_pt_dep_idx'),
                    models.Index(fields=['category'], name='layout_catalogue_category_idx'),
                    models.Index(fields=['is_deprecated', 'is_public'], name='layout_catalogue_dep_pub_idx'),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name='layoutcatalogue',
            constraint=models.CheckConstraint(check=models.Q(('imported_by', ''), _connector='OR', _negated=False) | models.Q(('imported_by__isnull', False)), name='layout_catalogue_imported_by_consistency'),
        ),
        migrations.RunPython(
            import_layouts_from_filesystem,
            reverse_code=noop_reverse,
        ),
    ]
