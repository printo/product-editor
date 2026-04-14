# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Product Editor is a full-stack print-automation platform for Printo.in. Customers upload and compose photos on an interactive canvas editor; post-checkout, the system asynchronously renders high-resolution print files (PNG or CMYK TIFF) and pushes them to the production estimator (OMS), replacing manual preflight.

## Commands

### Frontend (Next.js)
```bash
cd frontend/nextjs
npm run dev       # Development server
npm run build     # Production build
npm run lint      # ESLint
```

### Backend (Django)
```bash
cd backend/django
python manage.py migrate
python manage.py showmigrations
python manage.py shell
```

### Docker (primary workflow)
```bash
docker-compose up -d
docker-compose exec backend python manage.py migrate   # Always run migrations via backend container
docker-compose ps celery-worker-priority celery-worker-standard
docker-compose logs -f <service>
```

### Utilities
```bash
./deploy.sh          # Production deployment
./fresh-install.sh   # Fresh environment setup
./reset-db.sh        # Reset database
./benchmark.sh       # Performance benchmarking
```

## Architecture

### Stack
- **Frontend**: Next.js 16 (App Router), React 19, TypeScript, Fabric.js 7.2, Tailwind CSS
- **Backend**: Django 5 + DRF, Celery 5.3.4, Pillow 10.3.0
- **Infrastructure**: PostgreSQL 16, Redis 7, Traefik v3, Docker Compose

### Key Data Flow
1. Customer interacts with Fabric.js canvas editor (`frontend/nextjs/src/app/editor/`)
2. On submit, frontend POSTs layout JSON to `/api/generate-layout/`
3. Backend `GenerateLayoutView` routes to sync (small orders) or async (large/CMYK) path
4. Async path: `render_canvas_task` → Celery worker → Pillow renders high-res file → `push_to_production_estimator_task` → OMS
5. Frontend polls `RenderStatusView` (Redis-cached) for job status

### Frontend Structure
- `src/app/editor/layout/[name]/page.tsx` — Main editor page
- `src/components/` — React components (FabricEditor.tsx is the canvas core)
- `src/lib/fabric-renderer.ts` — Off-screen canvas renderer for previews and exports
- `src/lib/image-utils.ts` — Image metadata extraction with WeakMap caching
- `src/lib/zip-utils.ts` — Chunked ZIP generation for batch downloads
- `src/types/` — TypeScript interfaces for layouts, surfaces, frames

### Backend Structure
- `api/views.py` — `GenerateLayoutView` (sync/async routing), `RenderStatusView` (Redis-cached polling), `CeleryMonitorView` (ops-only)
- `api/tasks.py` — `render_canvas_task`, `push_to_production_estimator_task`, `garbage_collector_task`
- `api/models.py` — `APIKey`, `EmbedSession`, `CanvasData`, `RenderJob`, `UploadedFile`, `ExportedResult`
- `layout_engine/engine.py` — Pillow-based high-res PNG/CMYK TIFF renderer with ICC soft-proofing
- `product_editor/celery.py` — Queue routing (priority vs. standard), broker/backend config

### Async Queue
Two Celery worker services run in parallel with explicit queue routing in `product_editor/celery.py`:
- `celery-worker-priority`: Soft-proof/express jobs (2 concurrent slots)
- `celery-worker-standard`: Regular exports (2 concurrent slots)

Retry strategy: `self.retry()` with exponential backoff (2s → 4s → 8s), max 3 retries. `MemoryError` and `SoftTimeLimitExceeded` skip retries. Never use `autoretry_for` — this codebase uses `self.retry()` exclusively.

Never dispatch Celery tasks directly inside a DB transaction — always use `transaction.on_commit(lambda: task.apply_async(...))`.

## Coordinate System

Fabric.js uses pixels; layouts specify mm. Confirm DPI-based conversion is applied consistently in both `fabric-renderer.ts` (client) and `engine.py` (server). ICC profiles live in `backend/django/icc_profiles/`.

## Adding a New Layout Property

1. Update `src/types/` in the frontend
2. Update rendering logic in `fabric-renderer.ts`
3. Update `layout_engine/engine.py` for high-res export
4. Ensure `views.py` persists the new property correctly

## Code Style

Use comments sparingly. Only comment complex or non-obvious logic.

## UI Conventions

- Glassmorphism style: blur, transparency, vibrant gradients
- Icons: `lucide-react`
- Conditional classes: `clsx` or `tailwind-merge`
- **JSX backtick warning**: A missing closing `` ` `` in a `className={`...`}` template literal triggers ~17 cascade TypeScript errors downstream

## Export Flag

The `isExport` flag controls whether frame outlines and preview overlays are rendered. These must be absent in download output. If they appear in exported files, the flag is not being passed correctly to `FabricEditor.tsx` or `fabric-renderer.ts`.

## Migrations

Run only via the `backend` (Gunicorn) container — never from worker or beat containers. Current latest migration: `0007_canvasdata_callback_url`.

## Security Rules

- API keys must never appear in URLs — use the `EmbedSession` token system
- All file-serving endpoints must validate UUID v4 format on `upload_id` before opening any path derived from request input
- New API endpoints must use `IsAuthenticatedWithAPIKey` permission; add `is_ops_team` check for internal endpoints

## Known Issues

- **B1 (P0)**: Canvas state does not persist after page refresh — blocks direct-to-production flow
- **B3 (P1)**: SKU-to-layout auto-mapping is not implemented — currently manual
