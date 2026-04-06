# AI Guardrails — Product Editor

Development rules and safety guidelines for AI agents working on this project.

---

## General Rules

- **No AI Processing**: Do not re-introduce background removal, product detection, or other AI-based image processing features unless explicitly requested.
- **Maintain multi-surface support**: Ensure changes do not break the ability to handle layouts with multiple surfaces (e.g., front/back).
- **TypeScript Strictness**: Always fix linter errors and maintain type safety in the frontend. Unclosed template literals in JSX `className` strings cause cascade errors — check every `` className={`...`} `` for a matching closing backtick.

---

## Backend Guardrails (Django)

- **Path Safety**: Always use `_is_path_safe` or equivalent validation when handling file paths from requests to prevent path traversal.
- **Authentication**: All new endpoints must require appropriate permissions (`IsAuthenticatedWithAPIKey`, `is_ops_team` for ops endpoints).
- **Resource Management**: Large image processing tasks must run in Celery workers, never in a Gunicorn thread. Workers are memory-limited to 512 MB; concurrency is fixed at 2 per container (~256 MB per task slot). Do not raise concurrency without raising the memory limit proportionally.

### Async Task Rules (Celery)

- **Never mix `autoretry_for` and `self.retry()`** on the same task. Pick one. This codebase uses `self.retry(exc=exc, countdown=delay)` exclusively so the DB `retry_count` and Celery's internal retry counter stay in sync.
- **`SoftTimeLimitExceeded` must skip retries** — handle it the same way as `MemoryError`: mark the job failed immediately, do not call `self.retry()`.
- **`MemoryError` must skip retries** — the worker process is out of memory; retrying would immediately OOM again.
- **Retry delays use exponential backoff**: `delay = (2 ** retry_number) * 2` → 2 s, 4 s, 8 s. `retry_number = self.request.retries` (0-based).
- **OMS push is a separate task** (`push_to_production_estimator_task`). Never call the OMS API inside `render_canvas_task` — it must not block the render worker slot and must retry independently (up to 5×).
- **`callback_url` is stored on `CanvasData`** at submission time, not passed through the task chain. The push task reads it from the DB.
- **`on_commit` dispatch** — task dispatch is always inside `transaction.on_commit()` in `views.py`. Never dispatch a Celery task directly within a DB transaction.
- **Redis failure on dispatch must fail the job immediately** — the `on_commit` handler catches the dispatch exception, sets `RenderJob.status = 'failed'`, and records the error. The job must never be left silently in `queued`.
- **`celery.py` must not hardcode broker or result-backend URLs** — they come exclusively from `CELERY_BROKER_URL` and `CELERY_RESULT_BACKEND` Django settings.
- **`celery-beat` must not run DB migrations** — the entrypoint branches for worker/beat exit before the migration block. Only the Gunicorn/backend container runs `migrate --noinput`.
- **Task routing** — `render_canvas_task` routes to `priority` for soft-proof, `standard` otherwise. `push_to_production_estimator_task` always routes to `priority`. `garbage_collector_task` routes to `standard`. Never route tasks implicitly — keep explicit routes in `celery.py`.
- **GC skips manual-review orders** — `garbage_collector_task` must check `if any(oid in path_str for oid in manual_review_order_ids)` before deleting any file. Files tied to a `requires_manual_review=True` order must never be auto-deleted.

### Data Integrity

- **`order_id` upsert** — `CanvasData` is always written via `update_or_create(order_id=order_id, defaults={...})`. Never use `create()` for order-linked records; operator retries and customer resubmissions must not crash with a unique-constraint error.
- **`celery_task_id` nullable** — the field is `null=True`; it is set to `None` at creation and populated after the task is enqueued. Never use `''` (empty string) as a default.

---

## Frontend Guardrails (Next.js/Fabric.js)

- **Object Cleanup**: Always dispose of Fabric canvas instances and revoke Object URLs to prevent memory leaks.
- **State Sync**: Keep the Fabric canvas state in sync with the React state (see `handleFabricChange` in the editor page).
- **`isExport` flag**: Frame outlines and preview-only overlays are gated by `!isExport`. Never render these elements in the download path. Verify both `FabricEditor.tsx` and `fabric-renderer.ts` respect this flag consistently.
- **Responsive Design**: Ensure the editor remains functional on various screen sizes using the glassmorphism aesthetic established in the project.
- **Qty enforcement**: The `?qty=N` URL param is the source of truth for required image count. Under-upload shows auto-fill / pick-to-fill prompts; over-upload shows a confirmation modal. Do not remove or weaken this gate.
- **CMYK warning**: ICC profile detection warnings are shown before checkout, not after. Do not move them post-checkout.

---

## Data Consistency

- Layout JSON files in `storage/layouts` must follow the established schema (canvas dimensions in mm/px, frame coordinates, DPI).
- `metadata` in layouts must remain an object or array as expected by the management views.
- Never add a new field to `CanvasData` without a corresponding migration. Current latest: `0007_canvasdata_callback_url`.
