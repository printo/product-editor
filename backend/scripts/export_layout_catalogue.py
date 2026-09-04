#!/usr/bin/env python
"""
Export the active LayoutCatalogue rows to a JSON file for migration seeding.

Usage (on prod, before deploying migration 0016):
    python backend/scripts/export_layout_catalogue.py \
        /home/ubuntu/product-editor/storage/layouts \
        backend/migrations/prod_layouts.json

The output file is committed to the repo and consumed by migration 0016's
RunPython step on the next deploy.

If LayoutCatalogue already exists (post-migration re-export), it exports from
the DB. If not (pre-migration first-run), it reads from the filesystem path.
"""

import json
import os
import sys
import django

# ── Bootstrap Django ──────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'product_editor.settings')
django.setup()


def export_from_db(output_path: str) -> int:
    from api.models import LayoutCatalogue
    rows = LayoutCatalogue.objects.filter(is_deprecated=False)
    entries = [
        {
            'name': row.name,
            'definition': row.definition,
            'product_type': row.product_type,
            'category': row.category,
            'is_public': row.is_public,
            'is_deprecated': row.is_deprecated,
            'version': row.version,
        }
        for row in rows
    ]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as fh:
        json.dump(entries, fh, indent=2, ensure_ascii=False)
    return len(entries)


def export_from_filesystem(layouts_dir: str, output_path: str) -> int:
    entries = []
    for filename in sorted(os.listdir(layouts_dir)):
        if not filename.endswith('.json'):
            continue
        name = os.path.splitext(filename)[0]
        path = os.path.join(layouts_dir, filename)
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                definition = json.load(fh)
            definition['name'] = name  # ensure name field matches filename
            entries.append({
                'name': name,
                'definition': definition,
                'product_type': definition.get('productType', 'single_canvas'),
                'category': '',
                'is_public': True,
                'is_deprecated': False,
                'version': 1,
            })
        except Exception as exc:
            print(f"WARNING: Skipping {filename}: {exc}", file=sys.stderr)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as fh:
        json.dump(entries, fh, indent=2, ensure_ascii=False)
    return len(entries)


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        print(
            "Usage:\n"
            "  export_layout_catalogue.py <output_path>              # from DB\n"
            "  export_layout_catalogue.py <layouts_dir> <output_path>  # from filesystem",
            file=sys.stderr,
        )
        sys.exit(1)

    if len(sys.argv) == 2:
        output = sys.argv[1]
        count = export_from_db(output)
        print(f"Exported {count} layouts from DB → {output}")
    else:
        layouts_dir, output = sys.argv[1], sys.argv[2]
        count = export_from_filesystem(layouts_dir, output)
        print(f"Exported {count} layouts from filesystem → {output}")
