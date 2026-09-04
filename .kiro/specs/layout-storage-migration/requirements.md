# Requirements Document

## Introduction

The Product Editor currently stores layout definitions as JSON files on the local filesystem (`storage/layouts/*.json`), and mask images as filesystem-based assets. These files are tracked in Git, which causes perpetual merge conflicts and broken deployments whenever the ops UI writes new or updated layouts at runtime.

This feature migrates layout storage to Postgres (via a `LayoutCatalogue` Django model) and mask storage to S3-backed assets. A unified `StorageBackend` abstraction selects `LocalStorage` for development and `S3Storage` for production via an environment variable, breaking the Git conflict cycle entirely by removing layouts from version control. Existing API contracts are preserved — no frontend changes are required.

The migration is executed in seven phases: schema and data migration, S3 storage backend implementation, view refactoring, mask upload and S3 integration, frontend compatibility verification, calendar assets migration, and deployment/rollback.

---

## Glossary

- **LayoutCatalogue**: The new Postgres model holding layout definitions, replacing the filesystem JSON files.
- **Layout_Definition**: The JSON blob stored in `LayoutCatalogue.definition`, the same structure currently in `storage/layouts/*.json`.
- **Layout_Name**: The filename stem (without `.json`) used as the unique identifier for a layout. The source of truth is always the stored `name` column, not a field inside the definition.
- **StorageBackend**: The abstract base class (`services/storage.py`) through which all layout, mask, upload, and asset I/O must pass.
- **LocalStorage**: The concrete `StorageBackend` that reads/writes the local filesystem. Default for development.
- **S3Storage**: The concrete `StorageBackend` that reads/writes AWS S3. Activated via `STORAGE_BACKEND=s3`.
- **Mask**: A PNG/JPEG overlay image referenced by a frame inside a Layout_Definition, identified by a filename key such as `masks/my_mask.png`.
- **S3_Key**: The object key used to address a Mask or other asset in S3 (e.g. `masks/my_mask.png`).
- **Presigned_URL**: A time-limited AWS S3 URL that grants temporary read access to an S3 object without requiring public bucket access.
- **Migration_0016**: Django database migration that creates the `LayoutCatalogue` table and imports existing filesystem layouts into it.
- **Export_Script**: `backend/scripts/export_layout_catalogue.py` — exports the current production layouts to `backend/migrations/prod_layouts.json` for baking into the migration.
- **Cache_Invalidation**: The process of atomically clearing all Redis cache entries that may serve stale layout data after a write. Involves `layouts_list_all`, `ops_layouts_list_all`, and `layout_detail:{name}:*`.
- **Surfaces_Filter**: The `?surfaces=` query parameter on layout detail endpoints, used to filter a multi-surface layout to specific surfaces; its value is included in the detail cache key.
- **Path_Traversal_Guard**: The `_is_safe_layout_name()` check that rejects names containing `/`, `\`, `..`, or a leading `.`.
- **Soft_Delete**: Setting `is_deprecated=True` on a `LayoutCatalogue` row instead of deleting it, to preserve the audit trail while hiding it from public reads.
- **Calendar_Asset**: Supporting files for calendar layouts — `calendar_styles`, `calendar_palettes`, `holidays`, `fonts.json` — currently on the local filesystem.
- **Ops_UI**: The internal operations interface used by the team to create, update, and delete layouts.

---

## Requirements

### Requirement 1: LayoutCatalogue Data Model

**User Story:** As a backend engineer, I want a Postgres model to store layout definitions, so that layout data is managed in the database rather than Git-tracked files.

#### Acceptance Criteria

1. THE `LayoutCatalogue` model SHALL have the following fields: `name` (unique, max 255 chars), `definition` (JSONField), `product_type` (max 100 chars, blank allowed), `category` (max 100 chars, blank allowed), `is_public` (boolean, default True), `is_deprecated` (boolean, default False), `version` (positive integer, minimum value 1, default 1), `created_at` (auto timestamp), `updated_at` (auto timestamp), `imported_at` (nullable timestamp), `imported_by` (max 255 chars, blank allowed).
2. THE `LayoutCatalogue` model SHALL enforce uniqueness on the `name` field at the database level using a case-sensitive byte-for-byte comparison, so that `"hero"` and `"Hero"` are treated as distinct names but two rows with identical byte sequences are rejected.
3. THE `LayoutCatalogue` model SHALL include a database index on `name`, `product_type`, `is_deprecated`, and `is_public` to support the common filter queries.
4. WHEN a `LayoutCatalogue` row is created, THE `LayoutCatalogue` model SHALL set `created_at` automatically and leave `updated_at` equal to `created_at`.
5. WHEN a `LayoutCatalogue` row is updated, THE `LayoutCatalogue` model SHALL update `updated_at` automatically.
6. WHEN a `LayoutCatalogue` row is saved with `imported_at` set but `imported_by` empty (or vice versa), THE `LayoutCatalogue` model SHALL raise a `ValidationError` indicating both fields must be provided together or both left null.

---

### Requirement 2: Migration 0016 — Schema Creation and Data Import

**User Story:** As a DevOps engineer, I want the database migration to both create the `LayoutCatalogue` table and import existing filesystem layouts, so that production data is seeded automatically on deploy without manual steps.

#### Acceptance Criteria

1. WHEN Migration_0016 is applied, THE Migration_0016 SHALL create the `LayoutCatalogue` table with all fields specified in Requirement 1.
2. WHEN Migration_0016 is applied and `backend/migrations/prod_layouts.json` exists, THE Migration_0016 SHALL call `import_layouts_from_filesystem()` to upsert one `LayoutCatalogue` row per valid layout entry in that file using `update_or_create(name=...)`, so that re-running the migration on a pre-populated table does not raise an integrity error.
3. WHEN `import_layouts_from_filesystem()` encounters an entry that is missing required fields or contains malformed JSON, THE Migration_0016 SHALL log the error at WARNING level, skip that entry, and continue processing the remaining entries without halting the migration.
4. WHEN Migration_0016 is reversed, THE Migration_0016 SHALL perform a NOP (intentional no-op) and leave the `LayoutCatalogue` table and data intact.
5. WHEN the Export_Script is run, THE Export_Script SHALL query `LayoutCatalogue.objects.filter(is_deprecated=False)`, serialize each row to a JSON object, and write the resulting JSON array to `backend/migrations/prod_layouts.json`.
6. WHEN the Export_Script is run against a database with no non-deprecated `LayoutCatalogue` rows, THE Export_Script SHALL write an empty JSON array (`[]`) to the output file.
7. WHEN Migration_0016 is applied and `backend/migrations/prod_layouts.json` does not exist, THE Migration_0016 SHALL skip the data import step, log a WARNING indicating the file was not found, and complete successfully with zero rows imported.
8. WHEN `import_layouts_from_filesystem()` is called and the top-level structure of `prod_layouts.json` is not a JSON array, THE Migration_0016 SHALL log an ERROR and skip all data import without halting the migration.

---

### Requirement 3: S3Storage Backend Implementation

**User Story:** As a backend engineer, I want a fully-implemented `S3Storage` backend, so that production deployments store uploads and masks in S3 rather than on the local container filesystem.

#### Acceptance Criteria

1. WHEN `STORAGE_BACKEND=s3` is set, THE `get_storage()` function SHALL return an `S3Storage` instance.
2. WHEN `STORAGE_BACKEND=s3` is set and any of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, or `S3_BUCKET` is absent from the environment, THE `S3Storage.__init__()` SHALL raise `ImproperlyConfigured` naming the missing variable, so that a misconfigured deployment fails at startup rather than at the first S3 call.
3. THE `S3Storage` class SHALL implement all methods defined on `StorageBackend`: `save_upload`, `read_upload`, `delete_file`, `file_exists`, `chunked_staging_dir`, `assemble_chunks`, `list_layouts`, `exports_path`, `layouts_dir`, and `masks_dir`, such that none of them raise `NotImplementedError`.
4. WHEN `S3Storage.list_layouts()` is called, THE `S3Storage` SHALL query `LayoutCatalogue.objects.filter(is_deprecated=False)` from Postgres and return a list of layout name strings — it SHALL NOT issue a `ListObjects` or `ListObjectsV2` call to S3 to enumerate layouts.
5. WHEN `S3Storage.save_upload()` is called with a file object and an `order_id`, THE `S3Storage` SHALL upload the file to the S3 key `uploads/{order_id}/{filename}` where `filename` is the original filename as received by the method, and SHALL return that S3 key string.
6. WHEN `S3Storage.assemble_chunks()` is called, THE `S3Storage` SHALL use the S3 Multipart Upload API to compose the provided chunk parts server-side into a single object, and SHALL return the final S3 key string of the assembled object.
7. IF any chunk part upload fails during `assemble_chunks()`, THEN THE `S3Storage` SHALL abort the multipart upload and raise an exception without leaving an incomplete multipart upload open.
8. WHILE `LocalStorage` is active, THE `StorageBackend` callers SHALL receive the same return types and the same exceptions as documented for each method, and `LocalStorage` SHALL NOT raise any new exception types not present in the current implementation.

---

### Requirement 4: ListLayoutsView Refactoring

**User Story:** As an API consumer, I want `GET /api/layouts/` to serve layouts from the database, so that new layouts added via the Ops_UI are immediately available without a filesystem or Git operation.

#### Acceptance Criteria

1. WHEN `GET /api/layouts/` is called, THE `ListLayoutsView` SHALL query `LayoutCatalogue.objects.filter(is_deprecated=False, is_public=True)`, build one dict per row by merging the row's `definition` JSONField with the top-level `name` field and a `hasCalendar` field (set to `True` when `product_type == "calendar"`, `False` otherwise), and populate the `layouts` array with those dicts.
2. WHEN the layout list is served from cache, THE `ListLayoutsView` SHALL return a response whose `layouts` array contains the same number of items, the same field names, and the same values as the uncached response for the same query.
3. THE `ListLayoutsView` SHALL cache the assembled layout list under key `layouts_list_all` with a TTL of exactly 120 seconds; if the cache write fails, THE `ListLayoutsView` SHALL return the freshly-queried list without error.
4. WHEN `?fields=summary` is provided, THE `ListLayoutsView` SHALL pass each merged layout dict (as assembled per criterion 1) to `_summarize_layout()` and return the resulting slim objects in the `layouts` array instead of the full dicts.
5. THE `ListLayoutsView` SHALL always return the response envelope `{"layouts": [...]}`, including when the query returns zero rows (returning `{"layouts": []}`), and SHALL NOT omit the `name` or `hasCalendar` fields from any item in the array.
6. IF the `LayoutCatalogue` database query raises an exception, THEN THE `ListLayoutsView` SHALL return HTTP 500 with a response body containing a `detail` field describing the error, and SHALL NOT return a partial list.

---

### Requirement 5: GetLayoutView Refactoring

**User Story:** As an API consumer, I want `GET /api/layouts/{name}` to fetch layout data from the database, so that layout retrieval is consistent with database-backed storage.

#### Acceptance Criteria

1. WHEN `GET /api/layouts/{name}` is called with a name that passes the Path_Traversal_Guard and matches a non-deprecated `LayoutCatalogue` row, THE `GetLayoutView` SHALL return HTTP 200 with the row's `definition` JSONField as the response body.
2. WHEN `GET /api/layouts/{name}` is called with a name that fails the Path_Traversal_Guard (contains `/`, `\`, `..`, or a leading `.`), THE `GetLayoutView` SHALL return HTTP 400 before performing any database query.
3. WHEN `GET /api/layouts/{name}` is called with a name that passes the Path_Traversal_Guard but matches no non-deprecated `LayoutCatalogue` row, THE `GetLayoutView` SHALL return HTTP 404.
4. THE `GetLayoutView` SHALL cache the layout detail under key `layout_detail:{name}:{surfaces_param}` with a TTL of exactly 120 seconds, where `surfaces_param` is the raw value of the `?surfaces=` query parameter (empty string if absent); if the cache write fails, THE `GetLayoutView` SHALL return the freshly-queried layout without error.
5. WHEN `?surfaces=front,back` is provided and the layout has a `surfaces` array, THE `GetLayoutView` SHALL filter the returned `surfaces` array to only those entries whose `key` field matches one of the requested values (case-insensitive); if none match, THE `GetLayoutView` SHALL return an empty `surfaces` array rather than HTTP 404.
6. THE `GetLayoutView` SHALL retain the Path_Traversal_Guard (`_is_safe_layout_name()`) as the first validation step before any database query.
7. IF the `LayoutCatalogue` database query raises an unexpected exception (not `DoesNotExist`), THEN THE `GetLayoutView` SHALL return HTTP 500 with a `detail` field and SHALL NOT expose internal exception details.

---

### Requirement 6: LayoutManagementView Refactoring

**User Story:** As an ops team member, I want POST and DELETE operations on layouts to write to the database, so that layout changes are persisted reliably and reflected immediately without filesystem writes.

#### Acceptance Criteria

1. WHEN `POST /api/ops/layouts/{name}` is called with a valid layout JSON payload and a name that passes the Path_Traversal_Guard, THE `LayoutManagementView` SHALL upsert the `LayoutCatalogue` row using `update_or_create(name=layout_name)` and return HTTP 200 on update or HTTP 201 on creation.
2. WHEN `POST /api/ops/layouts/{name}` is called with a name that fails the Path_Traversal_Guard, THE `LayoutManagementView` SHALL return HTTP 400 without performing any database write.
3. WHEN `POST /api/ops/layouts/{name}` is called with a payload that cannot be parsed as valid JSON, THE `LayoutManagementView` SHALL return HTTP 400 with a `detail` field describing the parse error, without performing any database write.
4. WHEN a layout is created or updated via `LayoutManagementView`, THE `LayoutManagementView` SHALL call `invalidate_layout_caches(name)` after the database write completes.
5. WHEN `DELETE /api/ops/layouts/{name}` is called for an existing non-deprecated layout, THE `LayoutManagementView` SHALL set `is_deprecated=True` on the `LayoutCatalogue` row (Soft_Delete), call `invalidate_layout_caches(name)`, and return HTTP 200.
6. WHEN `DELETE /api/ops/layouts/{name}` is called for a layout that does not exist or is already deprecated, THE `LayoutManagementView` SHALL return HTTP 404.
7. WHEN a layout rename is requested (via `old_name` or `originalName` in the request body) and the new name does not already exist as a non-deprecated row, THE `LayoutManagementView` SHALL create the new `LayoutCatalogue` row and soft-delete the old row atomically within a single database transaction, then call `invalidate_layout_caches` for both the old and new names.
8. WHEN a layout rename is requested and the new name already exists as a non-deprecated `LayoutCatalogue` row, THE `LayoutManagementView` SHALL return HTTP 409 without modifying either row.
9. THE `LayoutManagementView` GET handler SHALL query `LayoutCatalogue.objects.filter(is_deprecated=False)` to serve the ops layout list instead of reading from the filesystem.

---

### Requirement 7: Atomic Cache Invalidation

**User Story:** As a backend engineer, I want layout cache invalidation to be atomic and complete, so that a stale layout is never served to a customer or the ops UI after a write.

#### Acceptance Criteria

1. WHEN `invalidate_layout_caches(name)` is called, THE Cache_Invalidation function SHALL delete both `layouts_list_all` and `ops_layouts_list_all` in a single atomic bulk-delete operation.
2. WHEN `invalidate_layout_caches(name)` is called with a `name` that is neither `None` nor an empty string, THE Cache_Invalidation function SHALL delete all cache entries whose keys match the pattern `layout_detail:{name}:*` (clearing every Surfaces_Filter variant for that layout).
3. IF the pattern-delete operation raises `AttributeError` (indicating a non-Redis cache backend), THEN THE Cache_Invalidation function SHALL fall back to deleting the unparameterised layout detail cache entry for that name, without raising an exception.
4. IF the pattern-delete operation raises any exception other than `AttributeError`, THEN THE Cache_Invalidation function SHALL log the exception at WARNING level and SHALL NOT propagate it to the caller.
5. IF the detail cache deletion fails for any reason, THEN THE Cache_Invalidation function SHALL still complete the list cache deletion (criterion 1) before returning.
6. IF the list cache bulk-delete operation raises an exception, THEN THE Cache_Invalidation function SHALL log the exception at WARNING level and SHALL NOT propagate it to the caller.

---

### Requirement 8: Mask Serving via Presigned URLs

**User Story:** As an editor user, I want mask images to be served via presigned S3 redirect URLs, so that masks are accessible without exposing S3 credentials or making the bucket public.

#### Acceptance Criteria

1. WHEN `GET /api/layouts/masks/{key}` is called and `STORAGE_BACKEND=s3`, THE `MaskDownloadView` SHALL generate a Presigned_URL for the S3 object at key `masks/{key}` and return HTTP 301 with a `Location` header set to that Presigned_URL.
2. WHEN `GET /api/layouts/masks/{key}` is called and `STORAGE_BACKEND=local`, THE `MaskDownloadView` SHALL return HTTP 200 with the mask file contents and a `Content-Type` header matching the file's MIME type.
3. THE `MaskDownloadView` SHALL apply the Path_Traversal_Guard to `{key}` as the first step before any S3 or filesystem operation, returning HTTP 400 if the guard rejects the value.
4. WHEN a Presigned_URL is generated, THE `MaskDownloadView` SHALL set an expiry of no less than 300 seconds and no more than 3600 seconds on the presigned URL.
5. WHEN the requested mask S3 object does not exist, THE `MaskDownloadView` SHALL return HTTP 404.
6. WHEN the S3 service returns an error other than a not-found response, THE `MaskDownloadView` SHALL return HTTP 502 and SHALL NOT expose S3 error details in the response body.

---

### Requirement 9: Mask Upload to S3

**User Story:** As an ops team member, I want to upload mask images directly to S3, so that masks are persisted durably and their S3 keys are embedded in the layout definition.

#### Acceptance Criteria

1. WHEN a mask file is uploaded via `POST /api/ops/layouts/{name}/masks`, THE `LayoutManagementView` SHALL apply the Path_Traversal_Guard to the filename and return HTTP 400 if the guard rejects it.
2. WHEN a mask file passes the Path_Traversal_Guard, THE `LayoutManagementView` SHALL upload it to S3 under the `masks/` prefix and return the resulting S3_Key in the response.
3. WHEN a mask is uploaded successfully, THE `LayoutManagementView` SHALL embed the S3_Key into the relevant frame's mask reference within the Layout_Definition stored in `LayoutCatalogue` and persist the updated definition.
4. WHEN a mask rename is requested (old key and new key provided), THE `LayoutManagementView` SHALL first copy the S3 object to the new key, then delete the old key only after the copy succeeds, and finally update all Layout_Definition references to the old key.
5. WHEN a mask rename S3 copy operation fails, THE `LayoutManagementView` SHALL return HTTP 500 and SHALL NOT delete the original S3 object or modify any Layout_Definition.
6. WHEN a mask rename S3 delete of the old key fails after a successful copy, THE `LayoutManagementView` SHALL log a WARNING with the orphaned old key and return HTTP 200 with the new key, since the data is safely copied.

---

### Requirement 10: Calendar Assets Migration to S3

**User Story:** As a backend engineer, I want calendar asset files (styles, palettes, holidays, fonts) to be stored in S3 under an `ops-config/` prefix, so that they share the same durable storage backend as layouts and masks.

#### Acceptance Criteria

1. THE `StorageBackend` interface SHALL expose `read_calendar_asset(asset_type: str, asset_name: str) -> bytes` so all calendar asset reads go through the abstraction layer, where `asset_type` is one of `calendar_styles`, `calendar_palettes`, `holidays`, or `fonts`.
2. WHEN `STORAGE_BACKEND=s3` and `read_calendar_asset(asset_type, asset_name)` is called, THE `S3Storage` SHALL fetch the object at S3 key `ops-config/{asset_type}/{asset_name}` and return its raw bytes.
3. WHEN `STORAGE_BACKEND=local` and `read_calendar_asset(asset_type, asset_name)` is called, THE `LocalStorage` SHALL read the file at `{STORAGE_ROOT}/{asset_type}/{asset_name}` and return its raw bytes, preserving the current filesystem layout.
4. WHEN an S3 read for a calendar asset fails with a not-found or service error, THE `S3Storage` SHALL attempt to read the same asset from the local filesystem fallback path; if the fallback succeeds, THE `S3Storage` SHALL log a WARNING naming the S3 key and the fallback path used, and return the fallback bytes.
5. WHEN an S3 read fails and no local fallback file exists, THE `S3Storage` SHALL raise `FileNotFoundError` naming the `asset_type` and `asset_name`.
6. WHEN `STORAGE_BACKEND=local`, THE `LocalStorage.read_calendar_asset()` SHALL NOT attempt any S3 call.

---

### Requirement 11: Deployment and Rollback

**User Story:** As a DevOps engineer, I want the migration to run automatically on deploy and to be safely reversible, so that the rollout can be completed or unwound without manual database intervention.

#### Acceptance Criteria

1. WHEN `python manage.py migrate --noinput` is executed during container startup, THE Migration_0016 SHALL apply automatically without requiring any manual pre-deploy database step beyond running the Export_Script.
2. WHEN `STORAGE_BACKEND=local` is set, THE system SHALL route all layout reads and writes through `LocalStorage` from the local filesystem without querying `LayoutCatalogue`, so that the pre-migration filesystem-based behavior is fully restored without requiring a database rollback.
3. WHEN `python manage.py migrate api 0015` is run to reverse Migration_0016, THE Migration_0016 reverse operation SHALL perform a NOP, leaving the `LayoutCatalogue` table and all its data intact for re-promotion.
4. WHEN the Export_Script is run against a database, THE Export_Script SHALL produce a `prod_layouts.json` file whose entry count equals the number of rows returned by `LayoutCatalogue.objects.filter(is_deprecated=False)` on that database at the time of export.

---

### Requirement 12: API Contract Preservation

**User Story:** As a frontend engineer, I want all existing layout API endpoints to return identical responses after the migration, so that no frontend code changes are required.

#### Acceptance Criteria

1. THE `GET /api/layouts/` endpoint SHALL return the same top-level JSON structure after migration as before, with no fields removed or renamed from the `layouts` array items.
2. THE `GET /api/layouts/{name}` endpoint SHALL return the same JSON structure after migration as before, with no fields removed or renamed from the layout object.
3. THE `GET /api/layouts/masks/{filename}` endpoint SHALL remain accessible from the embed proxy allowlist without any privilege gate.
4. THE `POST /api/ops/layouts/{name}` endpoint SHALL accept the same multipart request body fields and return the same response structure after migration as before.
5. WHEN any layout endpoint returns an error, THE endpoint SHALL use the same HTTP status codes as the current implementation for equivalent error conditions.

---

### Requirement 13: Parser / Serializer Round-Trip for Layout Definitions

**User Story:** As a backend engineer, I want layout definitions to survive a serialization round-trip through the database, so that no layout data is silently corrupted during storage or retrieval.

#### Acceptance Criteria

1. THE `LayoutCatalogue` model SHALL store `definition` as a JSONField that accepts any valid JSON object without data loss.
2. FOR ALL valid Layout_Definition objects, storing the definition in `LayoutCatalogue.definition` and then retrieving the row SHALL produce a Python dict that compares equal (`==`) to the original dict.
3. WHEN a Layout_Definition contains Unicode characters, nested arrays, or floating-point numbers, THE `LayoutCatalogue` storage SHALL preserve those values exactly (same Unicode codepoints, same nesting, same float values) through the round-trip.
4. THE `LayoutManagementView` POST handler SHALL accept a `definition` field as either a JSON object or a JSON-encoded string; when a string is received, THE handler SHALL parse it with `json.loads()` before storing, and SHALL return HTTP 400 if parsing fails.
