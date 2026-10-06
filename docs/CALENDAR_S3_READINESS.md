# Calendar feature — S3-readiness audit (Phase 9, PRD §11.17)

Status: **READY** — no hardcoded local paths outside `settings.STORAGE_ROOT`.
Date: 2026-05-24 · *Amended 2026-09-04: the `storage/sku_layouts.json` row was dropped — that mapping and its endpoints were removed, and SKU → layout resolution now happens in printo.in. The audit's conclusion is unchanged.*
*Amended 2026-09-29: the conclusion was wrong for reads. "No hardcoded paths" held, but the render-time readers (holidays, theme style, Gen-Z palette) opened files under `STORAGE_ROOT` directly, and `S3Storage.read_calendar_asset` built a key with neither the `S3_PREFIX` nor the `.json` suffix that `write_calendar_asset` adds — so under `STORAGE_BACKEND=s3` every calendar-asset read silently fell back to local disk and an ops edit reached neither the preview nor the print. All three readers now go through `services/asset_store.py` (as the ops/preview endpoints already did), and read/write/delete share one key via `S3Storage._calendar_asset_key`; pinned by `services/tests/test_calendar_assets_s3.py`. Production runs `STORAGE_BACKEND=s3`, so this was live; no edit had been lost (zero writes to these endpoints in the audit trail, and `ops-config/` held only an empty folder marker). Still open under S3: a missing S3 object falls back to the git-seeded local file, so deleting an asset in S3 resurrects its seed.*
*Amended again 2026-09-29: closed. A delete now leaves a tombstone object, so only a key S3 has never held reaches the seed; and an S3 read that fails for any reason other than `NoSuchKey`/`AccessDenied` raises `CalendarAssetUnavailable` instead of serving the seed (503 in the preview, a retried render in the print). The holiday refresh moved from `scripts/refresh-holidays.py` (local disk only — under S3 it merged into and wrote the stale seed) to `manage.py refresh_holidays`, which reads and writes through storage — and from Nager.Date, which has no data for India, to the offline `holidays` package. The style/palette lists now include what S3 holds (they listed local seeds only), and fonts are read from `storage/fonts.json` again (PR #111 had moved them to `fonts/fonts.json`). See CLAUDE.md "Future: S3 Migration".*
*Amended 2026-10-06: the "S3 transition path" section below is historical. Caller 3 (`services/storage.py::write_layout_json_atomic`) no longer exists — layout JSON moved into Postgres (`LayoutCatalogue`, PR #111), so layout PUTs never touch the filesystem. The proposed `services/blob_store.py` shim was never built: `services/storage.py` (`S3Storage` / `LocalStorage`) plus `services/asset_store.py` cover that role, and production has run `STORAGE_BACKEND=s3` since 2026-09-04. The `LAYOUTS_DIR` row in the table below is likewise legacy.*

## Storage roots (all env-driven)

`product_editor/settings.py` defines a single `STORAGE_ROOT` env var (defaults
to `./storage/`) from which every other path derives:

| Setting | Path | Used by |
|---|---|---|
| `STORAGE_ROOT` | env or `./storage` | All others below |
| `LAYOUTS_DIR` | `$STORAGE_ROOT/layouts` | Layout JSONs |
| `EXPORTS_DIR` | `$STORAGE_ROOT/exports` | Render outputs |
| `UPLOADS_DIR` | `$STORAGE_ROOT/uploads` | Customer files |

## Calendar-specific paths

All under `$STORAGE_ROOT` and assembled via `os.path.join(settings.STORAGE_ROOT, …)`:

| Path | Module | Purpose |
|---|---|---|
| `storage/calendar_palettes/genz/<name>.json` | `services/calendar_layout.py` | Gen-Z palette swatches |
| `storage/calendar_styles/<name>.json` | `api/views.py::CALENDAR_STYLES_DIR` | Style preset metadata |
| `storage/holidays/<locale>/<year>.json` | `services/calendar_holidays.py` (reads via `services/asset_store.py`) | Auto-loaded holidays |
| `storage/fonts.json` | `services/storage.py::_LOCAL_PATH_OVERRIDES` (read via `api/views.py::_read_fonts`) | Font list (NB: font *.ttf files ship with the image under `services/fonts_assets/`, not under STORAGE_ROOT — correct, fonts are immutable assets) |
| `storage/parity-fixtures/calendar-grid.json` | `services/tests/test_calendar_renderer.py` | Test fixture, dev-only |
| `storage/parity-fixtures/calendar-year.json` | `services/tests/test_calendar_year_parity.py` | Test fixture, dev-only |

## Engine output paths

`layout_engine/engine.py` writes to `$EXPORTS_DIR/<stem>.{png|pdf}` via the
new (P7.1) displayLabel-driven filenames. Atomic-write helper uses
`tempfile.NamedTemporaryFile(dir=output_dir)` then `os.replace()` —
filesystem-local, but stages to the same dir as the final output so it
stays within `$STORAGE_ROOT`.

## ZIP delivery

`RenderJobDownloadView` builds the ZIP via
`tempfile.NamedTemporaryFile(dir=$EXPORTS_DIR)` and writes archive contents
inline. The temp lives under `$EXPORTS_DIR` so it inherits whatever backing
store STORAGE_ROOT points at.

## S3 transition path (when ready)

The single concrete-storage assumption to remove is **local-filesystem
atomic writes**. Three callers do this today:

1. `LayoutEngine._write_output_atomic` — writes PNGs/PDFs atomically.
2. `RenderJobDownloadView` — builds ZIPs atomically.
3. `services/storage.py::write_layout_json_atomic` (for layout JSON PUTs).

S3 doesn't need atomic writes (PutObject is already atomic on the object).
Each of the three callers would become:

- Write to a local `tempfile` → upload to S3 → delete temp.
- Or use `boto3.upload_fileobj` directly into the destination bucket.

The READ side is even simpler — `open(path, "r")` becomes
`boto3.get_object(Bucket, Key).read()`. Wrap behind a small
`services/blob_store.py` shim and the callers stay unchanged.

## No hardcoded paths outside STORAGE_ROOT

A repo-wide grep for `/app/storage/`, `/tmp/storage/`, hardcoded
`/var/...` etc. returns zero hits in source modules. The only `/tmp/`
references are in test scripts (parity check uses `/tmp/p6-real-...`)
and Python tempfile defaults, which are intentional and S3-compatible.

## Conclusion

No code changes required to make the calendar feature S3-ready.
Migration is gated only on the (already-planned, see CLAUDE.md "S3
migration" section if added) blob-store shim covering atomic writes.
