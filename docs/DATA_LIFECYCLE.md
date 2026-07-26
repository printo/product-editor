# Data Lifecycle & Retention

What personal/customer data the Product Editor stores, where it lives, and how
it is deleted. Supports DPDP compliance (data minimisation + right to erasure).

| Artifact | Where | Personal data? | Created by | Retention | Deleted by |
|---|---|---|---|---|---|
| Uploaded photos | `UPLOADS_DIR/` + `UploadedFile` rows | **Yes** — customer photos + `original_filename` | Chunked upload API | ~14 days (7 under storage pressure) | `garbage_collector_task` (daily 02:00 UTC); immediately by order purge |
| Chunk staging | `UPLOADS_DIR/.chunks/<upload_id>/` | Yes (partial photo bytes) | Chunked upload (in progress) | 24 h if never completed | GC stale-chunk sweep; order purge |
| Async render output | `EXPORTS_DIR/<job_id>/` + `RenderJob.output_paths` | Yes (composited photos) | `render_canvas_task` | Until `CanvasData.expires_at` (last autosave + 30 days) | GC; order purge |
| Sync render output | `ExportedResult` rows + files | Yes | `GenerateLayoutView` | ~14 days (`is_deleted` soft-delete then swept) | GC; order purge (hard-delete) |
| Design state | `CanvasData` (incl. `editor_state` dataURL previews, `render_state`) | Yes (photo thumbnails, transforms) | Autosave + submit | 30-day sliding (from last autosave) | GC row delete; order purge |
| Embed sessions | `EmbedSession` rows (`order_id`, `callback_url`) | Partial (order id, caller URL) | `POST /api/embed/session` | 2 h token validity; **rows currently persist** | Order purge. *Gap: no scheduled sweep of expired rows — see below.* |
| API request log | `APIRequest` rows (`ip_address`, `user_agent`) | **Yes** (IP) | Rate-limit middleware | **Unbounded** | *Gap: no sweep — see below.* |
| Client file cache | Browser IndexedDB (`file-store.ts`) | Yes (original photos) | Editor (B1 persistence) | Device-local; stale orders pruned after 7 days, evicted under quota pressure | Client-side prune (Phase 3); never leaves the device |
| Orientation detection | — | Yes (transient image bytes) | `POST /api/orientation/detect` | **Nothing persisted** — inference is stateless | n/a |

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

**Verification sweep.** After the deletes commit, the purge re-checks every path
and directory it tried to remove, retries once, and returns anything still there
as `residual_files` / `residual_dirs`. Those feed `erasure_complete`, so a
deletion that silently failed (permission error, lock) can no longer report
success. It verifies what the purge *knew about* — uploads are stored flat with a
random filename prefix, so ownership comes from `UploadedFile.order_id`, not the
path.

No legacy rows remain: the instance was reset to a fresh start before `0011`
landed, so there was nothing to backfill.

> **Careful:** `order_id=''` is the legitimate value for direct partner API
> uploads, which have no order context. Never write a cleanup that deletes rows
> by blank `order_id` — it would destroy valid current uploads.

## Known gaps (recommended follow-ups)

- **`EmbedSession` rows** are never swept after their 2 h token expiry — add a
  GC pass deleting sessions older than ~30 days.
- **`APIRequest` rows** grow unbounded — add a ~90-day retention sweep (IP +
  user-agent are personal data under DPDP).
