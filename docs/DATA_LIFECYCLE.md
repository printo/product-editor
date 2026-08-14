# Data Lifecycle & Retention

What personal/customer data the Product Editor stores, where it lives, and how
it is deleted. Supports DPDP compliance (data minimisation + right to erasure).

**One retention clock.** Everything customer-facing expires on
`settings.EXPORT_RETENTION_DAYS` (env `EXPORT_RETENTION_DAYS`, default **7**;
**production currently runs 3**). Check the live value before answering a
retention question — `.env` on the prod host is authoritative, not this table.

Two things that used to be true and are worth un-learning:

- There is no separate 14-day file window and 30-day `CanvasData` window. Those
  disagreed — `expires_at` promised callers 30 days while the GC deleted at 14
  (7 under disk pressure), so a partner fetching on day 20 got a 404. All four
  sweeps now run off the single value above.
- `EXPORT_RETENTION_DAYS_UNDER_PRESSURE` **defaults to the same number**, so
  disk pressure no longer silently shortens retention below the `expires_at`
  already sent to a partner. Setting it lower re-opens that gap deliberately.

Since migration `0012`, `UploadedFile.expires_at` / `ExportedResult.expires_at`
are **stamped on the row at creation** and swept on that stored value — not
recomputed at sweep time. So lowering the env var no longer acts retroactively
on files whose expiry was already promised. **Deploy the migration before
lowering it.**

| Artifact | Where | Personal data? | Created by | Retention | Deleted by |
|---|---|---|---|---|---|
| Uploaded photos | `UPLOADS_DIR/<order_id>/` + `UploadedFile` rows | **Yes** — customer photos + `original_filename` | Chunked upload API | `EXPORT_RETENTION_DAYS`, stamped on the row | `garbage_collector_task` (daily 02:00 UTC); immediately by order purge |
| Chunk staging | `UPLOADS_DIR/.chunks/<upload_id>/` | Yes (partial photo bytes) | Chunked upload (in progress) | 24 h if never completed | GC stale-chunk sweep; order purge |
| Async render output | `EXPORTS_DIR/<job_id>/` + `RenderJob.output_paths` | Yes (composited photos) | `render_canvas_task` | `CanvasData.expires_at` = `created_at + EXPORT_RETENTION_DAYS` — the same value sent as webhook `expires_at` | GC; order purge |
| Orphaned export dirs | `EXPORTS_DIR/<uuid>/` with no DB row | Yes (composited photos) | Renders killed mid-flight (OOM/SIGKILL) whose rows later cascaded away | retention + 1 day | `services/orphan_exports.py`, gated by `GC_ORPHAN_SWEEP` (`off`/`dry_run`/`delete`; **defaults to `dry_run` — reports only, deletes nothing**) |
| Sync render output | `ExportedResult` rows + files | Yes | `GenerateLayoutView` | `expires_at` stamped on the row (`is_deleted` soft-delete, tombstone dropped later) | GC; order purge (hard-delete) |
| Design state | `CanvasData` (incl. `editor_state` dataURL previews, `render_state`) | Yes (photo thumbnails, transforms) | Autosave + submit | `EXPORT_RETENTION_DAYS` | GC row delete; order purge |
| Embed sessions | `EmbedSession` rows (`order_id`, `callback_url`) | Partial (order id, caller URL) | `POST /api/embed/session` | 2 h token validity (sliding, extended while editing); **rows themselves persist** | Order purge. *Gap: no scheduled sweep of expired rows — see below.* |
| API audit trail | `APIRequest` rows (`ip_address`, `user_agent`) | **Yes** (IP) | `APIRequestLoggingMiddleware` (one row per non-exempt API call) | `API_AUDIT_RETENTION_DAYS`, default **90** — deliberately outlives the data it describes, so "who touched this order" is still answerable | `garbage_collector_task`, independent of file retention |
| Client file cache | Browser IndexedDB (`file-store.ts`) | Yes (original photos) | Editor (B1 persistence) | Device-local; stale orders pruned after 7 days, evicted under quota pressure | Client-side prune (Phase 3); never leaves the device |
| Orientation detection | — | Yes (transient image bytes) | `POST /api/orientation/detect` | **Nothing persisted** — inference is stateless | n/a |
| HEIC conversion | — | Yes (transient image bytes) | `POST /api/heic/convert` | **Nothing persisted** — decode-and-return | n/a |

## On-demand erasure — `DELETE /api/ops/orders/<order_id>/purge`

Ops-only (Phase 4). Hard-deletes everything above tied to an `order_id` —
uploads, exports, `CanvasData` (cascades `RenderJob`), and `EmbedSession` —
**rows and files**, immediately, without waiting for the retention timer.

- Scoped to all API keys for the order by default; `?api_key=<name>` narrows to
  one tenant. `?force=true` overrides the guard that blocks purge while a
  render is still queued/processing.
- Shared upload files still referenced by another surviving order are kept.
- Returns per-artifact counts, the API keys touched, and any best-effort file
  errors. Never on the embed-proxy allowlist (ops surface only).

**How the purge finds a customer's files** (fixed 2026-07-26, migration `0011` —
history in [`DPDP_ERASURE_GAP_PRD.md`](DPDP_ERASURE_GAP_PRD.md)):

- Primarily via **`UploadedFile.order_id`**, recorded at upload time from the
  `X-Order-ID` header or the request. This is the linkage that makes erasure
  provable — it does not depend on canvas state surviving.
- Plus `CanvasData.image_paths` / `render_state['image_paths']` for export
  files and older rows.

Previously only the second route existed, and autosave overwrote `image_paths`
with `[]` every 2 seconds, so the purge deleted the rows, reported
`files_deleted: 0` and left the photographs on disk. Autosave no longer writes
that field unless the caller actually supplies paths.

The response now reports **`erasure_complete`** and **`unlocated_upload_rows`**;
an incomplete erasure also logs a warning. A bare `files_deleted: 0` is no
longer indistinguishable from success.

**Uploads are stored per order** — `UPLOADS_DIR/<order_id>/` — so ownership is
visible in the path. The purge deletes that directory outright, which means it
erases what is actually on disk rather than only what the database can
enumerate: a file whose row was lost is still found. Direct partner API uploads
have no order and go to a shared `_no_order/` bucket, excluded from the
directory delete and cleaned by the GC on age.

**Verification sweep.** After the deletes commit, the purge re-checks every path
and directory it tried to remove, retries once, and returns anything still there
as `residual_files` / `residual_dirs`. Those feed `erasure_complete`, so a
deletion that silently failed (permission error, lock) can no longer report
success.

No legacy rows remain: the instance was reset to a fresh start before `0011`
landed, so there was nothing to backfill.

> **Careful:** `order_id=''` is the legitimate value for direct partner API
> uploads, which have no order context. Never write a cleanup that deletes rows
> by blank `order_id` — it would destroy valid current uploads.

## Known gaps (recommended follow-ups)

- **`EmbedSession` rows** are never swept after their 2 h token expiry — add a
  GC pass deleting sessions older than ~30 days. Still open. The rows hold an
  `order_id` and the caller's `callback_url`, not customer photos, so the
  exposure is low, but it is unbounded growth of order-linked data.
- **`GC_ORPHAN_SWEEP` is still `dry_run` in production** — stranded export
  directories are counted and reported but not deleted, so customer photos in
  them outlive the retention window. Read a few nights of
  `garbage_collector.stats.orphan_exports` on `GET /api/celery/monitor/`, then
  set it to `delete`. It is the one sweep that deletes on the *absence* of a DB
  row, which is why it ships disarmed.

### Closed

- **`APIRequest` unbounded growth** — closed by migration `0014`. The rows are
  now swept on `API_AUDIT_RETENTION_DAYS` (90). Note the table was also *empty*
  until `0014`: the model shipped in the initial commit with nothing writing to
  it, so `APIRequest.objects.count()` read 0 for every key forever. During a
  leaked-key investigation that reads as proof a credential was never used, when
  it is only proof nothing was recorded.
- **Retention clock disagreement** (14 d files vs 30 d `expires_at`) — closed by
  migration `0012`. See the note at the top.

> **Audit blind spots are deliberate but load-bearing.** `/api/health`,
> `/api/config`, `/api/render-status/` and chunk `PUT`s are exempt from audit
> logging (`AUDIT_EXEMPT_PREFIXES` in `api/middleware.py`) — render-status alone
> produced ~1,500 rows/hour during one large job. The `/complete` call that
> finalises a stored file *is* recorded. If you add an endpoint that touches
> customer data, make sure no exemption matches it, or you create a silent gap
> in the erasure trail. `services/tests/test_audit_middleware.py` pins both
> directions.
