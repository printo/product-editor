# AI File Index — Product Editor

Map of important files and directories for AI agents working on this codebase.

---

## Backend (Django)

`backend/django/api/`

- `views.py` — API endpoints: `GenerateLayoutView` (sync + async),
  `RenderStatusView` (Redis-cached polling), `CeleryMonitorView` (ops-only).
  `_handle_async` uses `update_or_create` on `order_id`; `on_commit` dispatches
  to Celery; Redis failure sets job to `failed` immediately.
- `tasks.py` — Three Celery tasks: `render_canvas_task` (retries 3× via
  `self.retry()`; skips retry on `MemoryError` and `SoftTimeLimitExceeded`),
  `push_to_production_estimator_task` (separate task, retries 5×, fires
  `callback_url` on success), `garbage_collector_task` (daily GC, skips
  `requires_manual_review` orders).
- `models.py` — `APIKey`, `EmbedSession`, `CanvasData` (upserted via `order_id`,
  stores `callback_url`), `RenderJob`, `UploadedFile`, `ExportedResult`.
- `middleware.py` — Request logging and rate limiting.
- `validators.py` — Image upload validation (type, size, dimensions).
- `migrations/`
  - `0001_initial.py` — Initial schema
  - `0002_apikey_is_ops_team.py`
  - `0003_embedsession.py`
  - `0004_rename_…_idx.py`
  - `0005_canvasdata_renderjob_and_more.py` — `CanvasData` + `RenderJob` models
  - `0006_allow_null_celery_task_id.py` — `celery_task_id` nullable
  - `0007_canvasdata_callback_url.py` — `callback_url` URLField on `CanvasData`

`backend/django/layout_engine/`

- `engine.py` — Pillow high-res renderer. Outputs PNG, CMYK TIFF (ISOcoated_v2),
  and preview PNG. `isExport` flag controls preview-only elements.

`backend/django/product_editor/`

- `settings.py` — Global Django + Celery configuration. `CELERY_*` settings are
  the sole source for broker/result-backend URLs — never hardcoded in
  `celery.py`.
- `celery.py` — Celery app init. Reads broker/backend from `CELERY_*` Django
  settings. Explicit task routes: `render_canvas_task` → `standard`/`priority`;
  `push_to_production_estimator_task` → `priority`; `garbage_collector_task` →
  `standard`.

`backend/django/`

- `entrypoint.sh` — Docker entrypoint. Worker/beat branches exit before the
  migration block. Only the Gunicorn path runs `migrate --noinput`. Reads
  `CELERY_CONCURRENCY` and `CELERY_QUEUE` env vars.
- `requirements.txt` — Python dependencies.

---

## Frontend (Next.js)

`frontend/nextjs/src/app/editor/layout/[name]/`

- `page.tsx` — Main state machine: file upload, qty enforcement (`?qty=N` URL
  param), CMYK colour-space detection and warning, canvas orchestration, embed
  submit flow.
- `FabricEditor.tsx` — Fabric.js 7.2 interactive editor with paper overlay
  (evenodd punch-holes for frame shapes) and subtle frame outlines. Outlines
  gated by `!isExport` — absent in downloaded print files.
- `fabric-renderer.ts` — Generates preview PNGs. Same `isExport` flag omits
  preview-only elements from download output.
- `CanvasEditorSidebar.tsx` — Upload zone, fit-mode controls, layer panel.
  Shapes tab removed.
- `types.ts` — Shared TypeScript interfaces for editor state.

`frontend/nextjs/src/lib/`

- `image-utils.ts` — High-efficiency metadata extraction with `WeakMap` caching
  and `URL.createObjectURL` optimization.
- `zip-utils.ts` — Optimized ZIP generation with parallel chunking and `STORE`
  compression for large batches.
- `layout-utils.ts` — Layout normalization and surface filtering logic.
- `fabric-utils.ts` — Fabric.js helper functions (DPI conversion, relative
  clipping).

`frontend/nextjs/`

- `package.json` — Frontend dependencies (Next.js 16, React 19, TypeScript 5.7,
  Fabric.js 7.2, Tailwind 3.4).

---

## Infrastructure

`docker-compose.yml` — Defines all services:

- `backend` — Django/Gunicorn (runs migrations on startup)
- `frontend` — Next.js
- `celery-worker-priority` — `CELERY_QUEUE=priority`, `CELERY_CONCURRENCY=2`,
  `memory: 512M`
- `celery-worker-standard` — `CELERY_QUEUE=standard`, `CELERY_CONCURRENCY=2`,
  `memory: 512M`
- `celery-beat` — Periodic scheduler (daily GC at 02:00 UTC; does NOT run
  migrations)
- `redis` — Broker, result backend, status-polling cache
- `db` — PostgreSQL 16
- `proxy` — Traefik v3 + Let's Encrypt TLS

`storage/`

- `layouts/` — JSON layout templates
- `masks/` — SVG/PNG mask files
- `uploads/` — Customer-uploaded source images (30-day expiry)
- `exports/` — Generated render outputs (14-day expiry; 7-day when disk > 80%)

`README.md` — Project documentation, quick start, API reference, deployment
guide. `AI_ARCHITECTURE.md` — High-level architecture overview for AI agents.
`AI_PROJECT_CONTEXT.md` — Business logic and operational context. `PRD.md` —
Product requirements document (v1.5).
