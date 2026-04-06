# AI Architecture — Product Editor

High-level architecture overview for AI agents working on this codebase.

## System Overview

The Product Editor is a full-stack print-automation platform. Customers upload images via an embedded canvas editor; post-checkout the system renders high-resolution print files asynchronously and pushes them directly to the production estimator (OMS) — replacing the manual preflight team entirely.

---

## Component Map

### 1. Frontend (Next.js 16, App Router)

- **Editor page**: `frontend/nextjs/src/app/editor/layout/[name]/page.tsx` — main state machine: file upload, qty enforcement (`?qty=N` URL param), CMYK colour-space detection and warning, canvas orchestration, embed submit flow.
- **Fabric canvas**: `FabricEditor.tsx` — Fabric.js 7.2 interactive editor with paper overlay (evenodd punch-holes for frame shapes) and subtle frame outlines. Outlines are gated by `!isExport` — they never appear in downloaded print files.
- **Off-screen renderer**: `fabric-renderer.ts` — generates preview PNGs; same `isExport` flag omits preview-only elements from download output.
- **Sidebar**: `CanvasEditorSidebar.tsx` — upload zone, fit-mode controls, layer panel. Shapes tab removed (shapes achievable via image upload). Padding kept compact by design.
- **Types**: `types.ts` — shared TypeScript interfaces for editor state.

### 2. Backend (Django 5 + DRF)

- **API views**: `backend/django/api/views.py`
  - `GenerateLayoutView` — routes to sync (`_handle_sync`) or async (`_handle_async`) based on `order_id` presence.
  - `RenderStatusView` — polls `RenderJob` with Redis cache (3s TTL queued, 10s processing, 300s terminal).
  - `CeleryMonitorView` — ops-only endpoint for queue depth and worker health.
- **Async tasks**: `backend/django/api/tasks.py`
  - `render_canvas_task` — uses `self.retry()` (not `autoretry_for`) so DB `retry_count` and Celery's retry counter stay in sync. Handles `MemoryError` and `SoftTimeLimitExceeded` without retrying.
  - `push_to_production_estimator_task` — OMS notification as a **separate** Celery task so it never blocks the render worker slot. Retries 5× independently. Fires `callback_url` on success.
  - `garbage_collector_task` — daily 02:00 UTC cleanup. Skips files whose path contains a `requires_manual_review` order_id.
- **Models**: `backend/django/api/models.py` — `APIKey`, `EmbedSession`, `CanvasData` (with `callback_url` + upserted via `update_or_create`), `RenderJob`, `UploadedFile`, `ExportedResult`.
- **Layout engine**: `backend/django/layout_engine/engine.py` — Pillow high-res renderer. PNG and CMYK TIFF (ISOcoated_v2 ICC soft-proof; three-file output: PNG + TIFF CMYK + preview PNG).
- **Celery app**: `backend/django/product_editor/celery.py` — broker and result-backend come exclusively from `CELERY_*` Django settings (no hardcoded URLs). Routes: `priority` (soft-proof/express), `standard` (regular exports).

### 3. Async Queue Architecture

```
HTTP request (order_id present)
      │
      ▼
 Django API  ──transaction.on_commit──▶  Redis
 (202 resp)                              ├── priority queue ──▶ celery-worker-priority
                                         └── standard queue ──▶ celery-worker-standard
                                                   │
                                           render_canvas_task
                                                   │
                                    ┌──────────────▼──────────────┐
                                    │  push_to_production_        │──▶ OMS API + callback_url
                                    │  estimator_task             │
                                    └─────────────────────────────┘
```

- Two dedicated worker services — priority queue never starves behind standard backlog.
- Concurrency = 2 per worker container (512 MB limit → ~256 MB per task slot).
- `celery-beat` skips DB migrations on startup; only the `backend`/Gunicorn container runs `migrate`.
- Redis failure during `on_commit` dispatch sets job to `failed` immediately — never silently stuck in `queued`.

### 4. Full End-to-End Data Flow

1. Customer opens editor embed on printo.in / Inkmonk.com.
2. Real API key exchanged for short-lived `EmbedSession` token.
3. Customer uploads images → qty enforcement: under-upload prompts auto-fill or pick-to-fill; over-upload triggers confirmation modal. CMYK warning shown if ICC profile detects non-CMYK file.
4. Canvas preview rendered client-side with Fabric.js; frame outlines visible in editor, absent in export.
5. Customer approves and checks out → `POST /api/layout/generate` with `order_id`.
6. Django upserts `CanvasData`, creates `RenderJob`, enqueues task via `on_commit`.
7. Worker renders PNG or CMYK TIFF → writes to `EXPORTS_DIR`.
8. `push_to_production_estimator_task` fires → OMS notified → `callback_url` called.
9. Caller polls `GET /api/render-status/{job_id}/` or receives webhook.

---

## Technology Stack Summary

| Layer | Technology | Version |
|---|---|---|
| Frontend framework | Next.js (App Router) | 16 |
| Frontend language | TypeScript | 5.7 |
| Canvas library | Fabric.js | 7.2 |
| Backend framework | Django + DRF | 5.0.6 |
| Image processing | Pillow | latest |
| Async queue | Celery | 5 |
| Queue broker / cache | Redis | 7 |
| Database | PostgreSQL | 16 |
| Reverse proxy | Traefik | v3 |
| Container runtime | Docker Compose | v2 |
