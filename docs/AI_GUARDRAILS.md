# AI Guardrails — Product Editor

Development rules and safety guidelines for AI agents working on this project.

**Last verified against the code: 2026-08-14** (`main` @ `79104d0`, migration
`0014`). This file is the short list of things that have actually bitten us;
[`../CLAUDE.md`](../CLAUDE.md) is the full architectural reference and wins on
any disagreement. If you correct a rule here, check whether CLAUDE.md says the
same thing in its own words.

---

## General Rules

- **No AI image *manipulation***: Do not re-introduce background removal, product detection, or generative editing unless explicitly requested. The one sanctioned ML feature is **auto-orientation** (v1.11) — MediaPipe Pose Landmarker at `POST /api/orientation/detect`, which only *reads* the photo to return a rotation and persists nothing. Inference that changes the customer's pixels is still out of scope.
- **Maintain multi-surface support**: Ensure changes do not break the ability to handle layouts with multiple surfaces (e.g., front/back). This now includes *materialized* surfaces — a calendar layout is one authored template that `services/calendar_layout.py::materialize_surfaces` expands into 12 month-surfaces at render time — so a change to surface handling has to be checked against that path as well as plain front/back layouts.
- **TypeScript Strictness**: `tsconfig.json` is in full strict mode (v1.9). Always fix linter errors and maintain type safety in the frontend. Unclosed template literals in JSX `className` strings cause cascade errors — check every `` className={`...`} `` for a matching closing backtick. Run `pnpm typecheck` before pushing.
- **No direct DOM manipulation**: drive UI through React state/props/refs. No `innerHTML`, no `document.getElementById` to build or mutate UI. Exempt: off-screen canvases for image work, Fabric.js roots held via `useRef`, transient `<a>` for downloads, `window`/`document` listeners in an effect with cleanup.

---

## Backend Guardrails (Django)

- **Path Safety**: Always use `_is_path_safe` or equivalent validation when handling file paths from requests to prevent path traversal.
- **Authentication**: All new endpoints must require appropriate permissions (`IsAuthenticatedWithAPIKey`, `is_ops_team` for ops endpoints).
- **Resource Management**: Large image processing tasks must run in Celery workers, never in a Gunicorn thread. Workers are memory-limited to **2 GB per replica** and concurrency is **auto-detected from CPU count** (no `CELERY_CONCURRENCY` in compose) — 2 render slots on the current 2-core prod box. Scale out with `docker compose up -d --scale celery-worker-standard=4` rather than raising per-replica concurrency; if you do cap it via `CELERY_CONCURRENCY`, keep the memory-per-slot headroom in mind (Pillow compositing is the consumer). The one deliberate exception to "never in a Gunicorn thread" is orientation inference (~30–150 ms) — see the auto-orientation note above for why it is inline.

### Async Task Rules (Celery)

- **Never mix `autoretry_for` and `self.retry()`** on the same task. Pick one. This codebase uses `self.retry(exc=exc, countdown=delay)` exclusively so the DB `retry_count` and Celery's internal retry counter stay in sync.
- **`SoftTimeLimitExceeded` must skip retries** — handle it the same way as `MemoryError`: mark the job failed immediately, do not call `self.retry()`.
- **`MemoryError` must skip retries** — the worker process is out of memory; retrying would immediately OOM again.
- **Retry delays use exponential backoff**: `delay = (2 ** retry_number) * 2` → 2 s, 4 s, 8 s. `retry_number = self.request.retries` (0-based).
- **Caller webhook is a separate task** (`notify_caller_webhook_task`). Never call the caller's `callback_url` inside `render_canvas_task` — it must not block the render worker slot and must retry independently (up to 5×). Only dispatched when `canvas.callback_url` is set; direct/dashboard callers don't enqueue it at all.
- **`callback_url` is stored on `CanvasData`** at submission time (propagated from `EmbedSession` via `X-Callback-URL` header), not passed through the task chain. The webhook task reads it from the DB.
- **`on_commit` dispatch** — task dispatch is always inside `transaction.on_commit()` in `views.py`. Never dispatch a Celery task directly within a DB transaction.
- **Redis failure on dispatch must fail the job immediately** — the `on_commit` handler catches the dispatch exception, sets `RenderJob.status = 'failed'`, and records the error. The job must never be left silently in `queued`.
- **`celery.py` must not hardcode broker or result-backend URLs** — they come exclusively from `CELERY_BROKER_URL` and `CELERY_RESULT_BACKEND` Django settings.
- **`celery-beat` must not run DB migrations** — the entrypoint branches for worker/beat exit before the migration block. Only the Gunicorn/backend container runs `migrate --noinput`.
- **Task routing** — all three tasks (`render_canvas_task`, `notify_caller_webhook_task`, `garbage_collector_task`) route to `standard`. Never route tasks implicitly — keep explicit routes.
- **`priority` has no producer, and the worker drains it anyway.** There is exactly one worker service (`celery-worker-standard`), consuming `-Q priority,standard`. The second worker that once served the CMYK express path was removed in Aug 2026 — nothing had routed to `priority` since v1.8, so the container held a full Django + Pillow + MediaPipe process resident having never executed a task. The surviving worker listens to both queues **as a safety net**: `apply_async(queue='priority')` is still documented as an opt-in, and with no consumer such a task would sit in Redis forever — the render would silently never happen, with no error anywhere. **This is not a QoS tier.** Celery round-robins across `-Q` queues, so naming `priority` first buys no precedence. Genuine express handling needs a second worker *plus* a dispatch site that routes to it; do not assume the current config provides it.
- **GC skips manual-review orders** — `garbage_collector_task` must call `_is_manual_review_path(path_str, manual_review_order_ids)` before deleting any file. Files tied to a `requires_manual_review=True` order must never be auto-deleted.
- **The GC must stay time-limited** — `garbage_collector_task` carries `soft_time_limit=3300` / `time_limit=3600` so a hung sweep can never permanently occupy a worker slot. Don't remove them.
- **Poison-pill guard counts only genuine broker redeliveries.** `render_canvas_task` aborts after 3 crash-redeliveries, detected via `delivery_info.redelivered` — a worker crash under `acks_late` redelivers the SAME message (`redelivered=True`, retries frozen), whereas `self.retry()` publishes a NEW one (`redelivered=False`, retries bumped). Never conflate the two, or normal retries will be mistaken for a poison pill and abort a healthy job.
- **Never `requests.post` a customer `callback_url` directly** — always go through `services/url_safety.py::post_webhook_safely`, which pins the socket to the pre-validated IP (so DNS can't rebind between validation and send) and sets `allow_redirects=False`.

### Data Integrity

- **`order_id` upsert** — `CanvasData` is always written via `update_or_create(order_id=order_id, defaults={...})`. Never use `create()` for order-linked records; operator retries and customer resubmissions must not crash with a unique-constraint error.
- **`celery_task_id` nullable** — the field is `null=True`; it is set to `None` at creation and populated after the task is enqueued. Never use `''` (empty string) as a default.

---

### API reference schema (drf-spectacular → Scalar at `/docs/api/`)

- **A handler with no `@extend_schema` is dropped from the reference, not just left thin.** drf-spectacular logs `unable to guess serializer … Ignoring view for now` and the operation renders with no request or response body. The decorator also needs an explicit `request=` on any body-carrying method and an explicit `responses=` — without them the same error fires with the decorator present.
- **Never configure auth schemes in `SPECTACULAR_SETTINGS`.** `SECURITY_DEFINITIONS` is a *drf-yasg* key; drf-spectacular ignores it silently, which left every operation referencing a `BearerAuth` scheme that was never defined — invalid OpenAPI and an empty Authorize dropdown. Schemes live in `api/schema.py` as `OpenApiAuthenticationExtension` subclasses, registered from `ApiConfig.ready()`.
- **`FontsView`, `CalendarStylesView` and `HolidaysView` are `AllowAny` with the ops check inside the handler.** The generator reads `permission_classes`, so it will advertise their destructive methods as needing no credentials. Every operation on these three must set `auth=` explicitly — `auth=[]` for public reads, `OPS_WRITE_AUTH` for ops writes.
- **Validate before pushing** — not covered by CI, and the backend image bakes source via `COPY`, so build first: `docker-compose build backend && docker-compose run --rm --entrypoint /opt/venv/bin/python backend manage.py spectacular --validate --fail-on-warn --file /dev/null`. Must exit 0 silently.

---

## Frontend Guardrails (Next.js/Fabric.js)

- **Object Cleanup**: Always dispose of Fabric canvas instances and revoke Object URLs to prevent memory leaks.
- **State Sync**: Keep the Fabric canvas state in sync with the React state (see `handleFabricChange` in the editor page).
- **`isExport` flag**: Frame outlines and preview-only overlays are gated by `!isExport`. Never render these elements in the download path. Verify both `FabricEditor.tsx` and `fabric-renderer.ts` respect this flag consistently.
- **Responsive Design**: Ensure the editor remains functional on various screen sizes using the glassmorphism aesthetic established in the project.
- **Qty enforcement is deliberately asymmetric**: the `?qty=N` URL param (single-surface products only) is a **hard cap going over** and **warn-and-proceed going under**. Over-upload offers *Keep first N* / *Choose again* — there is no proceed-with-all path, so a submit can never carry more photos than were ordered. Under-upload shows the auto-fill / pick-to-fill banner plus a `QtyShortfallWarning` notice in the pre-submit modal, and still submits. **Do not make under-upload blocking**: qty arrives in a URL the customer's browser can edit, so a wrong value from the caller would strand a real order at checkout. The comparison itself lives in one pure function — `checkOrderQty` in `src/lib/submit-guards.ts`, pinned by `src/lib/__tests__/submit-guards.test.ts` — so the rule has one home rather than being re-derived at each call site. Enforcement is **client-side only**; nothing server-side validates qty yet.
- **"Add Files" appends, never replaces**: a native `<input type=file>` selection is not cumulative — each pick contains only that pick's files. `handleFileChange` must merge onto the existing selection. Feeding the raw pick into `setFiles()` wipes every earlier canvas (a live bug until PR #24). Multi-surface layouts are excluded from the merge — each surface holds exactly one photo.
- **Low-res warning must stay non-blocking**: `src/lib/dpi-utils.ts` estimates effective print DPI (`DPI_WARN=150` / `DPI_CRITICAL=100`, strict `<`). It mirrors the placement maths in `fabric-renderer.ts` and `engine.py` exactly — **if you change placement maths in either renderer, update `dpi-utils.ts` too**, or the warning lies. Card pills and the pre-submit modal notice warn and proceed; they never block submit.
- **No CMYK / ICC soft-proof warnings**: the RGB→CMYK→RGB pipeline was removed entirely in v1.8 (`layout_engine/cmyk.py`, `icc_profiles/`, `_generate_soft_proof_for_surface`, and the `CanvasData.soft_proof` field all deleted). Output is PNG (default) or PDF. Do not re-add a colour-space warning to the checkout flow — colour is handled invisibly by `services/image_loader.py`, which colour-manages every source photo ICC→sRGB at load time and tags output PNGs with an explicit sRGB profile. **Never call `Image.open(...).convert("RGBA")` directly on a customer photo** — it silently discards the embedded profile and shifts colours in print.

---

## Data Consistency

- Layout JSON files in `storage/layouts` must follow the established schema (canvas dimensions in mm/px, frame coordinates, DPI).
- **A layout's identifier is its filename stem**, never the `name` field inside the JSON. `ListLayoutsView` and `LayoutManagementView` both overwrite `data["name"]` with the filename for exactly this reason. When the two diverged in case (`classic_A4.json` carrying `"name": "classic_a4"`), the layout became unopenable and undeletable **on production Linux only** — the dev Mac's filesystem is case-insensitive. Assume prod is stricter than your machine.
- `metadata` in layouts must remain an object or array as expected by the management views.
- Never add a new field to `CanvasData` without a corresponding migration. Current latest: **`0014_audit_trail`**. Run migrations only from the `backend` (Gunicorn) container — never from a worker or beat container.
- **Don't cross the `editor_state` / `render_state` streams** (post-`0008`): `editor_state` is frontend-owned, written ONLY by `CanvasStateView` (autosave). `render_state` is pipeline-owned, written ONLY by `EditorRenderView` at submit. They were one field, and the two writers clobbered each other — submit wiped the customer's autosaved design, and a post-submit autosave could strip a queued job's payload.
- **`CanvasStateView.put` must keep `image_paths` out of `update_or_create`'s `defaults`.** Writing `image_paths or []` there blanked recorded paths every 2 s, which is what made DPDP erasure report `files_deleted: 0` while photos stayed on disk (migration `0011`). The column carries a model-level `default=list` (`0013`) so INSERT still works — a model default applies on INSERT only, never UPDATE.
