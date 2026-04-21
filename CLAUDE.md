# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Product Editor is a full-stack print-automation platform for Printo.in. Customers upload and compose photos on an interactive canvas editor; post-checkout, the system asynchronously renders high-resolution print files (PNG or CMYK TIFF) and pushes them to the production estimator (OMS), replacing manual preflight.

## Commands

### Frontend (Next.js)
```bash
cd frontend/nextjs
npm run dev       # Development server (http://localhost:3000 direct, or http://localhost:5004 via Docker)
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

**Client-side path (≤ 20 canvases):**
1. Customer interacts with Fabric.js canvas editor (`frontend/nextjs/src/app/editor/`)
2. On download/submit, `executeBatchDownload` or `handleSubmitDesign` renders canvases client-side via `fabric-renderer.ts`
3. For embed: `window.parent.postMessage({ type: 'PRODUCT_EDITOR_COMPLETE', canvases: [...dataUrls] })` fires and the parent caller handles the data URLs directly
4. For dashboard: a ZIP of rendered PNGs is assembled in-browser and downloaded

**Server-side path (> 20 canvases — embed or dashboard):**
1. `executeServerRender()` in `page.tsx` kicks in above the `SERVER_RENDER_THRESHOLD = 20`
2. All uploaded `File` objects are sent to Django via the chunked upload API (2 MB chunks, 4 parallel files) using `src/lib/upload-utils.ts`
3. Frontend POSTs to `POST /api/editor/render` with the layout name, `order_id`, and full `canvases[]` payload containing per-frame `upload_id` + transform data
4. Backend creates `CanvasData` + `RenderJob` and dispatches `render_canvas_task` to Celery
5. For **embed**: frontend fires `window.parent.postMessage({ type: 'pe:render_job', jobId, orderID })` — parent polls status independently; no download UI shown
6. For **dashboard**: frontend polls `GET /api/render-status/{job_id}/` every 4 s, then fetches the completed ZIP via `GET /api/jobs/{job_id}/download/`
7. Celery worker: `render_canvas_task` calls `LayoutEngine` with per-frame transforms extracted from `CanvasData.editor_state` → Pillow renders at 300 DPI → `push_to_production_estimator_task` → OMS

**OMS (legacy flow):**
- `GenerateLayoutView` still exists for the direct OMS POST flow (non-embed); routes to sync or async Celery path

### Frontend Structure
- `src/app/editor/layout/[name]/page.tsx` — Main editor page; contains `executeServerRender`, `executeBatchDownload`, `handleSubmitDesign`; threshold constant `SERVER_RENDER_THRESHOLD = 20`
- `src/components/` — React components (FabricEditor.tsx is the canvas core)
- `src/lib/fabric-renderer.ts` — Off-screen canvas renderer for previews and exports; uses pre-computed `frameRects[]` array to avoid repeated coordinate recalculation
- `src/lib/image-utils.ts` — Image metadata extraction; WeakMap caches only `{width, height, orientation}` (not the HTMLImageElement — would OOM at 200 files)
- `src/lib/upload-utils.ts` — Chunked upload utility: `uploadFile()` (single, sequential chunks) and `uploadFiles()` (batched, 4 parallel)
- `src/lib/zip-utils.ts` — Chunked ZIP generation for client-side batch downloads
- `src/app/api/embed/proxy/[...path]/route.ts` — Embed proxy; resolves embed token → `{ apiKey, orderId }`; injects `X-Order-ID` header; caches in-process (110 min TTL, 10k cap)
- `src/types/` — TypeScript interfaces for layouts, surfaces, frames

### Backend Structure
- `api/views.py` — `GenerateLayoutView`, `RenderStatusView`, `EditorRenderView` (new — chunked-upload render submission), `ChunkedUploadInitView/ChunkView/CompleteView`, `EmbedSessionView/ValidateView`, `RenderJobDownloadView`
- `api/tasks.py` — `render_canvas_task` (calls `_extract_frame_transforms` → `LayoutEngine`), `push_to_production_estimator_task`, `garbage_collector_task`
- `api/models.py` — `APIKey`, `EmbedSession` (+ `order_id` field), `CanvasData` (+ `editor_state` JSON), `RenderJob`, `UploadedFile` (+ `upload_session_id`), `ExportedResult`
- `layout_engine/engine.py` — Pillow-based high-res PNG/CMYK TIFF renderer; `_smart_downscale()` pre-shrinks source images to 2× frame target before compositing; per-frame pan/zoom/rotation from `frame_transforms`; PNG `optimize=True`
- `product_editor/celery.py` — Queue routing (priority vs. standard), broker/backend config

### Async Queue
Two Celery worker services run in parallel with explicit queue routing in `product_editor/celery.py`:
- `celery-worker-priority`: Soft-proof/express jobs (2 concurrent slots)
- `celery-worker-standard`: Regular exports (2 concurrent slots)

Retry strategy: `self.retry()` with exponential backoff (2s → 4s → 8s), max 3 retries. `MemoryError` and `SoftTimeLimitExceeded` skip retries. Never use `autoretry_for` — this codebase uses `self.retry()` exclusively.

Always call `transaction.on_commit(lambda: task.apply_async(...))` **inside** the `atomic()` block so the callback fires only after the DB commit. Calling it outside an open transaction executes immediately (which works but is non-standard and fragile).

## Server-Side Render Flow

### When It Triggers

`SERVER_RENDER_THRESHOLD = 20` in `page.tsx`. Both the embed Submit button (`handleSubmitDesign`) and the dashboard Download button (`executeBatchDownload`) check this threshold before deciding which path to take.

### Frontend Steps (`executeServerRender`)

| Step | Detail |
|---|---|
| Collect files | Iterate all canvases → frames → `frame.originalFile`; deduplicate with a `Set<File>` |
| Upload | `uploadFiles()` from `upload-utils.ts` — 2 MB chunks, 4 files parallel; progress 0 → 60% |
| Build payload | Per-frame: `{ upload_id, offset_x, offset_y, scale, rotation, fit_mode }` |
| Submit | `POST /api/editor/render` (or `/api/embed/proxy/editor/render`); `order_id` in body |
| Embed branch | `postMessage({ type: 'pe:render_job', jobId, orderID })` → `setSubmitted(true)` |
| Direct branch | Poll `/api/render-status/{job_id}/` every 4 s; fetch ZIP when `status === 'completed'` |

### Chunked Upload API

```
POST /upload/init               { filename, file_size, total_chunks }
  → { upload_id, chunk_size }   # upload_id is UUID v4; 50 MB per-file limit

PUT  /upload/{upload_id}/chunk?index=N   body: raw bytes
  → { chunk_index, received, total }

POST /upload/{upload_id}/complete
  → { file_path, filename, file_size }   # file_path stored in UploadedFile.file_path
```

- UUID v4 regex guard on both chunk and complete views (prevents path traversal)
- Chunks staged in `UPLOADS_DIR/.chunks/{upload_id}/`; assembled on complete with size + PIL integrity validation
- `UploadedFile.upload_session_id` stores the UUID — `EditorRenderView` queries this to map `upload_id → file_path`

### POST /api/editor/render

```json
{
  "layout_name": "circle_48mm",
  "order_id": "EXT-JOB-123",
  "export_format": "png",
  "soft_proof": false,
  "canvases": [
    {
      "canvas_index": 0,
      "surface_key": "front",
      "frames": [
        {
          "frame_index": 0,
          "upload_id": "<uuid from /upload/init>",
          "offset_x": -12.5,
          "offset_y": 3.0,
          "scale": 1.2,
          "rotation": 0,
          "fit_mode": "cover"
        }
      ]
    }
  ]
}
```

Response `202`:
```json
{ "job_id": "<uuid>", "order_id": "EXT-JOB-123", "status_url": "/api/render-status/<uuid>/", "queue": "standard" }
```

`order_id` resolution priority: `X-Order-ID` header (embed proxy injects from `EmbedSession.order_id`) → request body `order_id`.

### Embed Session & Order ID Flow

```
Caller (printo.in)  →  POST /api/embed/session { order_id: "EXT-JOB-123" }
                    ←  { token: "<uuid>", order_id: "EXT-JOB-123" }

iframe loads with  ?token=<uuid>

Every iframe request → embed proxy resolveSession(token)
                    → caches { apiKey, orderId, exp }
                    → injects X-Order-ID: EXT-JOB-123 on every upstream request

EditorRenderView reads X-Order-ID header (priority over body order_id)
```

`order_id` never appears in the iframe URL — it flows: caller → session DB → proxy in-process cache → `X-Order-ID` header → Django.

### postMessage Contract

| Type | Sender | When | Payload |
|---|---|---|---|
| `pe:render_job` | Product Editor iframe | Server-side render submitted (embed, > 20 canvases) | `{ type, jobId, orderID }` |
| `PRODUCT_EDITOR_COMPLETE` | Product Editor iframe | Client-side render complete (embed, ≤ 20 canvases) | `{ type, layoutName, canvases: [{index, dataUrl}] }` |

### Engine Improvements

- **Smart downscaling** (`_smart_downscale`): pre-shrinks source image to `(frame_target_w × 2, frame_target_h × 2)` before compositing. 12 MP photo → 400 px frame reduces working pixels from 12 M to ~0.64 M (~95% memory reduction per frame).
- **PNG optimize**: all PNG output uses `optimize=True` (lossless extra DEFLATE pass; 10–30% smaller files).
- **Per-frame transforms** (applied by `_composite_canvas`):
  1. Rotation: `img.rotate(-rotation, expand=True)`
  2. Smart downscale to 2× target
  3. `extra_scale` multiplier from `FrameState.scale`
  4. Cover/contain resize to exact frame dimensions
  5. Pan: `pan_x = int(offset_x)`, `pan_y = int(offset_y)` applied during paste

### Known Limitations

- **50 MB per-file limit** enforced in `ChunkedUploadInitView`; professional RAW files may exceed this
- **Proxy memory for large ZIPs**: `RenderJobDownloadView` uses `StreamingHttpResponse` but the Next.js proxy reads the full `ArrayBuffer` before returning to browser — can buffer 100–500 MB for 200-photo jobs
- **No duplicate render guard**: if the same `order_id` is submitted twice, a new `RenderJob` is created each time (`CanvasData` is upserted). The submit/download button is disabled during `isDownloading` preventing most double-submits

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

Run only via the `backend` (Gunicorn) container — never from worker or beat containers. Current latest migration: `0006_embedsession_order_id`.

| Migration | Change |
|---|---|
| 0001 | Initial schema |
| 0002 | `CanvasData.callback_url` |
| 0003 | `CanvasData.editor_state` + `UploadedFile.upload_session` |
| 0004 | `CanvasData.updated_at` + GC index |
| 0005 | `CanvasData` uniqueness changed to `(order_id, api_key)` — tenant isolation |
| 0006 | `EmbedSession.order_id` — stores caller's job ID; injected as `X-Order-ID` by embed proxy |

## Frontend Proxy Routes

The Next.js frontend never exposes API keys to the browser. All backend calls go through one of two server-side proxy routes:

- **`/api/internal/proxy/[...path]`** — Dashboard + editor. Authenticated via NextAuth session cookie (`pia-auth.ts` validates against `PIA_API_BASE_URL`). Uses `INTERNAL_API_KEY` (server-side only). `ops/*` sub-paths additionally check `session.is_ops_team`.
- **`/api/embed/proxy/[...path]`** — Customer-facing iframe embed. Authenticated via short-lived `X-Embed-Token` created at `/api/embed/session`.

Auth env vars required for the internal proxy: `AUTH_SECRET`, `PIA_API_BASE_URL` (default: `https://pia.printo.in/api/v1`).

## Security Rules

- API keys must never appear in URLs — use the `EmbedSession` token system
- All file-serving endpoints must validate UUID v4 format on `upload_id` before opening any path derived from request input
- New API endpoints must use `IsAuthenticatedWithAPIKey` permission; add `is_ops_team` check for internal endpoints

## Known Issues

- **B1 (P0)**: Canvas state does not persist after page refresh — blocks direct-to-production flow
- **B3 (P1)**: SKU-to-layout auto-mapping is not implemented — currently manual
