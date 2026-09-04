# Technical Design: Storage Migration — JSON Layouts → Postgres + Masks → S3

## Overview

This document covers the low-level design for migrating layout storage from git-tracked JSON files to Postgres (`LayoutCatalogue`) and masks from the local filesystem to S3.

## Architecture

The migration introduces three structural changes to the existing system:

1. **LayoutCatalogue (Postgres)** replaces `storage/layouts/*.json` as the single source of truth for layout definitions. All read and write paths for layouts are redirected from filesystem `open()` calls to ORM queries.

2. **S3Storage backend** replaces the commented-out stub in `services/storage.py`. It is activated by `STORAGE_BACKEND=s3`. `list_layouts()` queries Postgres, not S3. All mask, upload, export, and calendar-asset I/O goes through S3.

3. **`services/asset_store.py`** provides a typed reader for calendar config files (`calendar_styles`, `calendar_palettes`, `holidays`, `fonts`). It delegates to `StorageBackend.read_calendar_asset()`, which reads from S3 (prod) or the local filesystem (dev).

The existing `LocalStorage` remains unchanged and continues to be the default for development. `STORAGE_BACKEND=local` restores pre-migration filesystem behavior without a DB rollback.

```
┌─────────────────────────────────────────────────────────────┐
│                        API Views                            │
│  ListLayoutsView  GetLayoutView  EditorInitView             │
│  LayoutManagementView  MaskDownloadView                     │
└────────┬────────────────────┬──────────────────────────┬────┘
         │  DB queries        │  cache get/set           │  storage I/O
         ▼                    ▼                          ▼
  LayoutCatalogue       Redis (django_redis)     StorageBackend
  (Postgres)            pe:layouts_list_all      ┌─────────────┐
                        pe:layout_detail:…       │ LocalStorage│ (dev)
                        pe:ops_layouts_list_all  │  S3Storage  │ (prod)
                                                 └─────────────┘
                                                       │
                                                       ▼
                                               S3: masks/, uploads/,
                                               exports/, ops-config/
```

## Components and Interfaces

This document covers the low-level design for migrating layout storage from git-tracked JSON files to Postgres (`LayoutCatalogue`) and masks from the local filesystem to S3. The design is grounded in the actual codebase as it stands today and is organised by implementation phase.

### Current State

The current state at a glance:

- `ListLayoutsView`, `GetLayoutView`, `EditorInitView`, and `LayoutManagementView` all call `storage.layouts_dir()` / `storage.masks_dir()` then do raw `open()` — they bypass the `StorageBackend` abstraction entirely for layout/mask I/O.
- `services/storage.py` has a fully-specified `StorageBackend` interface and a working `LocalStorage`, plus a commented-out `S3Storage` stub.
- `get_storage()` is a module-level singleton; setting `STORAGE_BACKEND=s3` currently raises `NotImplementedError`.
- The latest migration is `0015_embedsession_qty`. New model goes in `0016`.
- Cache key prefix is `pe:` (Django `KEY_PREFIX`). All cache keys in this doc are the un-prefixed application-level keys.

---

## Data Models

### `LayoutCatalogue` (new)

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `id` | BigAutoField | PK | Django default |
| `name` | CharField(255) | unique, db_index | Case-sensitive. Source of truth; overrides `definition['name']` in responses. |
| `definition` | JSONField | not null | Full layout schema — same structure as the former `.json` files. |
| `product_type` | CharField(100) | blank, db_index | Inferred from `definition.productType` at import. Default `'single_canvas'`. |
| `category` | CharField(100) | blank, db_index | Optional grouping tag. |
| `is_public` | BooleanField | default True | Hidden from public list endpoints when False. |
| `is_deprecated` | BooleanField | default False, db_index | Soft-delete flag. Deprecated rows excluded from all public reads. |
| `version` | PositiveIntegerField | min 1, default 1 | Bumped on each definition write. |
| `created_at` | DateTimeField | auto_now_add | |
| `updated_at` | DateTimeField | auto_now | |
| `imported_at` | DateTimeField | null, blank | Set during migration or manual import. Co-validated with `imported_by`. |
| `imported_by` | CharField(255) | blank | `'migration_0016'`, `'manual'`, etc. Co-validated with `imported_at`. |

**Indexes (composite):**
- `(product_type, is_deprecated)` — list queries filtering by product type
- `(is_deprecated, is_public)` — public catalog query hot path

**Constraint:** `imported_at` and `imported_by` must both be set or both be blank, enforced in `LayoutCatalogue.clean()`.

### Existing models — no schema changes

`UploadedFile.file_path`, `ExportedResult.export_file_path`, and `CanvasData.image_paths` continue to store absolute local paths in dev (`LocalStorage`) and S3 keys in prod (`S3Storage`). No data migration is needed for existing rows — they use the `read_upload()` / `delete_file()` abstraction which handles both path formats.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `LayoutCatalogue.DoesNotExist` on read | HTTP 404 `{"detail": "Layout '{name}' not found"}` |
| DB error on list/read | HTTP 500 `{"detail": "Failed to list/get layout"}` — internal detail not exposed |
| Cache write failure | Log WARNING, return fresh DB result — never fail the request |
| `cache.delete_pattern` raises `AttributeError` | Fall back to unparameterised key delete — no exception raised |
| `cache.delete_many` raises | Log WARNING — invalidation errors never propagate to the write that triggered them |
| Path traversal guard failure | HTTP 400 — returned before any DB or S3 call |
| `S3Storage.__init__` missing env var | `ImproperlyConfigured` at startup — container fails fast rather than at first S3 call |
| S3 object not found for mask | HTTP 404 |
| S3 service error for mask | HTTP 502 `{"detail": "S3 service unavailable"}` — S3 error detail not exposed |
| S3 service error for calendar asset | Fall back to local filesystem; raise `FileNotFoundError` only when both backends miss |
| Mask S3 copy fails on rename | HTTP 500; original S3 object not deleted |
| Mask S3 delete fails after successful copy | Log WARNING with orphaned key; return HTTP 200 — data is safely at new key |
| `prod_layouts.json` missing at migration time | Log WARNING, skip import, migration succeeds with zero rows |
| `prod_layouts.json` not a JSON array | Log ERROR, skip all import, migration succeeds |
| Individual layout entry missing `name` / `definition` | Log WARNING, skip entry, continue |

---

## Correctness Properties

### Property 1: Cache invalidation completeness
Cache invalidation is always attempted after a write, even if the write itself raised an exception that was caught. List caches (`layouts_list_all`, `ops_layouts_list_all`) are deleted even when the detail cache pattern deletion fails.

**Validates: Requirements 7.1, 7.5, 7.6**

### Property 2: Rename atomicity
Rename operations are atomic at the DB level — no concurrent request can observe a state where both the old and new name exist simultaneously as non-deprecated rows. `select_for_update()` on the old row inside `transaction.atomic()` prevents races.

**Validates: Requirements 6.7, 6.8**

### Property 3: Migration idempotency
Applying migration 0016 twice on a pre-populated table leaves the same row set as applying it once. `update_or_create(name=...)` ensures no integrity errors on re-run.

**Validates: Requirements 2.2, 11.1**

### Property 4: STORAGE_BACKEND=local full bypass
When `STORAGE_BACKEND=local`, `get_storage()` returns `LocalStorage` and no `LayoutCatalogue` query is issued by the views. Layout reads fall through to the filesystem, producing identical API responses to the pre-migration implementation.

**Validates: Requirements 11.2, 12.1, 12.2**

### Property 5: Mask copy-before-delete
A mask S3 key is never deleted before a successful server-side copy to the destination key. If the copy fails, the original is untouched and the API returns HTTP 500. If the delete fails after a successful copy, the original key is treated as an orphan (logged for manual cleanup) and the API returns HTTP 200.

**Validates: Requirements 9.4, 9.5, 9.6**

### Property 6: JSON round-trip fidelity
Postgres `JSONField` stores and retrieves the layout definition as a Python dict with no silent coercion. Unicode codepoints, nested arrays, and floating-point values survive the round-trip unchanged (`definition_in == definition_out` via Python `==`).

**Validates: Requirements 13.1, 13.2, 13.3**

---

## Testing Strategy

### Unit tests

| Test | Assertion |
|---|---|
| `LayoutCatalogue` clean validation | `imported_at` set without `imported_by` → `ValidationError` |
| `LayoutCatalogue` version constraint | `version=0` → `ValidationError` |
| `import_layouts_from_filesystem` — missing file | No rows created, no exception raised |
| `import_layouts_from_filesystem` — bad root type | No rows created, no exception raised |
| `import_layouts_from_filesystem` — bad entry | Entry skipped, others imported |
| `import_layouts_from_filesystem` — idempotency | Second run produces same row count |
| `S3Storage.__init__` — missing env var | `ImproperlyConfigured` raised at init |
| `S3Storage.list_layouts()` | Queries `LayoutCatalogue`, never calls `s3.list_objects_v2` |
| `S3Storage.assemble_chunks` — part failure | `abort_multipart_upload` called, exception raised |
| `invalidate_layout_caches` — Redis backend | `delete_pattern` called with correct glob |
| `invalidate_layout_caches` — non-Redis backend | Falls back to unparameterised key, no exception |
| `invalidate_layout_caches` — delete_many fails | WARNING logged, no exception |
| `ListLayoutsView` — DB error | HTTP 500 with `detail` field |
| `GetLayoutView` — guard failure | HTTP 400 returned before any DB call |
| `GetLayoutView` — surfaces filter, no match | Empty `surfaces` array, not HTTP 404 |
| `LayoutManagementView` — rename conflict | HTTP 409, neither row modified |
| `LayoutManagementView` — soft-delete | Row has `is_deprecated=True`, not deleted |
| `MaskDownloadView` — S3 not found | HTTP 404 |
| `MaskDownloadView` — S3 service error | HTTP 502 |
| `read_asset` — unknown asset_type | `ValueError` |
| `S3Storage.read_calendar_asset` — S3 miss + local hit | WARNING logged, local bytes returned |
| `S3Storage.read_calendar_asset` — both miss | `FileNotFoundError` |

Mock S3 with `moto` for all `S3Storage` unit tests.

### Integration tests

- Full roundtrip: `POST /api/ops/layouts/{name}` → `GET /api/layouts/{name}` → verify definition JSON matches
- Cache warming: `GET /api/editor/init?layout={name}` populates `layout_detail:{name}:` key; subsequent `GET /api/layouts/{name}` returns from cache (0 DB queries)
- Rename: old name returns 404, new name returns the definition, both cache keys cleared
- Mask upload + serve: `POST /api/ops/layouts/{name}` with mask file → `GET /api/layouts/masks/{key}` returns 302 to presigned URL

### Data migration test

Run migration 0016 against a staging DB dump of prod. Verify:
- `LayoutCatalogue.objects.filter(is_deprecated=False).count()` matches file count in `prod_layouts.json`
- Spot-check 3–5 layouts: `definition` JSON matches the original file content
- Re-run migration (idempotency check): count unchanged

### Smoke tests

- `scripts/smoke-test-embed.sh` passes — layouts served via embed proxy unchanged
- `scripts/smoke-test-calendar.sh` passes — calendar styles and holidays loadable

---

## Phase 1: `LayoutCatalogue` Model and Migration 0016

### 1.1 Model (`api/models.py`)

Add to the bottom of `models.py`, after the existing models:

```python
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db.models import Q


class LayoutCatalogue(models.Model):
    """
    Single source of truth for layout definitions.

    Replaces storage/layouts/*.json. The `name` field is the layout identifier
    (was the filesystem stem, e.g. "circle_48mm"). Case-sensitive at the DB
    level — Postgres text columns default to C-collation-compatible comparison
    when using a C-locale database, which matches prod Linux filesystem behaviour.
    """

    name = models.CharField(max_length=255, unique=True, db_index=True)
    definition = models.JSONField(
        help_text="Full layout schema — same structure as the former .json files."
    )
    product_type = models.CharField(
        max_length=100,
        blank=True,
        default='single_canvas',
        db_index=True,
        help_text="Inferred from definition.productType at import time.",
    )
    category = models.CharField(
        max_length=100, blank=True, default='', db_index=True,
        help_text="Optional grouping tag, e.g. 'polaroid', 'passport'.",
    )
    is_public = models.BooleanField(default=True)
    is_deprecated = models.BooleanField(default=False, db_index=True)

    version = models.PositiveIntegerField(
        default=1,
        validators=[MinValueValidator(1)],
        help_text="Bumped on each definition write. Starts at 1.",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Provenance — set during data migration and manual imports only.
    # Both must be set together or both left blank (validated in clean()).
    imported_at = models.DateTimeField(null=True, blank=True)
    imported_by = models.CharField(
        max_length=255, blank=True, default='',
        help_text="'migration_0016', 'manual', etc. Must be set iff imported_at is set.",
    )

    class Meta:
        db_table = 'layout_catalogue'
        indexes = [
            models.Index(fields=['name']),
            models.Index(fields=['product_type', 'is_deprecated']),
            models.Index(fields=['category']),
            models.Index(fields=['is_deprecated', 'is_public']),
        ]

    def clean(self):
        """Co-validate imported_at / imported_by — both set or both blank."""
        has_at = bool(self.imported_at)
        has_by = bool(self.imported_by)
        if has_at != has_by:
            raise ValidationError(
                "imported_at and imported_by must both be set together or both left blank."
            )

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"LayoutCatalogue({self.name}, v{self.version})"
```

**Why not a separate `LayoutPermission` table?** The plan document proposed one for per-key access control. Deferred: the existing `APIKey.can_list_layouts` boolean is sufficient for now. Add it as a separate ticket if per-layout ACLs are needed.

### 1.2 Migration (`api/migrations/0016_import_layout_catalogue.py`)

```python
import json
import logging
import os
from django.db import migrations, models
from django.core.validators import MinValueValidator

logger = logging.getLogger(__name__)

# Path to the baked prod catalogue dump, relative to the Django project root.
# Populated by backend/scripts/export_layout_catalogue.py before deploy.
_DUMP_PATH = os.path.join(
    os.path.dirname(__file__),   # .../api/migrations/
    '..', '..', 'migrations', 'prod_layouts.json'  # .../backend/migrations/prod_layouts.json
)


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

    dump_path = os.path.normpath(_DUMP_PATH)

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
                ('name', models.CharField(db_index=True, max_length=255, unique=True)),
                ('definition', models.JSONField()),
                ('product_type', models.CharField(blank=True, db_index=True, default='single_canvas', max_length=100)),
                ('category', models.CharField(blank=True, db_index=True, default='', max_length=100)),
                ('is_public', models.BooleanField(default=True)),
                ('is_deprecated', models.BooleanField(db_index=True, default=False)),
                ('version', models.PositiveIntegerField(default=1, validators=[MinValueValidator(1)])),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('imported_at', models.DateTimeField(blank=True, null=True)),
                ('imported_by', models.CharField(blank=True, default='', max_length=255)),
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
        migrations.RunPython(
            import_layouts_from_filesystem,
            reverse_code=noop_reverse,
        ),
    ]
```

### 1.3 Export Script (`backend/scripts/export_layout_catalogue.py`)

Used pre-deploy to bake the prod layout catalogue into a JSON file the migration can read.

```python
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
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'django'))
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
```

---

## Phase 2: S3Storage Backend (`services/storage.py`)

Replace the commented-out stub with a full implementation. The singleton factory at the bottom is updated to instantiate it.

```python
class S3Storage(StorageBackend):
    """
    Production storage backend.

    Layouts:   served from Postgres (LayoutCatalogue) — no S3 reads for layout JSON.
    Masks:     stored under s3://<bucket>/masks/
    Uploads:   stored under s3://<bucket>/uploads/<order_id>/
    Exports:   stored under s3://<bucket>/exports/
    Calendar:  stored under s3://<bucket>/ops-config/<asset_type>/
    """

    def __init__(self):
        import boto3
        from django.core.exceptions import ImproperlyConfigured

        required = {
            'AWS_ACCESS_KEY_ID': os.getenv('AWS_ACCESS_KEY_ID'),
            'AWS_SECRET_ACCESS_KEY': os.getenv('AWS_SECRET_ACCESS_KEY'),
            'AWS_REGION': os.getenv('AWS_REGION'),
            'S3_BUCKET': os.getenv('S3_BUCKET'),
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise ImproperlyConfigured(
                f"S3Storage: missing required env vars: {missing}. "
                "Set them before starting the server."
            )

        self.s3 = boto3.client(
            's3',
            aws_access_key_id=required['AWS_ACCESS_KEY_ID'],
            aws_secret_access_key=required['AWS_SECRET_ACCESS_KEY'],
            region_name=required['AWS_REGION'],
        )
        self.bucket = required['S3_BUCKET']

    # ── Uploads ───────────────────────────────────────────────────────────────

    def save_upload(self, filename: str, content: BinaryIO, order_id: str = "") -> str:
        subdir = upload_subdir(order_id)
        key = f"uploads/{subdir}/{filename}"
        self.s3.upload_fileobj(content, self.bucket, key)
        return key

    def read_upload(self, path: str) -> bytes:
        # `path` is an S3 key when S3 backend is active.
        response = self.s3.get_object(Bucket=self.bucket, Key=path)
        return response['Body'].read()

    def delete_file(self, path: str) -> bool:
        try:
            self.s3.delete_object(Bucket=self.bucket, Key=path)
            return True
        except Exception:
            return False

    def file_exists(self, path: str) -> bool:
        try:
            self.s3.head_object(Bucket=self.bucket, Key=path)
            return True
        except self.s3.exceptions.ClientError as exc:
            if exc.response['Error']['Code'] in ('404', 'NoSuchKey'):
                return False
            raise

    # ── Chunked uploads ───────────────────────────────────────────────────────

    def chunked_staging_dir(self, upload_id: str) -> str:
        """For S3, staging parts are stored at uploads/.chunks/<upload_id>/."""
        return f"uploads/.chunks/{upload_id}"

    def assemble_chunks(self, upload_id: str, final_filename: str, total_chunks: int) -> str:
        """
        S3 Multipart Upload: copy staged parts into a single object.

        Parts were uploaded individually (each <= 5 GB). We compose them
        server-side. On any part failure, abort the multipart to avoid leaving
        orphaned in-progress uploads (which are billed).
        """
        staging_prefix = self.chunked_staging_dir(upload_id)
        final_key = f"uploads/{final_filename}"

        mpu = self.s3.create_multipart_upload(Bucket=self.bucket, Key=final_key)
        upload_id_s3 = mpu['UploadId']

        parts = []
        try:
            for idx in range(total_chunks):
                part_key = f"{staging_prefix}/{idx}.part"
                # Copy the staged part as a multipart part (server-side, no re-upload).
                copy_response = self.s3.upload_part_copy(
                    Bucket=self.bucket,
                    CopySource={'Bucket': self.bucket, 'Key': part_key},
                    Key=final_key,
                    UploadId=upload_id_s3,
                    PartNumber=idx + 1,
                )
                parts.append({
                    'PartNumber': idx + 1,
                    'ETag': copy_response['CopyPartResult']['ETag'],
                })
        except Exception as exc:
            # Clean up the in-progress MPU so it is not billed indefinitely.
            self.s3.abort_multipart_upload(
                Bucket=self.bucket, Key=final_key, UploadId=upload_id_s3
            )
            raise RuntimeError(
                f"S3 chunk assembly failed at part {idx} for upload {upload_id}: {exc}"
            ) from exc

        self.s3.complete_multipart_upload(
            Bucket=self.bucket,
            Key=final_key,
            UploadId=upload_id_s3,
            MultipartUpload={'Parts': parts},
        )

        # Clean up the staging parts.
        for idx in range(total_chunks):
            self.s3.delete_object(Bucket=self.bucket, Key=f"{staging_prefix}/{idx}.part")

        return final_key

    # ── Layout / export directories ───────────────────────────────────────────

    def list_layouts(self) -> List[str]:
        """Query Postgres — never S3 LIST — to enumerate layouts."""
        from api.models import LayoutCatalogue
        return list(
            LayoutCatalogue.objects.filter(is_deprecated=False)
            .values_list('name', flat=True)
        )

    def exports_path(self, name: str) -> str:
        return f"exports/{name}"

    def layouts_dir(self) -> str:
        """Marker only. Layout reads go through LayoutCatalogue, not file I/O."""
        return f"s3://{self.bucket}/layouts/"

    def masks_dir(self) -> str:
        """Marker only. Mask reads go through generate_presigned_url, not this path."""
        return f"s3://{self.bucket}/masks/"

    # ── Mask helpers (S3-specific, not on StorageBackend base) ────────────────

    def generate_mask_presigned_url(self, s3_key: str, expiry: int = 3600) -> str:
        """Return a time-limited GET URL for a mask object."""
        return self.s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': self.bucket, 'Key': s3_key},
            ExpiresIn=expiry,
        )

    def copy_object(self, source_key: str, dest_key: str) -> None:
        self.s3.copy_object(
            CopySource={'Bucket': self.bucket, 'Key': source_key},
            Bucket=self.bucket,
            Key=dest_key,
        )

    # ── Calendar asset helpers ────────────────────────────────────────────────

    def read_calendar_asset(self, asset_type: str, asset_name: str) -> bytes:
        """
        Fetch a calendar/ops config file from S3 with local filesystem fallback.

        S3 key: ops-config/{asset_type}/{asset_name}
        Fallback: STORAGE_ROOT/{asset_type}/{asset_name}  (dev copy)
        """
        s3_key = f"ops-config/{asset_type}/{asset_name}"
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=s3_key)
            return response['Body'].read()
        except Exception as exc:
            # Fall back to the local copy (useful during transition).
            fallback = os.path.join(settings.STORAGE_ROOT, asset_type, asset_name)
            if os.path.isfile(fallback):
                logger.warning(
                    "S3 read failed for %s (%s); serving from local fallback %s.",
                    s3_key, exc, fallback,
                )
                with open(fallback, 'rb') as fh:
                    return fh.read()
            raise FileNotFoundError(
                f"Calendar asset not found: asset_type={asset_type!r}, asset_name={asset_name!r}"
            ) from exc
```

Update the factory at the bottom:

```python
def get_storage() -> StorageBackend:
    global _storage_instance
    if _storage_instance is None:
        backend = os.getenv("STORAGE_BACKEND", "local")
        if backend == "s3":
            _storage_instance = S3Storage()
        else:
            _storage_instance = LocalStorage()
    return _storage_instance
```

Also add `read_calendar_asset` to `LocalStorage`:

```python
# Add to LocalStorage:
def read_calendar_asset(self, asset_type: str, asset_name: str) -> bytes:
    """Read a calendar/ops config file from the local filesystem."""
    path = os.path.join(settings.STORAGE_ROOT, asset_type, asset_name)
    try:
        with open(path, 'rb') as fh:
            return fh.read()
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Calendar asset not found locally: asset_type={asset_type!r}, asset_name={asset_name!r}"
        )
```

---

## Phase 3: View Refactoring (`api/views.py`)

### 3.1 `invalidate_layout_caches` — no code change needed

The existing implementation already matches the spec:

```python
def invalidate_layout_caches(name: str | None = None) -> None:
    from django.core.cache import cache as django_cache
    django_cache.delete_many(["layouts_list_all", "ops_layouts_list_all"])
    if not name:
        return
    try:
        django_cache.delete_pattern(f"layout_detail:{name}:*")
    except AttributeError:
        django_cache.delete(f"layout_detail:{name}:")
    except Exception as exc:
        logger.warning("Failed to invalidate layout_detail cache for %s: %s", name, exc)
```

One gap to address: the `delete_many` call itself can raise — wrap it:

```python
def invalidate_layout_caches(name: str | None = None) -> None:
    from django.core.cache import cache as django_cache
    try:
        django_cache.delete_many(["layouts_list_all", "ops_layouts_list_all"])
    except Exception as exc:
        logger.warning("Failed to invalidate list caches: %s", exc)
    if not name:
        return
    try:
        django_cache.delete_pattern(f"layout_detail:{name}:*")
    except AttributeError:
        django_cache.delete(f"layout_detail:{name}:")
    except Exception as exc:
        logger.warning("Failed to invalidate layout_detail cache for %s: %s", name, exc)
```

### 3.2 `_layout_exists` helper — update to use DB

Replace the current `_layout_exists` static method on `GetLayoutView`:

```python
@staticmethod
def _layout_exists(name: str) -> bool:
    # Old: name in get_storage().list_layouts()  (filesystem scan)
    # New: Postgres query
    from api.models import LayoutCatalogue
    return LayoutCatalogue.objects.filter(name=name, is_deprecated=False).exists()
```

### 3.3 `ListLayoutsView.get`

Replace the disk-scan loop with a DB query. The response shape is preserved.

```python
def get(self, request):
    try:
        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue

        CACHE_KEY = "layouts_list_all"
        CACHE_TTL = 120

        layouts_data = django_cache.get(CACHE_KEY)
        if layouts_data is None:
            rows = LayoutCatalogue.objects.filter(is_deprecated=False, is_public=True)
            layouts_data = []
            for row in rows:
                entry = dict(row.definition)        # shallow copy of the JSON blob
                entry['name'] = row.name            # filename/name is source of truth
                entry['hasCalendar'] = (row.product_type == 'calendar')
                layouts_data.append(entry)
            try:
                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
            except Exception as exc:
                logger.warning("Failed to write layouts_list_all cache: %s", exc)
            logger.info("Layouts cache miss — loaded %d layouts from DB", len(layouts_data))
        else:
            logger.info("Layouts cache hit — serving %d layouts", len(layouts_data))

        if request.query_params.get('fields') == 'summary':
            payload = [_summarize_layout(d) for d in layouts_data]
        else:
            payload = layouts_data

        response = Response({"layouts": payload})
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response

    except Exception as e:
        logger.error("Error listing layouts from DB: %s", e)
        return Response(
            {"detail": "Failed to list layouts"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
```

### 3.4 `GetLayoutView.get`

Replace the file I/O with a DB lookup. Keep the path traversal guard as-is (it still guards against injection via the URL param).

```python
def get(self, request, name: str):
    try:
        if not self._is_safe_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue

        surfaces_param = request.query_params.get('surfaces', '')
        cache_key = f"layout_detail:{name}:{surfaces_param}"
        cached_data = django_cache.get(cache_key)

        if cached_data is not None:
            response = Response(cached_data)
            response['Cache-Control'] = 'private, max-age=30, must-revalidate'
            return response

        try:
            row = LayoutCatalogue.objects.get(name=name, is_deprecated=False)
        except LayoutCatalogue.DoesNotExist:
            return Response({"detail": f"Layout '{name}' not found"}, status=status.HTTP_404_NOT_FOUND)

        data = dict(row.definition)
        data['name'] = row.name

        if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
            requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
            data['surfaces'] = [
                s for s in data['surfaces']
                if s.get('key', '').lower() in requested_keys
            ]

        try:
            django_cache.set(cache_key, data, 120)
        except Exception as exc:
            logger.warning("Failed to write layout_detail cache for %s: %s", name, exc)

        response = Response(data)
        response['Cache-Control'] = 'private, max-age=30, must-revalidate'
        return response

    except Exception as e:
        logger.error("Error getting layout %s from DB: %s", name, e)
        return Response({"detail": "Failed to get layout"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
```

Remove `_layout_exists` call from the early-exit check — the DB query handles it. Remove `_is_path_safe` entirely (filesystem traversal guard is no longer needed post-migration). Keep `_is_safe_layout_name` (URL injection guard, still applies).

### 3.5 `EditorInitView.get`

Replace the file I/O block with the same DB lookup pattern. The cache key `layout_detail:{name}:{surfaces_param}` is shared with `GetLayoutView` — no change to the key.

```python
# Replace the file I/O block:
#   path = os.path.join(storage.layouts_dir(), f"{safe_name}.json")
#   if not os.path.exists(path): ...
#   with open(path, 'r') as f: layout_data = json.load(f)
# With:

from api.models import LayoutCatalogue

try:
    row = LayoutCatalogue.objects.get(name=name, is_deprecated=False)
except LayoutCatalogue.DoesNotExist:
    return Response({"detail": f"Layout '{name}' not found"}, status=status.HTTP_404_NOT_FOUND)

layout_data = dict(row.definition)
layout_data['name'] = row.name

if surfaces_param and 'surfaces' in layout_data and isinstance(layout_data['surfaces'], list):
    requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
    layout_data['surfaces'] = [
        s for s in layout_data['surfaces']
        if s.get('key', '').lower() in requested_keys
    ]

django_cache.set(cache_key, layout_data, 120)
```

Also remove the `get_storage()` call, `os.path.basename(name)`, and `_is_path_safe` from `EditorInitView` — they become dead code after this change.

### 3.6 `LayoutManagementView`

#### GET handler

```python
def get(self, request, name=None):
    from django.core.cache import cache as django_cache
    from api.models import LayoutCatalogue

    if name:
        if not self._is_valid_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            row = LayoutCatalogue.objects.get(name=name, is_deprecated=False)
        except LayoutCatalogue.DoesNotExist:
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
        response = Response(row.definition)
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response
    else:
        CACHE_KEY = "ops_layouts_list_all"
        layouts_data = django_cache.get(CACHE_KEY)
        if layouts_data is None:
            rows = LayoutCatalogue.objects.filter(is_deprecated=False)
            layouts_data = []
            for row in rows:
                entry = dict(row.definition)
                entry['name'] = row.name
                entry['hasCalendar'] = (row.product_type == 'calendar')
                layouts_data.append(entry)
            django_cache.set(CACHE_KEY, layouts_data, 120)
        response = Response({"layouts": layouts_data})
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response
```

#### POST handler (create / update / rename)

```python
def post(self, request, name=None):
    from django.db import transaction
    from api.models import LayoutCatalogue

    layout_name = name or request.data.get("name")
    if not layout_name:
        return Response({"detail": "name is required"}, status=status.HTTP_400_BAD_REQUEST)

    # Path traversal guard (repurposed as injection guard for DB names)
    if not GetLayoutView._is_safe_layout_name(layout_name):
        return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

    layout_data = request.data.get("layout_data") or request.data.get("layout")
    if not layout_data:
        return Response({"detail": "layout_data is required"}, status=status.HTTP_400_BAD_REQUEST)

    # Accept JSON string or dict
    if isinstance(layout_data, str):
        try:
            layout_data = json.loads(layout_data)
        except json.JSONDecodeError as exc:
            return Response({"detail": f"Invalid JSON: {exc}"}, status=status.HTTP_400_BAD_REQUEST)

    if not isinstance(layout_data, dict):
        return Response({"detail": "layout_data must be a JSON object"}, status=status.HTTP_400_BAD_REQUEST)

    # Handle rename
    old_name = request.data.get("old_name") or request.data.get("originalName")
    if old_name and old_name == layout_name:
        old_name = None

    if old_name:
        return self._handle_rename(request, old_name, layout_name, layout_data)

    # Run product-type validators
    product_type = layout_data.get('productType', '')
    try:
        if product_type == 'calendar':
            from api.validators import validate_calendar_layout
            validate_calendar_layout(layout_data)
        elif product_type == 'book':
            from api.validators import validate_book_layout
            validate_book_layout(layout_data)
    except Exception as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    # Upsert
    defaults = {
        'definition': layout_data,
        'product_type': product_type or 'single_canvas',
    }
    row, created = LayoutCatalogue.objects.update_or_create(
        name=layout_name, defaults=defaults
    )

    # Handle mask file upload (multipart)
    self._handle_mask_upload(request, layout_name, row)

    invalidate_layout_caches(layout_name)

    return Response(row.definition, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


def _handle_rename(self, request, old_name: str, new_name: str, layout_data: dict):
    from django.db import transaction
    from api.models import LayoutCatalogue

    with transaction.atomic():
        try:
            old_row = LayoutCatalogue.objects.select_for_update().get(
                name=old_name, is_deprecated=False
            )
        except LayoutCatalogue.DoesNotExist:
            return Response({"detail": f"Layout '{old_name}' not found"}, status=status.HTTP_404_NOT_FOUND)

        if LayoutCatalogue.objects.filter(name=new_name, is_deprecated=False).exists():
            return Response(
                {"detail": f"Layout '{new_name}' already exists"},
                status=status.HTTP_409_CONFLICT,
            )

        # Soft-delete old, create new
        old_row.is_deprecated = True
        old_row.save(update_fields=['is_deprecated', 'updated_at'])

        new_row = LayoutCatalogue.objects.create(
            name=new_name,
            definition=layout_data,
            product_type=layout_data.get('productType', 'single_canvas'),
        )

    # Migrate masks in S3 (best-effort — failure logged, not fatal)
    self._migrate_masks_on_rename(old_name, new_name)

    invalidate_layout_caches(old_name)
    invalidate_layout_caches(new_name)

    return Response(new_row.definition, status=status.HTTP_200_OK)
```

#### DELETE handler (soft-delete)

```python
def delete(self, request, name=None):
    from api.models import LayoutCatalogue

    if not name:
        return Response({"detail": "name is required"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        row = LayoutCatalogue.objects.get(name=name, is_deprecated=False)
    except LayoutCatalogue.DoesNotExist:
        return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)

    row.is_deprecated = True
    row.save(update_fields=['is_deprecated', 'updated_at'])

    invalidate_layout_caches(name)

    return Response({"detail": "success"}, status=status.HTTP_200_OK)
```

---

## Phase 4: Mask Serving and Upload

### 4.1 `MaskDownloadView` — updated for S3 presigned URLs

Replace the existing `FileResponse` implementation:

```python
def get(self, request, filename):
    # Path traversal guard (same check as before, but against the s3 key too)
    if not GetLayoutView._is_safe_layout_name(filename):
        return Response({"detail": "Invalid mask filename"}, status=status.HTTP_400_BAD_REQUEST)

    storage = get_storage()

    if hasattr(storage, 'generate_mask_presigned_url'):
        # S3 backend
        s3_key = f"masks/{filename}"
        if not storage.file_exists(s3_key):
            return Response({"detail": "Mask not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            url = storage.generate_mask_presigned_url(s3_key, expiry=3600)
            return redirect(url, permanent=False)  # HTTP 302
        except Exception as exc:
            logger.error("S3 error generating presigned URL for %s: %s", s3_key, exc)
            return Response({"detail": "S3 service unavailable"}, status=status.HTTP_502_BAD_GATEWAY)
    else:
        # LocalStorage
        path = os.path.join(storage.masks_dir(), filename)
        if not os.path.abspath(path).startswith(os.path.abspath(storage.masks_dir())):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
        if not os.path.exists(path):
            return Response({"detail": "Mask not found"}, status=status.HTTP_404_NOT_FOUND)
        import mimetypes
        content_type, _ = mimetypes.guess_type(path)
        return FileResponse(open(path, 'rb'), content_type=content_type or 'image/png')
```

Note: the URL pattern `layouts/masks/<str:filename>` stays unchanged. The spec uses `{key}` terminology; `filename` is the existing parameter name and is preserved for backward compatibility.

### 4.2 Mask upload within `LayoutManagementView.post`

Add a private helper called after the DB upsert:

```python
def _handle_mask_upload(self, request, layout_name: str, row):
    """Upload mask file to S3 (or local) and embed the key in the layout definition."""
    mask_file = request.FILES.get('mask')
    if not mask_file:
        return

    filename = mask_file.name
    if not GetLayoutView._is_safe_layout_name(filename):
        # Log but don't fail the whole layout save
        logger.warning("Rejected unsafe mask filename '%s' for layout '%s'.", filename, layout_name)
        return

    surface_key = request.data.get('surface_key', 'default')
    ext = os.path.splitext(filename)[1]

    storage = get_storage()

    if hasattr(storage, 'generate_mask_presigned_url'):
        # S3 path
        s3_filename = f"{surface_key}/mask{ext}"
        s3_key = f"masks/{layout_name}/{s3_filename}"
        storage.s3.upload_fileobj(mask_file, storage.bucket, s3_key)

        definition = dict(row.definition)
        if 'masks' not in definition:
            definition['masks'] = {}
        definition['masks'][surface_key] = {
            's3_key': s3_key,
            'updated_at': timezone.now().isoformat(),
        }
        definition['maskUrl'] = f"/api/layouts/masks/{layout_name}/{s3_filename}"
        row.definition = definition
        row.save(update_fields=['definition', 'updated_at'])
    else:
        # LocalStorage path — write to disk as before
        masks_dir = storage.masks_dir()
        mask_path = os.path.join(masks_dir, f"{layout_name}_mask{ext}")
        with open(mask_path, 'wb') as fh:
            for chunk in mask_file.chunks():
                fh.write(chunk)
        definition = dict(row.definition)
        definition['maskUrl'] = f"/api/layouts/masks/{layout_name}_mask{ext}"
        row.definition = definition
        row.save(update_fields=['definition', 'updated_at'])
```

### 4.3 Mask rename / copy within `_migrate_masks_on_rename`

```python
def _migrate_masks_on_rename(self, old_name: str, new_name: str):
    storage = get_storage()
    if not hasattr(storage, 'copy_object'):
        return  # LocalStorage — masks live on disk, no S3 to migrate

    old_prefix = f"masks/{old_name}/"
    new_prefix = f"masks/{new_name}/"

    # List all mask objects under the old prefix
    paginator = storage.s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=storage.bucket, Prefix=old_prefix):
        for obj in page.get('Contents', []):
            old_key = obj['Key']
            new_key = old_key.replace(old_prefix, new_prefix, 1)
            try:
                storage.copy_object(old_key, new_key)
            except Exception as exc:
                logger.error(
                    "Failed to copy S3 mask %s → %s during rename: %s",
                    old_key, new_key, exc,
                )
                return  # Abort — don't delete originals if copy failed

            try:
                storage.s3.delete_object(Bucket=storage.bucket, Key=old_key)
            except Exception as exc:
                logger.warning(
                    "Orphaned S3 key %s after rename to %s: %s. Manual cleanup needed.",
                    old_key, new_name, exc,
                )
```

---

## Phase 5: Calendar Assets (`services/asset_store.py`)

New module. Existing readers in `CalendarStylesView`, `HolidaysView`, and `_read_fonts()` will be updated to call through this interface.

```python
"""
Typed interface for calendar/ops config asset reads.

All calendar asset I/O must go through read_asset() so the storage backend
(local vs S3) is transparent to the caller.
"""

import logging
import os

from django.conf import settings
from services.storage import get_storage, S3Storage, LocalStorage

logger = logging.getLogger(__name__)

_VALID_ASSET_TYPES = frozenset({
    'calendar_styles',
    'calendar_palettes',
    'holidays',
    'fonts',
})


def read_asset(asset_type: str, asset_name: str) -> bytes:
    """
    Read a calendar/ops config file.

    Args:
        asset_type: One of 'calendar_styles', 'calendar_palettes', 'holidays', 'fonts'.
        asset_name: Relative path within the type, e.g. 'modern-minimalist.json'
                    or 'en-IN/2026.json'.

    Returns:
        Raw bytes of the file (typically JSON-encoded text).

    Raises:
        ValueError: If asset_type is not a recognised type.
        FileNotFoundError: If both S3 and local fallback are missing.
    """
    if asset_type not in _VALID_ASSET_TYPES:
        raise ValueError(
            f"Unknown asset_type {asset_type!r}. Must be one of {sorted(_VALID_ASSET_TYPES)}."
        )

    storage = get_storage()
    return storage.read_calendar_asset(asset_type, asset_name)
```

Update callers in `views.py`:

- `CalendarStylesView`: replace `open(os.path.join(settings.STORAGE_ROOT, 'calendar_styles', ...))` with `read_asset('calendar_styles', name + '.json')`
- `HolidaysView`: replace filesystem read with `read_asset('holidays', f"{locale}/{year}.json")`
- `_read_fonts()`: replace with `read_asset('fonts', 'fonts.json')`

---

## Phase 6: Git and `.gitignore`

Add to `.gitignore`:

```
# Layouts are now in Postgres; masks and calendar assets are in S3.
storage/layouts/
storage/masks/
storage/calendar_styles/
storage/calendar_palettes/
storage/holidays/
```

Do **not** add `storage/uploads/` or `storage/exports/` — they are already excluded or irrelevant to the git-conflict problem.

The baked dump at `backend/migrations/prod_layouts.json` **is** committed and tracked — it is the data handoff artifact consumed by the migration.

---

## Cache Key Reference (unchanged)

All existing cache keys are preserved with the same TTLs. No frontend changes required.

| Application key | Prefix in Redis | TTL | Written by | Invalidated by |
|---|---|---|---|---|
| `layouts_list_all` | `pe:layouts_list_all` | 120s | `ListLayoutsView` | `invalidate_layout_caches()` |
| `ops_layouts_list_all` | `pe:ops_layouts_list_all` | 120s | `LayoutManagementView.get` | `invalidate_layout_caches()` |
| `layout_detail:{name}:{surfaces}` | `pe:layout_detail:…` | 120s | `GetLayoutView`, `EditorInitView` | `invalidate_layout_caches(name)` |

---

## URL Changes

None. All URL patterns in `urls.py` are unchanged. The mask URL parameter name `filename` is preserved in `MaskDownloadView` even though the spec document uses `key` terminology.

---

## Data Flow Diagrams

### Layout Read (post-migration, `STORAGE_BACKEND=s3`)

```
GET /api/layouts/{name}
        │
        ▼
_is_safe_layout_name()  →  HTTP 400 if fails
        │
        ▼
cache.get("layout_detail:{name}:{surfaces}")
        │ miss
        ▼
LayoutCatalogue.objects.get(name=name, is_deprecated=False)
        │ DoesNotExist → HTTP 404
        │ found
        ▼
Apply surfaces filter on definition['surfaces']
        │
        ▼
cache.set(...)  →  HTTP 200 with definition JSON
```

### Layout Write (post-migration, ops UI)

```
POST /api/ops/layouts/{name}
        │
        ▼
_is_safe_layout_name()  →  HTTP 400
json.loads(layout_data)  →  HTTP 400
validate_*_layout()  →  HTTP 400
        │
        ▼
LayoutCatalogue.update_or_create(name=layout_name)
        │
        ▼
_handle_mask_upload()  →  S3 upload + embed key in definition
        │
        ▼
invalidate_layout_caches(name)
  ├── delete_many(["layouts_list_all", "ops_layouts_list_all"])
  └── delete_pattern("layout_detail:{name}:*")
        │
        ▼
HTTP 200 or 201
```

### Mask Serve (post-migration, `STORAGE_BACKEND=s3`)

```
GET /api/layouts/masks/{filename}
        │
        ▼
_is_safe_layout_name(filename)  →  HTTP 400
        │
        ▼
storage.file_exists("masks/{filename}")  →  HTTP 404 if missing
        │
        ▼
storage.generate_mask_presigned_url("masks/{filename}", expiry=3600)
        │  S3 error → HTTP 502
        ▼
HTTP 302 → presigned URL
```

---

## Files Modified

| File | Change |
|---|---|
| `backend/django/api/models.py` | Add `LayoutCatalogue` model |
| `backend/django/api/migrations/0016_import_layout_catalogue.py` | New migration |
| `backend/django/api/views.py` | Refactor 5 views + `invalidate_layout_caches` |
| `backend/django/services/storage.py` | Implement `S3Storage`; add `read_calendar_asset` to `LocalStorage`; update `get_storage()` |
| `backend/django/services/asset_store.py` | New file — typed calendar asset reader |
| `backend/scripts/export_layout_catalogue.py` | New script |
| `.gitignore` | Exclude `storage/layouts/`, `storage/masks/`, calendar dirs |

---

## Deployment Runbook

```bash
# Step 1 (on prod, before pushing the migration branch):
python backend/scripts/export_layout_catalogue.py \
    /home/ubuntu/product-editor/storage/layouts \
    backend/migrations/prod_layouts.json

# Step 2 — verify count:
python -c "import json; d=json.load(open('backend/migrations/prod_layouts.json')); print(len(d), 'layouts')"
# Should match: ls storage/layouts/*.json | wc -l

# Step 3 — commit the dump:
git add backend/migrations/prod_layouts.json
git commit -m "chore: bake prod layout catalogue for migration 0016"
git push -u origin feat/layout-storage-migration

# Step 4 — standard deploy (entrypoint.sh runs manage.py migrate automatically)
./deploy.sh backend

# Step 5 — verify post-deploy:
docker-compose exec backend python manage.py shell -c \
    "from api.models import LayoutCatalogue; print(LayoutCatalogue.objects.filter(is_deprecated=False).count(), 'layouts in DB')"

# Rollback (if needed — data is preserved, just switch backend):
# On prod .env: set STORAGE_BACKEND=local  →  restart containers
# Views will read from filesystem again without any DB rollback.
```
