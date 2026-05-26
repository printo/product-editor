# Calendar feature — S3-readiness audit (Phase 9, PRD §11.17)

Status: **READY** — no hardcoded local paths outside `settings.STORAGE_ROOT`.
Date: 2026-05-24

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
| `storage/holidays/<locale>/<year>.json` | `services/calendar_holidays.py::_HOLIDAYS_ROOT` | Auto-loaded holidays |
| `storage/sku_layouts.json` | `api/views.py::SKU_LAYOUTS_JSON_PATH` | SKU → layout mapping |
| `storage/fonts.json` | `api/views.py::FONTS_JSON_PATH` | Bundled font list (NB: font *.ttf files ship with the image under `services/fonts_assets/`, not under STORAGE_ROOT — correct, fonts are immutable assets) |
| `storage/parity-fixtures/calendar-grid.json` | `services/tests/test_calendar_renderer.py` | Test fixture, dev-only |

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
