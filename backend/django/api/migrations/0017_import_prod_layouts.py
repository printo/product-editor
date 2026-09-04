from django.db import migrations
import json
import os
import logging

logger = logging.getLogger(__name__)

def import_prod_layouts(apps, schema_editor):
    LayoutCatalogue = apps.get_model('api', 'LayoutCatalogue')
    
    dump_path = os.path.join(
        os.path.dirname(__file__),
        '..', '..', 'migrations', 'prod_layouts.json'
    )
    
    if not os.path.exists(dump_path):
        logger.warning(f"Layout dump not found at {dump_path}")
        return
    
    with open(dump_path, 'r') as f:
        layouts = json.load(f)
    
    logger.info(f"Importing {len(layouts)} layouts...")
    
    for layout_def in layouts:
        name = layout_def.pop('name')
        product_type = layout_def.get('productType', 'single_canvas')
        
        obj, created = LayoutCatalogue.objects.update_or_create(
            name=name,
            defaults={
                'definition': layout_def,
                'product_type': product_type,
                'is_public': True,
                'version': 1,
            }
        )
        status = "Created" if created else "Updated"
        logger.info(f"  ✓ {status}: {name}")
    
    count = LayoutCatalogue.objects.filter(is_deprecated=False).count()
    logger.info(f"Import complete — {count} layouts in DB")

class Migration(migrations.Migration):
    dependencies = [
        ('api', '0016_import_layout_catalogue'),
    ]

    operations = [
        migrations.RunPython(import_prod_layouts, migrations.RunPython.noop),
    ]
