# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Product Editor is a full-stack print-file generator for Printo.in. Customers upload and compose photos on an interactive canvas editor; the system asynchronously renders 300-DPI print files (PNG, with PDF as an alternate format) and delivers them either via direct download (dashboard users fetch the ZIP) or via a signed webhook to the embed caller's `callback_url` (printo.in's storefront then pulls the same download URL from its backend). The app does NOT push files to any internal OMS — it's a standalone generator.

## Knowledge Graph

A knowledge graph of this codebase lives in `graphify-out/`. Before investigating architecture questions, tracing data flows, or understanding how components interact, query it first — it's much faster than grepping.

```bash
# Ask a question about the codebase
graphify query "how does the render pipeline work"
graphify query "what calls LayoutEngine"
graphify query "how does the embed session flow work"

# Trace the path between two concepts
graphify path "EditorRenderView" "notify_caller_webhook_task"
graphify path "FabricEditor" "LayoutEngine"

# Explain a specific node
graphify explain "render_canvas_task"
graphify explain "CalendarState"
```

The graph covers all 210 source files (175 code + 24 docs + 11 images). Key communities:
- **Canvas Data & Render Jobs** — Django models, CanvasData, RenderJob
- **Pillow Layout Engine** — engine.py, _composite_canvas, smart downscale
- **Calendar Layout Engine** — materialize_surfaces, calendar_layout.py
- **Pillow Calendar Cell Renderer** — calendar_renderer.py, draw_cell_image
- **Auth & API Key Auth** — BearerTokenAuthentication, PIAAuthentication
- **Canvas Editor UI** — CanvasEditorModal, FabricEditor, ColorPicker
- **Storage & Chunked Upload** — services/storage.py, chunk assembly
- **Login & Rate Limiting** — actions/auth.ts, per-IP rate limit

God nodes (highest connectivity): `LayoutEngine` (46 edges), `APIKeyUser` (39), `BearerTokenAuthentication` / `PIAAuthentication` / `UploadedFile` / `ExportedResult` (35 each).

To update the graph after significant code changes:
```bash
graphify . --update
```

Open `graphify-out/graph.html` in a browser for the interactive visualisation.

---

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
- `src/lib/image-utils.ts` — Image metadata extraction; WeakMap caches only `{width, height, orientation}` (not the HTMLImageElement — would OOM at 200 files). `getImageSize()` is the cache-first dims-only accessor for sweeps that must not re-decode.
- `src/lib/dpi-utils.ts` — Effective print-DPI estimation for the low-res warning (Phase 2). Mirrors the fabric-renderer/engine placement math exactly (rotated bbox → cover/contain baseScale → × zoom); thresholds `DPI_WARN=150` / `DPI_CRITICAL=100`, strict `<` so exactly 150 doesn't warn. Card pills + pre-submit modal notices in `page.tsx` are non-blocking by design. If the placement math changes in either renderer, update this module too.
- `src/lib/upload-utils.ts` — Chunked upload utility: `uploadFile()` (single, sequential chunks) and `uploadFiles()` (batched, 4 parallel)
- `src/lib/zip-utils.ts` — Chunked ZIP generation for client-side batch downloads
- `src/lib/file-store.ts` — IndexedDB-backed File persistence keyed by `(orderId, fileId)`; recovers `originalFile` after page refresh. See "B1 — Canvas state file persistence" below.
- `src/app/api/embed/proxy/[...path]/route.ts` — Embed proxy; resolves embed token → `{ apiKey, orderId }`; injects `X-Order-ID` header; caches in-process (110 min TTL, 10k cap)
- `src/types/` — TypeScript interfaces for layouts, surfaces, frames

### Backend Structure
- `api/views.py` — `GenerateLayoutView`, `RenderStatusView`, `EditorRenderView` (chunked-upload render submission), `ChunkedUploadInitView/ChunkView/CompleteView`, `EmbedSessionView/ValidateView`, `RenderJobDownloadView`, `HealthView` (`GET /api/health`, public, used by Docker healthchecks), `SKULayoutView` (`GET/PUT /api/sku-layouts/[<sku>/]` — see Storage Files below)
- `api/tasks.py` — `render_canvas_task` (calls `_extract_frame_transforms` + `_extract_overlays_per_canvas` + `_build_uploaded_files_map` → `LayoutEngine`), `notify_caller_webhook_task` (only dispatched when `canvas.callback_url` is set; signs payload with HMAC-SHA256 of api_key), `garbage_collector_task` (has `soft_time_limit=3300` / `time_limit=3600`)
- `api/models.py` — `APIKey`, `EmbedSession` (+ `order_id` + `callback_url` fields), `CanvasData` (+ `editor_state` JSON, + `callback_url` propagated from EmbedSession), `RenderJob`, `UploadedFile` (+ `upload_session_id`), `ExportedResult`
- `api/validators.py` — `MAX_FILE_SIZE_MB` reads from `settings.MAX_UPLOAD_FILE_SIZE_MB` (single source via env)
- `layout_engine/engine.py` — Pillow-based high-res PNG/PDF renderer at 300 DPI; `_smart_downscale()` pre-shrinks source images to 2× frame target (BOX resample); 90/180/270° rotation fast-path via `Image.transpose`; per-frame pan/zoom/rotation from `frame_transforms`; explicit `Image.close()` + `gc.collect()` between canvases. CMYK/soft-proof pipeline removed in v1.8. **As of CALENDAR_FEATURE_PRD Phase 1**: `_composite_canvas` now also accepts `overlays` + `uploaded_files` and invokes `services.overlay_renderer.render_overlays` after frame compositing and before the layout mask, so text/shape/image overlays appear in the 300 DPI output (previously preview-only).
- `services/overlay_renderer.py` — `render_overlays(canvas, overlays, canvas_w_px, canvas_h_px, uploaded_files)` draws text / shape / image overlays via Pillow `ImageDraw`. Single bundled font (Inter Variable) per PRD §11.7 — no font picker. Phase 1 deliverable; foundation for Phase 4 (calendar renderer).
- `services/image_loader.py` — **the single choke point for opening customer photos server-side** (`open_source_rgba(path)`): EXIF orientation + ICC→sRGB colour management (Display-P3 iPhone photos, AdobeRGB, CMYK-tagged JPEGs) via lcms2, fail-open on malformed profiles. All three render paths (frames in `engine.py`, image overlays, calendar cell images) load through it; output PNGs are tagged with an explicit sRGB profile (`srgb_profile_bytes()`). Never call `Image.open(...).convert("RGBA")` directly on customer photos — it silently discards the embedded profile and shifts colours in print.
- `services/fonts.py` — `get_font(size_px, weight)` returns a cached `PIL.ImageFont` for the bundled `services/fonts_assets/Inter-Variable.ttf`. Uses the variable axis to serve any weight from a single 859 KB .ttf. Falls back to PIL default on missing-font (logged once). Boot-time `startup_check()` warns if the font is absent.
- `services/fonts_assets/Inter-Variable.ttf` — Inter Variable (Apache 2.0 / SIL OFL 1.1) bundled in the image. README in the same dir documents the install convention.
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
layouts, canvas-state, editor/render, editor/init, render-status, jobs,
upload, fonts, sku-layouts, embed/session, orientation, config,
holidays, calendar-styles
```

Anything else returns 403 *before* token resolution, so an attacker can't probe Django auth surfaces with a stolen embed token.

`orientation` covers `POST /api/orientation/detect` (v1.11 auto-orient). Stateless inference — reads the posted image, returns `{rotation, confidence, source}`, persists nothing. Returns 503 when `AUTO_ORIENTATION_MODE=off`. `config` is the public `AllowAny` flags endpoint the editor reads on mount to decide whether to call `orientation/detect` at all — keep secrets out of it.

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

### Google Sign-In

A second `Credentials` provider (`id: "google"`) in `pia-auth.ts` handles "Sign in with Google". The login page renders a Google Identity Services (GIS) button — client-id only, **no client secret** — which returns a Google **ID token** to the browser. `googleLoginAction` (`app/actions/auth.ts`, same per-IP rate limit as the password flow) dispatches `signIn("google", { id_token })`; the provider POSTs `{ id_token }` to **`{PIA_API_BASE_URL}/auth/google/login/`**, which returns the *same* `{ access, refresh, employee_id, full_name, is_super_user, is_ops_team }` payload as `/auth/`. So the `jwt`/`session` callbacks, token refresh, and Django Bearer auth are all identical to the password flow — Google is just a different way to obtain PIA tokens.

- **Domain gate (`@printo.in`)**: enforced server-side in `authorize`. After PIA validates the token (proving its claims genuine), the ID token is decoded and rejected unless `hd === 'printo.in'` or the verified email ends in `@printo.in` → throws `GoogleDomainNotAllowedError` (code `GoogleDomainNotAllowed` → "Please sign in with your @printo.in Google account."). The client `hd` hint is advisory only.
- **Client ID**: public; read from `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (inlined at build time, so set it before `npm run build`) with printo.in's ID as a hardcoded fallback in `login/page.tsx`. The endpoint path is the const `PIA_GOOGLE_AUTH_PATH` in `pia-auth.ts`.
- **No CSP/COOP changes**: `/login` carries no CSP from `next.config.mjs` (only the embed/layout routes get `frame-ancestors`), and there are no COOP headers, so the GIS script + popup load freely. If CSP is ever enforced on `/login`, the GIS button needs `script-src`/`frame-src`/`connect-src https://accounts.google.com`.
- GIS types live in `src/types/google-gsi.d.ts` (minimal `window.google.accounts.id` surface — no `as any`).

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

**No direct DOM manipulation.** Don't reach for `document.getElementById` / `querySelector`, `innerHTML`, or `appendChild` to build or mutate UI — drive it through React state, props, and refs. Mutating nodes React owns desyncs the virtual DOM and produces bugs that only show up in production builds; `innerHTML` is also an XSS sink. Exempt: off-screen `document.createElement('canvas')` for image work, Fabric.js/Three.js roots held via `useRef`, transient `<a>` elements for downloads, and `window`/`document` listeners registered in an effect with cleanup. If you find existing violations, raise them rather than silently rewriting them.

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

## Calendar product type (v1.13)

A calendar layout is a regular multi-surface layout PLUS `productType: "calendar"` and a `monthRange + calendars[] + calendar` style block. The ops authoring UI is at `/editor/layouts/calendar/[name]`; the customer-facing preview lives at `/dev/calendar-preview` until the embed integration replaces it.

### Render path

1. `LayoutEngine.generate()` detects `productType === "calendar"` and calls `services/calendar_layout.py::materialize_surfaces()` to expand the single template into 12 per-month surface dicts (auto-derived `displayLabel`, `year`, `month`, `holidays`, `activePalette`).
2. **Poster aggregation** (P7.3): when `monthRange.count == 1`, the 12 surfaces are merged into ONE aggregate surface before rendering so all 12 calendars composite onto a single physical page.
3. Each surface routes through `_generate_for_surface` → `_composite_canvas` → `services/calendar_renderer.py::render_calendar()`.
4. Output filenames come from `displayLabel` (P7.1, PRD §11.6): `January 2026.png`, `February 2026.png`, …, `December 2026.png`. Non-calendar multi-surface products also use their ops-set displayLabel when present.
5. Partial-failure handling (P7.2, PRD §11.5): if any 1 of N surfaces fails, partial outputs are cleaned up from disk and a tagged `RuntimeError("Render failed on March 2026 (surface 3 of 12): …")` is raised. Customer-facing retry re-renders all N.

### Calendar-specific storage

All under `STORAGE_ROOT` (env-driven). See [`services/CALENDAR_S3_READINESS.md`](backend/django/services/CALENDAR_S3_READINESS.md) for the full audit.

| Path | Owner | Purpose |
|---|---|---|
| `storage/holidays/<locale>/<year>.json` | `services/calendar_holidays.py` | Auto-loaded holidays. Locales seeded: `en-IN`, `generic`. Years seeded: 2026–2030. Refresh script: `scripts/refresh-holidays.py` (annual ops task). |
| `storage/calendar_palettes/genz/<name>.json` | `services/calendar_layout.py::_resolve_genz_palette` | Gen-Z palette swatches. Customer picks ONE per render. |
| `storage/calendar_styles/<name>.json` | `api/views.py::CalendarStylesView` | Theme preset metadata (modern-minimalist / modern-genz / weekday-highlight). |

### Calendar-feature components

- **Server**:
  - `backend/django/services/calendar_layout.py` — `materialize_surfaces()` expands one template into 12 surfaces; honours `surfaceOverrides` per PRD §10.2.1.
  - `backend/django/services/calendar_renderer.py` — `render_calendar()` draws the grid + pills + holidays; Pillow `ImageFont` binary-search auto-fit for pill text per §4.4.
  - `backend/django/services/calendar_holidays.py` — locale/year file loader.
  - `backend/django/api/validators.py::validate_calendar_layout` — server-side schema validation. Mirrors `validateDraft` in `CalendarLayoutEditor.tsx`.
- **Client**:
  - `frontend/nextjs/src/lib/calendar.ts` — shared month-grid math (TypeScript twin of the Python renderer's grid logic, with parity tests).
  - `frontend/nextjs/src/lib/fabric-calendar.ts` — `buildCalendarFabricGroup()` for in-editor preview.
  - `frontend/nextjs/src/lib/calendar-cell-upload.ts` — cell-image upload orchestrator (chunked upload + IDB persist + optional auto-orient, Phase 8).
  - `frontend/nextjs/src/components/CalendarProductPreview.tsx` — customer-facing 12-tile grid with theme/palette/calendarType controls.
  - `frontend/nextjs/src/components/CalendarEditPanel.tsx` — per-cell editor (text/image/hide overrides). Renders as side rail on `md+`, bottom sheet on narrow viewports (P9.3).
  - `frontend/nextjs/src/components/CalendarLayoutEditor.tsx` — ops authoring UI with per-month override modal.

### Editor → ZIP delivery (calendar variant)

Identical to the standard editor flow except:
- Per-day entries are ONE flat product-wide `{ iso_date: [CellOverride] }` map (`calendarState.cells` in the autosave, `calendar.cells` on every canvas in the render payload). Entries anchor to globally-unique ISO dates, not tile positions — so photo-canvas count and English↔Financial flips can never lose or misplace them. Legacy 12-slot `cellsPerCanvas` arrays are still read (restore + `_extract_calendar_state` both merge them flat).
- `tasks.py::_extract_calendar_state()` pulls customer-side calendar choices (themePreset / calendarType / palette), merges cells flat, and passes `num_canvases` so the engine can slice photos per month.
- **Photo → month mapping (Phase 2):** the frontend caps photo canvases at 12 for calendar products; the engine renders exactly 12 outputs, month *i* compositing photo-canvas *(i mod N)* — 1 uploaded photo cycles to all 12 months, 12 photos map one-per-month. Upload order therefore matters. (Previously N photos produced 12·N files in the ZIP.)
- Theme colours resolve server-side at materialize time (`_resolve_theme_style` reads `storage/calendar_styles/<preset>.json`, ops layout colours win) so weekday-highlight/Gen-Z prints match the preview. Gen-Z paints the palette background; the palette loader reads under `settings.STORAGE_ROOT` (the old `default_storage` path never resolved at render time).
- Materialized surface overlays (ops month artwork) now render in the print, under customer overlays. An opt-in `calendar.monthTitle` style block (`{enabled, x, y, fontSize, color, textAlign}`) synthesizes a "January 2026" text overlay per month without any overlay-authoring UI.
- ZIP filenames embed `displayLabel` (above).

### Customer-facing fail-safes (PRD §11)

- **Feb 29 toast** (P9.2, §11.8): when the customer has Feb 29 entries but the resolved render year is non-leap, the preview shows a dismissible amber banner "X entries on Feb 29 won't appear in YYYY." The entries are NOT deleted — they reappear if the customer flips back to a leap year.
- **Image expired prompt** (P8.2, §11.3): when the server can't resolve an `image` cell-override's uploadId (GC'd, session lapsed, manually purged), the cell editor surfaces an amber "Image expired — please re-upload" banner with Re-upload + Clear actions.
- **Calendar-type flip warning** (P5.2, §11.4): switching English ↔ Financial pops a modal if any existing entries would orphan under the new range. Orphan count is computed by `countOrphanedEntries`.
- **Partial render-failure cleanup** (P7.2, §11.5): see Render path above.

### Embed proxy allowlist for calendar

`frontend/nextjs/src/app/api/embed/proxy/[...path]/route.ts` allowlists these calendar-related paths so the customer-facing editor can load palettes/holidays from inside the iframe:

```
holidays
calendar-styles
```

(In addition to `layouts`, `editor/init`, `editor/render`, `upload`, `render-status`, `jobs`, `canvas-state`, `fonts`, `sku-layouts`, `embed/session`, `orientation` — the universal set.)

### Smoke test

`scripts/smoke-test-calendar.sh` — covers list endpoint, layout schema, style presets, palettes, holidays, SKU mapping, validator gate, and (with `EMBED_BASE` set) the embed-proxy allowlist. 19 checks; runs in ~3 s against the local stack. Negative test confirms `/ops/layouts` is still rejected with 403 through the proxy.

### Performance

12-surface multi-surface calendar render: **~1.8 s** wall time on the dev Docker container (P9.5 baseline, May 24 2026). Target was ≤ 90 s; current margin is 88 s. Per-surface mean ~150 ms; RSS delta < 1 MB. Re-run `/tmp/p9-perf-bench.py` (Phase 9 artifact) to check for regressions when the engine changes.

## Auto-orientation (server-side MediaPipe Pose)

The editor decides whether to rotate an uploaded photo 90°/180°/270° in two layers:

1. **Server-side MediaPipe Pose Landmarker** (primary, v1.11). Inline endpoint at `POST /api/orientation/detect` runs BlazePose, computes the nose-to-shoulder-midpoint vector in image coords, snaps it to the nearest cardinal with a 30° dead-zone, and returns `{rotation, confidence, source}`. ~30–150 ms per photo on CPU. Catches photos whose subject is stored sideways in the bytes (camera held wrong, scanned prints, WhatsApp-stripped EXIF) — the exact case where the aspect heuristic can't help.
2. **Aspect-ratio heuristic** (`shouldAutoRotate90` in [page.tsx](frontend/nextjs/src/app/editor/layout/[name]/page.tsx), v1.10). Fallback when ML finds no pose (food / landscape / occluded) or returns 503 (mode off). Compares `imgRatio` to `frameRatio` and rotates only when rotation cuts the gap by ≥ 30%.

**Mode switch** via `.env`:
```bash
AUTO_ORIENTATION_MODE=mediapipe   # BlazePose Lite, ~5 MB, recommended for ≤ 2 cores
# AUTO_ORIENTATION_MODE=hybrid    # BlazePose Full, ~9 MB, recommended for ≥ 4 cores
# AUTO_ORIENTATION_MODE=off       # disable ML; aspect heuristic only
```
Changing the mode only needs `docker compose restart backend` (no image rebuild). The `/api/config` endpoint exposes the active mode to the frontend so the client skips the detect call when `off`. `detectFileOrientation` in `src/lib/ml-orientation.ts` fetches it once per session (memoised in `getRuntimeConfig`) and short-circuits to the aspect heuristic without uploading. If `/api/config` is unreachable it falls through to the detect request, so the server stays authoritative — a 503 there produces the same outcome.

**Model files** live in [`backend/django/services/ml_models/`](backend/django/services/ml_models/) — both Lite (5.5 MB) and Full (9 MB) `.task` files are committed (Apache 2.0, downloaded from Google's public MediaPipe model store). The service module ([`services/orientation.py`](backend/django/services/orientation.py)) lazy-loads the variant matching `AUTO_ORIENTATION_MODE` once per gunicorn worker process, then reuses it.

**Why inline (not Celery + ml-worker)**: `generateCanvases` needs the rotation **before** drawing the canvas preview. Polling for a Celery result would either delay the preview or force a double-render. At our scale (~4 parallel uploads per session, ~50 ms inference each) the gunicorn thread pool absorbs it easily.

**Frontend client** at [`src/lib/ml-orientation.ts`](frontend/nextjs/src/lib/ml-orientation.ts) — per-file memoised by `name:size:lastModified` so the same file never re-uploads for inference within a session. Coalesces concurrent calls.

**Docker layer cost**: `mediapipe==0.10.18` + bundled OpenCV + TFLite ≈ 200 MB on the backend image. The runtime needs `libgl1` + `libglib2.0-0` (system libs OpenCV links against); both are installed in the runner stage of [`backend/django/Dockerfile`](backend/django/Dockerfile). Without them `import mediapipe` raises `ImportError: libGL.so.1: cannot open shared object file` and the orientation service silently disables itself.

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

Run only via the `backend` (Gunicorn) container — never from worker or beat containers. Current latest migration: `0009_renderjob_status_completed_idx`.

| Migration | Change |
|---|---|
| 0001 | Initial schema |
| 0002 | `CanvasData.callback_url` |
| 0003 | `CanvasData.editor_state` + `UploadedFile.upload_session` |
| 0004 | `CanvasData.updated_at` + GC index |
| 0005 | `CanvasData` uniqueness changed to `(order_id, api_key)` — tenant isolation |
| 0006 | `EmbedSession.order_id` — stores caller's job ID; injected as `X-Order-ID` by embed proxy |
| 0007 | v1.8 bundle: `(is_deleted, created_at)` partial index on `ExportedResult` (GC speedup) + drop `CanvasData.soft_proof` (CMYK retired) + `CanvasData.export_format` choices=('png','pdf') + `EmbedSession.callback_url` (webhook URL, propagated to CanvasData via `X-Callback-URL` header) |
| 0008 | `CanvasData.render_state` — submit-time render payload snapshot. Separates the two writers that shared `editor_state` (autosave vs submit): submit no longer wipes the customer's auto-saved design, and a post-submit autosave can't strip a queued job's payload. `render_canvas_task` reads `render_state or editor_state` (legacy fallback for jobs enqueued pre-deploy). |
| 0009 | Consolidates drifted model state: two `RenderJob` indexes (`queue_name/status/created_at`, `status/completed_at`) that existed in the model but never got a migration, drops a duplicate `celery_task_id` index, renames the 0007 partial index to Django's auto-name. |

**Ownership contract (post-0008):** `editor_state` is frontend-owned — written ONLY by `CanvasStateView` (autosave), read by the restore path. `render_state` is pipeline-owned — written ONLY by `EditorRenderView` at submit (`{canvases, image_paths, format_version}`), read by `render_canvas_task` via `_resolve_render_inputs`. Never cross the streams.

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
| `MAX_IMAGE_DIMENSION_PX` | `16384` | Max allowed image side (px) at upload validation (`validators.py`). Raised from 8192 so high-res photos (48–65 MP) upload. Decompression-bomb guard only — engine caps total pixels at `Image.MAX_IMAGE_PIXELS` (500 MP) and smart-downscales sources |
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
