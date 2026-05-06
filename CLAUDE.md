# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Product Editor is a full-stack print-file generator for Printo.in. Customers upload and compose photos on an interactive canvas editor; the system asynchronously renders 300-DPI print files (PNG, with PDF as an alternate format) and delivers them either via direct download (dashboard users fetch the ZIP) or via a signed webhook to the embed caller's `callback_url` (printo.in's storefront then pulls the same download URL from its backend). The app does NOT push files to any internal OMS — it's a standalone generator.

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
./deploy.sh                                                    # Production deployment
./fresh-install.sh                                             # Fresh environment setup
./reset-db.sh                                                  # Reset database
./benchmark.sh                                                 # Performance benchmarking
API_KEY=<key> [BASE=<url>] ./scripts/smoke-test-embed.sh       # 10-step embed-flow smoke test
```

## Architecture

### Stack
- **Frontend**: Next.js 16 (App Router), React 19, TypeScript, Fabric.js 7.2, Tailwind CSS
- **Backend**: Django 5 + DRF, Celery 5.3.4, Pillow 10.3.0
- **Infrastructure**: PostgreSQL 16, Redis 7, nginx 1.27 (edge proxy), Docker Compose

### Key Data Flow

All exports go through one unified server-side pipeline. The previous client-side "≤ 20 canvases → render in browser" shortcut was removed in v1.8 — every Submit/Download triggers a Celery render job, regardless of canvas count. Trade-off: small jobs pay an extra ~10–20 s of upload + poll latency; gains a single contract that handles webhooks, large batches, and resumable uploads identically.

**Editor → render → delivery:**

1. Customer interacts with Fabric.js canvas editor (`frontend/nextjs/src/app/editor/`).
2. On Save & Continue (embed) or Download (dashboard), `executeServerRender()` in `page.tsx`:
   - Uploads every `File` via the chunked upload API (2 MB chunks, 4 parallel) using `src/lib/upload-utils.ts`
   - POSTs to `/api/editor/render` with `{ layout_name, order_id, canvases[] }` (per-frame `upload_id` + transform data)
3. Backend creates `CanvasData` + `RenderJob`, dispatches `render_canvas_task` to Celery.
4. Celery worker: `LayoutEngine` consumes per-frame transforms from `CanvasData.editor_state` → Pillow renders at 300 DPI (PNG by default; PDF when `export_format='pdf'`).
5. After render, files sit on disk under `EXPORTS_DIR/<job_id>/`, ready to be served by `GET /api/jobs/<job_id>/download/`.
6. **Delivery — embed flow:** if `EmbedSession.callback_url` was set at session creation, `notify_caller_webhook_task` POSTs `{ order_id, job_id, status, download_url, expires_at, file_count, layout_name, export_format }` to that URL plus an `X-Signature: sha256=<hmac>` header signed with the api_key. The caller fetches the ZIP from `download_url` using their api_key as Bearer auth. *No internal OMS push exists.*
7. **Delivery — dashboard flow:** no webhook task fires. The browser polls `/api/render-status/{job_id}/` with exponential backoff, then fetches the ZIP from `/api/jobs/{job_id}/download/` directly.
8. Frontend behaviour after submit:
   - **Embed**: fires `window.parent.postMessage({ type: 'pe:render_job', jobId, orderID })` so the parent's UI can show "your design is being prepared". The actual file delivery happens via the webhook (above), not via postMessage.
   - **Dashboard**: polls + downloads as in step 7.

**Direct API callers (legacy `GenerateLayoutView`):**
- `GenerateLayoutView` still exists for partners who hit `/api/layout/generate` with their own api_key (no embed session). Same output contract: `export_format` is `'png'` (default) or `'pdf'`. The legacy `soft_proof` / `tiff_cmyk` / `callback_url` body params were all removed in v1.8 — direct callers must poll `/api/render-status/<job_id>/`. Webhooks are configured exclusively via `EmbedSession.callback_url`.

### Frontend Structure
- `src/pia-auth.ts` — NextAuth v5 config; Credentials provider hits PIA; `jwt`/`session`/`redirect` callbacks; custom `CredentialsSignin` subclasses for outage vs. timeout; PIA fetches use `AbortSignal.timeout(10_000)`
- `src/proxy.ts` — Next.js 16 proxy file (formerly `middleware.ts`). Server-side auth gate for `/dashboard/*` and `/editor/layouts/*`; bounces logged-in users away from `/login`. Excludes `/editor/layout/[name]` because that route serves both dashboard and embed flows.
- `src/app/login/page.tsx` + `src/app/actions/auth.ts` — login form + server action; per-IP rate limit (5/min, in-memory); maps `PiaTimeout` / `PiaServiceUnavailable` codes to user-facing messages
- `src/types/next-auth.d.ts` — type augmentation for `Session` (`error`, `is_ops_team`, `accessToken`, `user.role`) and `JWT` — never use `(session as any)`
- `src/app/editor/layout/[name]/page.tsx` — Main editor page. Single render path via `executeServerRender()` regardless of canvas count. `handleSubmitDesign` (embed "Save & Continue") and `executeBatchDownload` (dashboard "Download") are thin wrappers that both call it. Dual-mode (dashboard session vs. embed token).
- `src/components/` — React components (FabricEditor.tsx is the canvas core)
- `src/components/ServiceWorkerRegistration.tsx` — registers `/sw.js` in production after `window.load`. No-op in dev so cache doesn't mask code changes. Wired into `app/layout.tsx`.
- `public/sw.js` — minimal cache-first Service Worker for `/_next/static/*` and `/static/*`. `CACHE_VERSION` constant gates cache buckets; bump to bust everything. See `## Service Worker` section.
- `src/lib/fabric-renderer.ts` — Off-screen canvas renderer for previews and exports; uses pre-computed `frameRects[]` array to avoid repeated coordinate recalculation. `calculateSmartCropOffsets` clamps the returned offset to the frame's actual per-axis pan room — see v1.10 fix.
- `src/lib/image-utils.ts` — Image metadata extraction; WeakMap caches only `{width, height, orientation}` (not the HTMLImageElement — would OOM at 200 files)
- `src/lib/upload-utils.ts` — Chunked upload utility: `uploadFile()` (single, sequential chunks) and `uploadFiles()` (batched, 4 parallel)
- `src/lib/zip-utils.ts` — Chunked ZIP generation for client-side batch downloads
- `src/lib/file-store.ts` — IndexedDB-backed File persistence keyed by `(orderId, fileId)`; recovers `originalFile` after page refresh. See "B1 — Canvas state file persistence" below.
- `src/app/api/embed/proxy/[...path]/route.ts` — Embed proxy; resolves embed token → `{ apiKey, orderId }`; injects `X-Order-ID` header; caches in-process (110 min TTL, 10k cap)
- `src/types/` — TypeScript interfaces for layouts, surfaces, frames

### Backend Structure
- `api/views.py` — `GenerateLayoutView`, `RenderStatusView`, `EditorRenderView` (chunked-upload render submission), `ChunkedUploadInitView/ChunkView/CompleteView`, `EmbedSessionView/ValidateView`, `RenderJobDownloadView`, `HealthView` (`GET /api/health`, public, used by Docker healthchecks), `SKULayoutView` (`GET/PUT /api/sku-layouts/[<sku>/]` — see Storage Files below)
- `api/tasks.py` — `render_canvas_task` (calls `_extract_frame_transforms` → `LayoutEngine`), `notify_caller_webhook_task` (only dispatched when `canvas.callback_url` is set; signs payload with HMAC-SHA256 of api_key), `garbage_collector_task` (has `soft_time_limit=3300` / `time_limit=3600`)
- `api/models.py` — `APIKey`, `EmbedSession` (+ `order_id` + `callback_url` fields), `CanvasData` (+ `editor_state` JSON, + `callback_url` propagated from EmbedSession), `RenderJob`, `UploadedFile` (+ `upload_session_id`), `ExportedResult`
- `api/validators.py` — `MAX_FILE_SIZE_MB` reads from `settings.MAX_UPLOAD_FILE_SIZE_MB` (single source via env)
- `layout_engine/engine.py` — Pillow-based high-res PNG/PDF renderer at 300 DPI; `_smart_downscale()` pre-shrinks source images to 2× frame target (BOX resample); 90/180/270° rotation fast-path via `Image.transpose`; per-frame pan/zoom/rotation from `frame_transforms`; explicit `Image.close()` + `gc.collect()` between canvases. CMYK/soft-proof pipeline removed in v1.8.
- `product_editor/celery.py` — Queue routing (priority vs. standard), `worker_max_tasks_per_child = 50`, `worker_prefetch_multiplier = 1`
- `product_editor/settings.py` — `csp.middleware.CSPMiddleware` is wired in after `SecurityMiddleware`; CSP starts in report-only mode via `CSP_REPORT_ONLY`
- **Backend Dockerfile** is multi-stage — builder installs `build-essential` + `libpq-dev` to compile wheels; runner ships only `libpq5` + the venv. Drops ~250 MB from the final image.

### Async Queue
Two Celery worker services run in parallel with explicit queue routing in `product_editor/celery.py`:
- `celery-worker-priority`: Soft-proof/express jobs
- `celery-worker-standard`: Regular exports

Concurrency is **auto-detected from CPU count** per replica (no `CELERY_CONCURRENCY` set in compose). Override via `.env` if needed. Memory cap is 2 GB per replica.

Worker config (in `product_editor/celery.py`):
- `worker_prefetch_multiplier = 1` — fetch one task at a time per slot
- `worker_max_tasks_per_child = 50` — recycle workers periodically; relies on `engine.py` calling `Image.close()` + `gc.collect()` after each canvas to avoid drift
- `task_acks_late = True` + `task_reject_on_worker_lost = True` — requeue if a worker dies

Retry strategy: `self.retry()` with exponential backoff (2s → 4s → 8s), max 3 retries. `MemoryError` and `SoftTimeLimitExceeded` skip retries. Never use `autoretry_for` — this codebase uses `self.retry()` exclusively.

`garbage_collector_task` runs daily at 02:00 UTC and has `soft_time_limit=3300` / `time_limit=3600` so a hung GC sweep can never permanently block a worker slot.

Always call `transaction.on_commit(lambda: task.apply_async(...))` **inside** the `atomic()` block so the callback fires only after the DB commit. Calling it outside an open transaction executes immediately (which works but is non-standard and fragile).

## Server-Side Render Flow

### When It Triggers

Always. The embed "Save & Continue" button (`handleSubmitDesign`) and the dashboard ZIP download button (`executeBatchDownload`) both call `executeServerRender()` unconditionally. The previous threshold-based split was removed in v1.8.

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
Caller (printo.in)  →  POST /api/embed/session
                       { order_id: "EXT-JOB-123",
                         callback_url: "https://printo.in/api/internal/pe-callback" }
                    ←  { token: "<uuid>", order_id, callback_url, expires_at }

iframe loads with  ?token=<uuid>

Every iframe request → embed proxy resolveSession(token)
                    → checks path allowlist (rejects /ops, /admin, etc. with 403)
                    → caches { apiKey, orderId, callbackUrl, exp } for 110 min
                    → injects X-Order-ID + X-Callback-URL on every upstream request

EditorRenderView reads X-Order-ID + X-Callback-URL headers, persists onto CanvasData

After Celery render completes — only when canvas.callback_url is set:
notify_caller_webhook_task → POSTs webhook payload to canvas.callback_url
                          → HMAC-SHA256(api_key.key, raw_body) in X-Signature header
```

Neither `order_id` nor `callback_url` ever appears in the iframe URL — they flow: caller → session DB → proxy in-process cache → `X-Order-ID` / `X-Callback-URL` headers → Django.

`order_id` is validated server-side at session creation: `^[A-Za-z0-9_.\-]{1,64}$`. Anything else is rejected with 400.

`callback_url` (optional) is validated at session creation: must be `https://`, max 2000 chars. No domain allowlist — auth is enforced by the api_key the caller already holds, and the HMAC signature lets them verify the request actually came from us.

**Webhook payload (sent to `EmbedSession.callback_url` on completion):**

```json
{
  "order_id":      "EXT-JOB-123",
  "job_id":        "<RenderJob uuid>",
  "status":        "completed" | "failed",
  "download_url":  "https://product-editor.printo.in/api/jobs/<uuid>/download/",
  "expires_at":    "<ISO 8601>",
  "file_count":    12,
  "layout_name":   "circle_48mm",
  "export_format": "png"
}
```

Headers: `Content-Type: application/json`, `X-Signature: sha256=<hex>`. Caller verifies with `hmac.compare_digest(hmac.new(api_key, raw_body, sha256).hexdigest(), signature)`. Then fetches `download_url` with their api_key as `Authorization: Bearer <key>` to get the ZIP.

**Embed proxy path allowlist** ([route.ts](frontend/nextjs/src/app/api/embed/proxy/[...path]/route.ts:124)) — only these prefixes pass through:

```
layouts, canvas-state, editor/render, render-status, jobs,
upload, fonts, sku-layouts, embed/session
```

Anything else returns 403 *before* token resolution, so an attacker can't probe Django auth surfaces with a stolen embed token.

**Sliding session TTL** — sessions are created with a 2-hour expiry, but `EmbedSessionValidateView` extends by 1 hour whenever the remaining lifetime drops below 30 min. Active editing sessions stay alive without a hard cutoff; idle sessions still expire on schedule. One DB write per hour of activity in the worst case.

**iframe `frame-ancestors`** ([next.config.mjs](frontend/nextjs/next.config.mjs)) — `/layout/*`, `/editor/layout/*`, and `/embed/layout/*` get a CSP `frame-ancestors` header allowing `'self'`, `https://printo.in`, and `https://*.printo.in`. Override per-environment via `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS`.

### postMessage Contract

| Type | Sender | When | Payload |
|---|---|---|---|
| `pe:render_job` | Product Editor iframe | After every embed submit; parent's frontend uses this for "preparing your design" UX. Actual file delivery is via the webhook (see `EmbedSession.callback_url`). | `{ type, jobId, orderID }` |

**targetOrigin is locked, never `'*'`.** Resolution chain in [editor page](frontend/nextjs/src/app/editor/layout/[name]/page.tsx) `parentOrigin`: `window.location.ancestorOrigins[0]` (Chromium/Safari) → `document.referrer` origin → `NEXT_PUBLIC_EMBED_PARENT_ORIGIN` env → `https://printo.in` default. So an unrelated outer page can't eavesdrop on completion payloads (which include order_id, job_id, and dataUrls for client-rendered jobs).

### Engine Improvements

- **Smart downscaling** (`_smart_downscale`): pre-shrinks source image to `(frame_target_w × 2, frame_target_h × 2)` before compositing. 12 MP photo → 400 px frame reduces working pixels from 12 M to ~0.64 M (~95% memory reduction per frame).
- **PNG output**: written without `optimize=True` because the extra DEFLATE pass was a download bottleneck under high concurrency. ZIP archives use `STORED` (no compression) — most images are already PNG-compressed, so DEFLATE on top adds latency without meaningful size reduction.
- **Memory hygiene**: source images are loaded inside a `with Image.open(...) as src` block so file handles release immediately. After each canvas, `_generate_for_surface` calls `.close()` on the canvas + intermediate Images, `del` the references, and runs `gc.collect()`. Mask images and resized masks are also closed. Without this, 200-canvas batches accumulated several GB of resident PIL state before the worker recycled.
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

## Auth & Login Flow

The dashboard side is auth-gated; the embed iframe is **not** (it uses an embed token, not a session).

### Stack

- **NextAuth v5** (`next-auth@^5-beta`) configured in `src/pia-auth.ts` with a single Credentials provider that POSTs to PIA at `${PIA_API_BASE_URL}/auth/`.
- **Strategy**: JWT (no DB session). `accessToken` and `refreshToken` are stored on the JWT cookie; the `jwt` callback silent-refreshes via `/auth/token/refresh/` when expiry approaches.
- **Server gate**: `src/proxy.ts` (Next.js 16 renamed `middleware.ts` → `proxy.ts`). Wraps NextAuth's `auth()` to gate `/dashboard/:path*` and `/editor/layouts/:path*`, and bounces logged-in users away from `/login`. Configured matcher excludes `/editor/layout/[name]` because that route serves both the dashboard editor and the embed iframe — page-level logic decides which.

### Login server action

`src/app/actions/auth.ts` is the entry point from the login form. Responsibilities:

1. **Per-IP rate limit** — 5 attempts per 60 s, fixed window, in-memory `Map`. Single-process; if you scale the frontend container horizontally, swap to Redis. IP is read from `X-Forwarded-For` (nginx sets it from CF's `CF-Connecting-IP`; see `proxy/nginx/nginx.conf`).
2. **`signIn("credentials", { username, password, redirectTo })`** — dispatches to NextAuth.
3. **Error mapping** — distinguishes failure modes via the `code` field on `CredentialsSignin` subclasses thrown from `authorize()`:
   - `PiaTimeout` → "Login is taking too long…"
   - `PiaServiceUnavailable` → "The authentication service is temporarily unavailable…"
   - default → "Invalid credentials. Please try again."

### authorize() distinctions

`pia-auth.ts:authorize` separates *bad credentials* from *upstream outage* so users don't retype passwords during a PIA incident:

| PIA response | authorize behavior | UX |
|---|---|---|
| 2xx + `access` token | return user object | logged in |
| 4xx (incl. 401) | return `null` | "Invalid credentials" |
| 5xx | throw `PiaServiceUnavailableError` | "Service temporarily unavailable" |
| timeout / network error | throw `PiaTimeoutError` | "Login is taking too long…" |

PIA fetches use `AbortSignal.timeout(10_000)` (10 s) on both `/auth/` and `/auth/token/refresh/`.

### Open-redirect protection

The `redirect` callback in `pia-auth.ts` clamps `callbackUrl`: relative paths join to `baseUrl`; absolute URLs only allowed if same origin; malformed URLs fall back to `baseUrl`. So `?callbackUrl=https://evil.com` is harmless.

### Session shape

Type-augmented in `src/types/next-auth.d.ts` — never use `(session as any)`:

```ts
session.user.id          // PIA employee_id
session.user.name        // PIA full_name
session.user.email       // login username
session.user.role        // "admin" | "user" (admin = is_super_user || is_ops_team)
session.accessToken      // PIA JWT — forwarded by /api/internal/proxy as Bearer
session.is_ops_team      // gates /api/internal/proxy/ops/* and /editor/layouts admin actions
session.error            // "RefreshAccessTokenError" when refresh has failed → app redirects to /login
```

`session.error === 'RefreshAccessTokenError'` is checked by `proxy.ts`, the internal proxy, and every protected page's `useEffect` — keep these in sync if you change the flow.

## Coordinate System

Fabric.js uses pixels; layouts specify mm. Confirm DPI-based conversion is applied consistently in both `fabric-renderer.ts` (client) and `engine.py` (server). ICC profiles + CMYK pipeline were retired in v1.8 — output is now PNG (default) or PDF only.

## Adding a New Layout Property

1. Update `src/types/` in the frontend
2. Update rendering logic in `fabric-renderer.ts`
3. Update `layout_engine/engine.py` for high-res export
4. Ensure `views.py` persists the new property correctly

## Code Style

Use comments sparingly. Only comment complex or non-obvious logic.

**TypeScript:** `tsconfig.json` is in **full strict mode** as of v1.9 (`strict: true`). All implicit-any checks pass. Fabric.js custom properties (`__frameIdx`, `__paper`, `__fabricEditor` discriminator, etc.) are typed via module augmentation in `src/types/fabric-augmentation.d.ts` — direct property access is type-checked, no `as any` needed. The 31 remaining explicit `as any` casts are all Fabric API arg coercion (`obj.set(... as any)`, `setViewportTransform(... as any)`), Fabric internals (`._element`), or LayoutDef/OverlayState shape narrowing — none are about untyped custom props. Run `pnpm typecheck` (`tsc --noEmit`) before pushing.

**Lint:** `eslint.config.mjs` is the active flat config; `pnpm lint` runs `eslint src`. `pnpm lint:fix` auto-fixes the easy ones. Both `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript` presets are loaded. `@typescript-eslint/no-explicit-any` is demoted to `off` because the 31 remaining `as any` casts are tracked separately (see TypeScript section). The react-hooks v7 strict rules are all promoted to `error` (offenders fixed in v1.10) so regressions break CI.

**Scripts:** `pnpm dev`, `pnpm dev:clean` (rm `.next` first — use if routes 404 in dev), `pnpm build`, `pnpm start`, `pnpm clean`, `pnpm lint`, `pnpm lint:fix`, `pnpm typecheck`.

## UI Conventions

- Glassmorphism style: blur, transparency, vibrant gradients
- Icons: `lucide-react`
- Conditional classes: `clsx` or `tailwind-merge`
- **JSX backtick warning**: A missing closing `` ` `` in a `className={`...`}` template literal triggers ~17 cascade TypeScript errors downstream

## Export Flag

The `isExport` flag controls whether frame outlines and preview overlays are rendered. These must be absent in download output. If they appear in exported files, the flag is not being passed correctly to `FabricEditor.tsx` or `fabric-renderer.ts`.

## Storage Files

Some configuration lives as JSON on disk (under `STORAGE_ROOT`, default `./storage/`) rather than in the database. These are written atomically (`*.tmp` + `os.replace`):

| File | Schema | Endpoint | Editable by |
|---|---|---|---|
| `storage/fonts.json` | `["sans-serif", ...]` | `GET/PUT /api/fonts` | ops team |
| `storage/sku_layouts.json` | `{ "_meta": {...}, "mappings": {sku: layout_name} }` | `GET/PUT /api/sku-layouts/[<sku>/]` | ops team for PUT, public read |
| `storage/layouts/*.json` | per-layout layout def | `GET /api/layouts`, `GET/PUT/DELETE /api/ops/layouts/<name>` | ops team |

For SKU mapping: PUT validates that every `layout_name` exists on disk before persisting, so the file never holds a broken pointer. GET resolution returns 410 Gone if the disk file has since been deleted.

## Service Worker

The frontend ships a minimal Service Worker at [`public/sw.js`](frontend/nextjs/public/sw.js) registered by [`ServiceWorkerRegistration`](frontend/nextjs/src/components/ServiceWorkerRegistration.tsx) in the root layout.

**What it does:**
- Cache-first for `GET` requests under `/_next/static/*` and `/static/*` (both content-hashed → safe forever).
- Same-origin only; non-static paths fall through to network.
- `skipWaiting` + `clients.claim` → updates apply on reload, no hard-refresh required.
- On `activate`, sweeps any cache that doesn't match the current `CACHE_VERSION`.

**What it deliberately does NOT do:**
- Cache HTML, API responses, or anything auth-gated.
- Pre-cache anything on install (would bloat first-load).
- Offline routing, push, background sync.

**Registration is production-only** — `process.env.NODE_ENV !== 'production'` short-circuits in `ServiceWorkerRegistration.tsx`. This is deliberate: in dev you want every change to hit the network.

**Cache bust:** bump `CACHE_VERSION = 'pe-static-v1'` in `public/sw.js`. The activate handler clears any prior `pe-static-*` bucket on the next page load.

**Verification on prod:**
- DevTools → Application → Service Workers → expect `activated and is running` on `/sw.js`
- Network tab on a warm reload → static chunks show `(ServiceWorker)` in the **Size** column
- Cache Storage → `pe-static-v1` populating with chunks as you navigate

## Migrations

Run only via the `backend` (Gunicorn) container — never from worker or beat containers. Current latest migration: `0007_exportedresult_gc_partial_index`.

| Migration | Change |
|---|---|
| 0001 | Initial schema |
| 0002 | `CanvasData.callback_url` |
| 0003 | `CanvasData.editor_state` + `UploadedFile.upload_session` |
| 0004 | `CanvasData.updated_at` + GC index |
| 0005 | `CanvasData` uniqueness changed to `(order_id, api_key)` — tenant isolation |
| 0006 | `EmbedSession.order_id` — stores caller's job ID; injected as `X-Order-ID` by embed proxy |
| 0007 | v1.8 bundle: `(is_deleted, created_at)` partial index on `ExportedResult` (GC speedup) + drop `CanvasData.soft_proof` (CMYK retired) + `CanvasData.export_format` choices=('png','pdf') + `EmbedSession.callback_url` (webhook URL, propagated to CanvasData via `X-Callback-URL` header) |

## Frontend Proxy Routes

The Next.js frontend never exposes API keys to the browser. All backend calls go through one of two server-side proxy routes:

- **`/api/internal/proxy/[...path]`** — Dashboard + editor. Authenticated via NextAuth session cookie (`pia-auth.ts` validates against `PIA_API_BASE_URL`). Uses `INTERNAL_API_KEY` (server-side only). `ops/*` sub-paths additionally check `session.is_ops_team`. Returns 401 if `session.error === 'RefreshAccessTokenError'`.
- **`/api/embed/proxy/[...path]`** — Customer-facing iframe embed. Authenticated via short-lived `X-Embed-Token` created at `/api/embed/session`.

Auth env vars required for the internal proxy: `AUTH_SECRET`, `PIA_API_BASE_URL` (default: `https://pia.printo.in/api/v1`).

Note: `src/proxy.ts` (the auth gate) is unrelated to these `/api/*/proxy` routes despite the name overlap. It's the Next.js 16 successor to `middleware.ts` — see "Auth & Login Flow" above.

## Environment Variables

The runtime is driven by env vars (no per-environment Python/JS config files). All listed in `.env.example`.

**Required in production:**

| Var | Purpose |
|---|---|
| `PUBLIC_HOST` / `DOMAIN_NAME` | Hostname nginx accepts (e.g. `product-editor.printo.in`); also baked into the bootstrap self-signed cert's CN |
| `AUTH_SECRET` | NextAuth JWT signing secret (≥ 32 chars) |
| `INTERNAL_API_KEY` | API key the internal proxy sends to Django |
| `PIA_API_BASE_URL` | Upstream auth (default `https://pia.printo.in/api/v1`) |
| `POSTGRES_*` / `REDIS_URL` | Standard infra |

**Tunables with safe defaults:**

| Var | Default | Effect |
|---|---|---|
| `DEBUG` | `0` | Defaults off — production-safe even when var is missing |
| `MAX_UPLOAD_FILE_SIZE_MB` | `50` | Single source of truth — read by `settings.py`, `validators.py`, and chunked-upload init |
| `DB_CONN_MAX_AGE` | `600` | Persistent DB connection age in seconds; raise / set to `0` if PgBouncer is in front |
| `CSP_REPORT_ONLY` | `True` | django-csp emits headers but enforces nothing — flip to `False` once policy is validated |
| `CELERY_CONCURRENCY` | unset | Celery auto-detects from CPU count; set to cap on shared servers |
| `SECURE_SSL_REDIRECT` | `True` if `DEBUG=0` | Set to `False` if nginx already redirects HTTP→HTTPS (which it does by default; this var is redundant in the current setup) |
| `CORS_ALLOW_ALL_DEVELOPMENT` | `true` | Only honored when `DEBUG=1` |
| `NEXT_PUBLIC_EMBED_PARENT_ORIGIN` | `https://printo.in` | Last-resort fallback for `postMessage` targetOrigin if `ancestorOrigins` and `referrer` are both unavailable |
| `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` | `'self' https://printo.in https://*.printo.in` | CSP `frame-ancestors` directive applied to iframe entry pages. Override for staging / partner hosts |
| `REDIS_URL` | `redis://redis:6379/0` | Celery broker (db **0**) |
| `REDIS_CACHE_URL` | derived (`redis://redis:6379/1`) | Django cache (db **1**). Auto-derived by swapping the `REDIS_URL` trailing `/0` → `/1`. Override only if cache and broker need to live on different Redis instances |

## Security Rules

- API keys must never appear in URLs — use the `EmbedSession` token system
- All file-serving endpoints must validate UUID v4 format on `upload_id` before opening any path derived from request input
- New API endpoints must use `IsAuthenticatedWithAPIKey` permission; add `is_ops_team` check for internal endpoints
- The login server action enforces a per-IP rate limit (5 attempts / 60 s, in-memory). If you scale the frontend container horizontally, replace it with a Redis-backed limiter — the in-memory `Map` in `src/app/actions/auth.ts` is per-process.
- `DEBUG` defaults to off (`os.getenv("DEBUG", "0") == "1"`) — production-safe even if the env var is missing. Don't flip the default back.
- django-csp ships in **report-only** mode (`CSP_REPORT_ONLY=True`). Watch DevTools and the violation reports; flip to `False` only after the policy has been validated against the editor (Fabric.js needs `'unsafe-eval'`) and the embed iframe (`frame-ancestors` allows `https://printo.in` and `https://*.printo.in`).
- `redirect` callback in `pia-auth.ts` clamps `callbackUrl` — relative paths join to `baseUrl`, absolute URLs only allowed on same origin. Don't loosen this without thinking through open-redirect attacks.
- **Embed proxy is allowlist-only** — `ALLOWED_PATH_PREFIXES` in `src/app/api/embed/proxy/[...path]/route.ts`. New customer-facing endpoints must be added there explicitly; ops/admin paths must NEVER be added. The check runs *before* token resolution so attackers can't probe Django auth.
- **postMessage `targetOrigin` must never be `'*'`** — use the `parentOrigin` resolver in the editor page. Eavesdropping risk: completion payloads include order_id, job_id, and dataUrls.
- **`order_id` is regex-validated** server-side (`^[A-Za-z0-9_.\-]{1,64}$`). Don't relax to allow spaces / unicode — it flows into headers, logs, file paths, and CanvasData lookup.

## Known Issues

No open P0/P1 issues. Previously tracked items B1, B3, B4, B5 have all shipped — see "Fixed" below for what each does and how to extend.

**Watch list (not blocking):**
- NextAuth 5 is still in beta. The `(session as any)` casts have been removed, but if you bump the version, recheck `next-auth.d.ts` against the upstream `Session` / `JWT` shapes.
- ESLint surfaces ~56 `no-unused-vars` warnings (dead imports, unused state setters, unused destructured params). Non-blocking; mostly easy local cleanups. Errors all fixed in v1.10.
- 31 explicit `as any` casts remain (down from 98). All are Fabric API arg coercion, Fabric internals, or LayoutDef/OverlayState shape narrowing — none are about untyped Fabric custom props (those are typed via `src/types/fabric-augmentation.d.ts`). `@typescript-eslint/no-explicit-any` is set to `off` in eslint.config.mjs because of these — re-enable only after the LayoutDef shape is unified.

### Fixed

- **v1.10 — Cover-mode white-space bug.** `calculateSmartCropOffsets` ([fabric-renderer.ts](frontend/nextjs/src/app/editor/layout/[name]/fabric-renderer.ts)) now clamps the returned offset to `±(scaled_dim − frame_dim)/2` per axis. Previously the function returned a smartcrop-driven offset with no awareness of the frame's actual pan room — when the constraining axis had zero overflow, the raw offset shoved the image past the frame edge and exposed white inside the frame (visible mostly on portrait photos in 5×7 portrait layouts).
- **v1.10 — Editor drag clipPath fix.** Frame-image `clipPath` is in image-local coords, so during `object:moving` Fabric updated `img.left/top` in real time but the clipPath drifted with the image. The visible "window" moved with the image instead of staying fixed in the frame, and the user saw the same cropped centre throughout. `updateRelativeClipPath` is now invoked on every `object:moving` / `:scaling` / `:rotating` event in [FabricEditor.tsx](frontend/nextjs/src/app/editor/layout/[name]/FabricEditor.tsx), not only on `:modified`.
- **v1.10 — Imposition modal: Custom W×H inputs.** Selecting `CUSTOM` previously left users stuck at whatever `widthIn`/`heightIn` was last in state because the modal had no UI to edit them. Inch inputs now render gated on `preset === 'custom'`. Modal styling tightened: `rounded-[40px]` shell → `rounded-2xl`, `font-black` everywhere → `font-semibold`/`font-medium`, padding/gaps `p-8`/`space-y-8` → `p-6`/`space-y-5`. Smart-auto-repeat copy reflects the actual custom dimensions.
- **v1.10 — Smartcrop IDB cache wiring.** Three call sites in `page.tsx` (`generateCanvases`, `generateCanvasesForLayout`, fit-mode change handler) were calling `calculateSmartCropOffsets` without a `cacheKey`, so the IDB-backed cache (`getCachedCrop`/`setCachedCrop` in [file-store.ts](frontend/nextjs/src/lib/file-store.ts)) was bypassed for the editor mount path. They now pass content-fingerprint keys (`name:size:lastModified:WxH:rotation`).
- **v1.10 — Editor parallel-batch tuned.** `BATCH_SIZE` in `generateCanvases` raised 5 → 8. Roughly halves metadata + smartcrop wall time on 100+-photo uploads; peak memory still well below OOM zone on typical tablets (~400 MB peak vs the OOM zone at ~700 MB on 4 GB devices). 16 was tested mentally and rejected — too risky on low-RAM tablets for 200-photo batches.
- **v1.10 — `_smart_downscale` defensive copy removed.** [`engine.py`](backend/django/layout_engine/engine.py) called `img = img.copy()` before `img.thumbnail(...)`. The source RGBA was already a fresh per-frame allocation, so the copy was wasted ~50 MB memcpy per 12 MP frame (tens of GB across a 200-canvas batch). Caller already reassigns the return value, so in-place mutation is safe.
- **v1.10 — Hot-path debug logs gated.** `log()` is a no-op in prod but JS evaluates arguments at call sites. Wrapped 9 hot-path call sites in [FabricEditor.tsx](frontend/nextjs/src/app/editor/layout/[name]/FabricEditor.tsx) behind `if (_DEV)` blocks: canvas-build summary (with `JSON.stringify(layout)` × 2 + per-frame forEach), full-rebuild summary, in-place update header, paper/bleed/safe-zone updates, frame-image-calculation, getPaperPath per-frame log. Saves ~5–15 ms/sec of dead computation during interactions on slower devices.
- **v1.10 — Redis DB split.** Django cache moved to db `1`; Celery broker stays on db `0`. Same instance, separate logical DBs, so the cache's `allkeys-lru` eviction policy can no longer drop in-flight Celery messages under cache pressure. Settings derives `REDIS_CACHE_URL` from `REDIS_URL` by swapping `/0` → `/1` unless explicitly overridden.
- **v1.10 — Docker log rotation.** Top-level `x-default-logging` YAML anchor in [docker-compose.yml](docker-compose.yml) caps every service's json-file logs at 50 MB × 3 rotations (~150 MB ceiling per service). Without this, `/var/lib/docker/containers/<id>/*-json.log` would grow unbounded.
- **v1.10 — Ops layouts list cache.** `LayoutManagementView.get` ([api/views.py](backend/django/api/views.py)) now mirrors `ListLayoutsView` — Django cache key `ops_layouts_list_all` (2-min TTL) + `Cache-Control: private, max-age=60, stale-while-revalidate=120`. Invalidated on PUT/POST via `cache.delete_many([...])`.
- **v1.10 — Service Worker.** Minimal SW at [`public/sw.js`](frontend/nextjs/public/sw.js) registered from `<ServiceWorkerRegistration />` in root layout. Cache-first for `/_next/static/*` and `/static/*` (both content-hashed, safe to keep forever); same-origin GETs only; non-static paths fall through. `skipWaiting` + `clients.claim` so updates take effect without a hard refresh. Activate handler sweeps prior `pe-static-*` caches. Production-only registration. To bust caches: bump `CACHE_VERSION` in `public/sw.js`.
- **B1 — Canvas state file persistence.** `src/lib/file-store.ts` is an IndexedDB store keyed by `(orderId, fileId)`. Each frame and image overlay carries an optional `fileId` (UUID) on `FrameState` / `ImageOverlay`. A self-stabilising effect in `editor/layout/[name]/page.tsx` walks `surfaceStates` after every change, persists any `originalFile` that lacks a `fileId`, and patches the new id back into state. The auto-restore effect calls `getFilesForOrder(orderId)` and rehydrates `originalFile` for any frame/overlay whose `fileId` is in the IndexedDB map. **For image overlays**, restore also re-creates `src` via `getFileUrl(file)` because the previous session's blob URL is revoked — without this fix overlays appear broken in the modal. Net effect: refreshing the page restores not just dataUrl previews but the original Files (and live blob URLs) needed to re-render.
- **B3 — SKU → layout resolution.** `storage/sku_layouts.json` holds a `{ sku → layout_name }` mapping. `GET /api/sku-layouts/` returns the full mapping; `GET /api/sku-layouts/<sku>/` returns a single resolution (404 if unmapped, 410 if mapped to a deleted layout). `PUT /api/sku-layouts/` replaces the mapping (ops-team only). Public-read so printo.in can resolve the layout before creating an embed session. Cache headers: `public, max-age=300, stale-while-revalidate=600`.
- **B4 — ESLint flat config.** Replaced `.eslintrc.json` with `eslint.config.mjs`. `pnpm lint` now runs `eslint src` directly (Next.js 16 removed the `next lint` subcommand). The strict TypeScript preset is intentionally not loaded — see watch list above.
- **B5 — Stale `.next/` cache.** Added `pnpm clean` (deletes `.next/`) and `pnpm dev:clean` (clean + start dev). If you ever see Next.js routes 404 in local dev, run `pnpm dev:clean` instead of `pnpm dev`.

## What to Do Next

The full prioritised list is in [PRD.md](PRD.md) §8 — these are the items that touch this codebase or its deploy.

### Before / during the next `./deploy.sh`

1. **Generate a Cloudflare Origin Certificate** — CF dashboard → SSL/TLS → Origin Server → **Create Certificate**. Defaults are fine (RSA 2048, 15-year). Hostnames: `product-editor.printo.in` (and / or `*.printo.in`). Paste the cert body into `proxy/nginx/certs/origin.crt` and the private key into `proxy/nginx/certs/origin.key`. `chmod 600 origin.key`. Then in CF set SSL/TLS mode to **Full (strict)**. If you skip this step, `deploy.sh` will generate a self-signed cert as a bootstrap — works only with CF "Full" (not "Full (strict)").
2. **(Optional) Add `MAX_UPLOAD_FILE_SIZE_MB=50`** to prod `.env` if you want a non-default ceiling. Default 50 if absent.
3. **(Optional) Add `CSP_REPORT_ONLY=True`** — already the default; only set explicitly if you want to flip it later.
4. **Rebuild the backend image.** `requirements.txt` gained `django-csp==3.8` and the Dockerfile is now multi-stage. `deploy.sh` already runs `docker-compose build`, so this happens automatically.
5. **One new migration: `0007_exportedresult_gc_partial_index`.** Bundles four operations (see Migrations table). Drops `CanvasData.soft_proof`, constrains `export_format` choices, adds GC partial index, adds `EmbedSession.callback_url`. Run `docker-compose exec backend python manage.py migrate` after deploy.
6. **Verify healthchecks come up green** — `docker-compose ps` should show `(healthy)` next to `proxy`, `backend`, and `frontend`. The proxy probe hits `/nginx-health` on localhost:80; the backend probe hits `/api/health`; the frontend probe hits `/`. `proxy` `depends_on: backend: { condition: service_healthy }` so a slow backend blocks proxy startup until ready.
7. **Smoke-test login on prod** — bad password should still say "Invalid credentials"; if PIA is reachable, login should succeed. The new error-code distinction (PiaTimeout / PiaServiceUnavailable) only surfaces during actual outages.

### Edge proxy (nginx)

Routing, TLS, and tunables live in [`proxy/nginx/nginx.conf`](proxy/nginx/nginx.conf) — single source, no per-service labels. The `certs/` workflow: paste a Cloudflare Origin Certificate (`SSL/TLS → Origin Server → Create Certificate`, RSA 2048, 15-year, hostnames `product-editor.printo.in` or `*.printo.in`) into `proxy/nginx/certs/origin.crt` and the matching key into `proxy/nginx/certs/origin.key` (`chmod 600`). Set Cloudflare SSL/TLS mode to **Full (strict)**. Skip → `deploy.sh` generates a self-signed bootstrap that requires CF "Full" (not strict). Notable behaviour:

- `^~ /api/auth/`, `^~ /api/internal/proxy/`, `^~ /api/embed/proxy/` → frontend:3000
- `^~ /admin/django-admin/` → backend:8000 with basic auth (file at `proxy/nginx/.htpasswd`, default `admin/admin`)
- `^~ /api/` → backend:8000 (`proxy_buffering off`, `proxy_read_timeout 600s` for streaming ZIPs + sync renders)
- `/` (catch-all) → frontend:3000
- HTTP→HTTPS redirect on port 80
- Real client IP via Cloudflare's `CF-Connecting-IP` header (CF IP allowlist hard-coded; refresh annually from <https://www.cloudflare.com/ips/>)

### Open follow-ups (not blocking)

| # | Action | Owner |
|---|---|---|
| Populate SKU mapping | `PUT /api/sku-layouts/` with real Printo SKU codes (top 5 SKUs from PRD: fridge magnets, photo prints, canvas prints, coasters, photo mugs). The endpoint exists; the data is empty. | Viji / Catalog Ops |
| Monitor CSP violations | Watch DevTools / browser console / future report endpoint while CSP is in report-only. Flip `CSP_REPORT_ONLY=False` once the policy is validated against the editor (Fabric.js `'unsafe-eval'`) and embed iframe (`frame-ancestors`). | Kanna |
| Clean up 56 lint warnings | `pnpm lint` lists them — all `no-unused-vars` (dead imports, unused state setters, unused destructured params). Easy local cleanups; non-blocking. | Kanna |
| printo.in webhook endpoint | Their backend needs to: (1) accept `POST /api/internal/pe-callback` with the v1.8 webhook payload, (2) verify `X-Signature` HMAC against the api_key, (3) fetch `download_url` with the api_key as Bearer auth, (4) attach the ZIP to the order. Their frontend can also listen for `pe:render_job` postMessage for "preparing your design" UX. | printo.in backend + frontend |
| Rate limiter → Redis | If the frontend container is ever scaled horizontally, swap the in-memory `Map` in `src/app/actions/auth.ts` for a Redis-backed limiter. Current single-process limiter is fine for the current single-replica deploy. | Kanna / DevOps |
| Unify LayoutDef shape | The 10 `(layoutDef as any)?.surfaces?.[0]` casts in `editor/layout/[name]/page.tsx` are about a discriminated layout shape (canvas-on-root vs surfaces-array). Pick one canonical shape and migrate. Once done, re-enable `@typescript-eslint/no-explicit-any` to `error`. | Kanna |
