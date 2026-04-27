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
- `src/pia-auth.ts` — NextAuth v5 config; Credentials provider hits PIA; `jwt`/`session`/`redirect` callbacks; custom `CredentialsSignin` subclasses for outage vs. timeout; PIA fetches use `AbortSignal.timeout(10_000)`
- `src/proxy.ts` — Next.js 16 proxy file (formerly `middleware.ts`). Server-side auth gate for `/dashboard/*` and `/editor/layouts/*`; bounces logged-in users away from `/login`. Excludes `/editor/layout/[name]` because that route serves both dashboard and embed flows.
- `src/app/login/page.tsx` + `src/app/actions/auth.ts` — login form + server action; per-IP rate limit (5/min, in-memory); maps `PiaTimeout` / `PiaServiceUnavailable` codes to user-facing messages
- `src/types/next-auth.d.ts` — type augmentation for `Session` (`error`, `is_ops_team`, `accessToken`, `user.role`) and `JWT` — never use `(session as any)`
- `src/app/editor/layout/[name]/page.tsx` — Main editor page; contains `executeServerRender`, `executeBatchDownload`, `handleSubmitDesign`; threshold constant `SERVER_RENDER_THRESHOLD = 20`; dual-mode (dashboard session vs. embed token)
- `src/components/` — React components (FabricEditor.tsx is the canvas core)
- `src/lib/fabric-renderer.ts` — Off-screen canvas renderer for previews and exports; uses pre-computed `frameRects[]` array to avoid repeated coordinate recalculation
- `src/lib/image-utils.ts` — Image metadata extraction; WeakMap caches only `{width, height, orientation}` (not the HTMLImageElement — would OOM at 200 files)
- `src/lib/upload-utils.ts` — Chunked upload utility: `uploadFile()` (single, sequential chunks) and `uploadFiles()` (batched, 4 parallel)
- `src/lib/zip-utils.ts` — Chunked ZIP generation for client-side batch downloads
- `src/lib/file-store.ts` — IndexedDB-backed File persistence keyed by `(orderId, fileId)`; recovers `originalFile` after page refresh. See "B1 — Canvas state file persistence" below.
- `src/app/api/embed/proxy/[...path]/route.ts` — Embed proxy; resolves embed token → `{ apiKey, orderId }`; injects `X-Order-ID` header; caches in-process (110 min TTL, 10k cap)
- `src/types/` — TypeScript interfaces for layouts, surfaces, frames

### Backend Structure
- `api/views.py` — `GenerateLayoutView`, `RenderStatusView`, `EditorRenderView` (chunked-upload render submission), `ChunkedUploadInitView/ChunkView/CompleteView`, `EmbedSessionView/ValidateView`, `RenderJobDownloadView`, `HealthView` (`GET /api/health`, public, used by Docker healthchecks), `SKULayoutView` (`GET/PUT /api/sku-layouts/[<sku>/]` — see Storage Files below)
- `api/tasks.py` — `render_canvas_task` (calls `_extract_frame_transforms` → `LayoutEngine`), `push_to_production_estimator_task`, `garbage_collector_task` (has `soft_time_limit=3300` / `time_limit=3600`)
- `api/models.py` — `APIKey`, `EmbedSession` (+ `order_id` field), `CanvasData` (+ `editor_state` JSON), `RenderJob`, `UploadedFile` (+ `upload_session_id`), `ExportedResult`
- `api/validators.py` — `MAX_FILE_SIZE_MB` reads from `settings.MAX_UPLOAD_FILE_SIZE_MB` (single source via env)
- `layout_engine/engine.py` — Pillow-based high-res PNG/CMYK TIFF renderer; `_smart_downscale()` pre-shrinks source images to 2× frame target; per-frame pan/zoom/rotation from `frame_transforms`; explicit `Image.close()` + `gc.collect()` between canvases
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
- **PNG output**: written without `optimize=True` because the extra DEFLATE pass was a download bottleneck under high concurrency. ZIP archives use `STORED` (no compression) — most images are already PNG-compressed, so DEFLATE on top adds latency without meaningful size reduction.
- **Memory hygiene**: source images are loaded inside a `with Image.open(...) as src` block so file handles release immediately. After each canvas, `_generate_for_surface` and `_generate_soft_proof_for_surface` call `.close()` on the canvas + intermediate CMYK / preview Images, `del` the references, and run `gc.collect()`. Mask images and resized masks are also closed. Without this, 200-canvas batches accumulated several GB of resident PIL state before the worker recycled.
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

1. **Per-IP rate limit** — 5 attempts per 60 s, fixed window, in-memory `Map`. Single-process; if you scale the frontend container horizontally, swap to Redis. IP is read from `X-Forwarded-For` (Traefik / Cloudflare set it).
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

Fabric.js uses pixels; layouts specify mm. Confirm DPI-based conversion is applied consistently in both `fabric-renderer.ts` (client) and `engine.py` (server). ICC profiles live in `backend/django/icc_profiles/`.

## Adding a New Layout Property

1. Update `src/types/` in the frontend
2. Update rendering logic in `fabric-renderer.ts`
3. Update `layout_engine/engine.py` for high-res export
4. Ensure `views.py` persists the new property correctly

## Code Style

Use comments sparingly. Only comment complex or non-obvious logic.

**TypeScript:** `tsconfig.json` is in *progressive strict* mode — `strict: false` but with `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `alwaysStrict`, `noImplicitThis`, `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames` all on. `noImplicitAny` is intentionally off — there are still ~200 `as any` casts (mostly Fabric.js custom properties) that haven't been typed yet. Run `pnpm typecheck` (`tsc --noEmit`) before pushing.

**Lint:** `eslint.config.mjs` is the active config (flat); `pnpm lint` runs `eslint src`. `pnpm lint:fix` auto-fixes the easy ones. The `eslint-config-next/typescript` preset is intentionally not loaded; the new react-hooks v7 strict rules are demoted to `warn` so existing offenders don't break the build — promote to `error` per-rule once they're triaged.

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

- **`/api/internal/proxy/[...path]`** — Dashboard + editor. Authenticated via NextAuth session cookie (`pia-auth.ts` validates against `PIA_API_BASE_URL`). Uses `INTERNAL_API_KEY` (server-side only). `ops/*` sub-paths additionally check `session.is_ops_team`. Returns 401 if `session.error === 'RefreshAccessTokenError'`.
- **`/api/embed/proxy/[...path]`** — Customer-facing iframe embed. Authenticated via short-lived `X-Embed-Token` created at `/api/embed/session`.

Auth env vars required for the internal proxy: `AUTH_SECRET`, `PIA_API_BASE_URL` (default: `https://pia.printo.in/api/v1`).

Note: `src/proxy.ts` (the auth gate) is unrelated to these `/api/*/proxy` routes despite the name overlap. It's the Next.js 16 successor to `middleware.ts` — see "Auth & Login Flow" above.

## Environment Variables

The runtime is driven by env vars (no per-environment Python/JS config files). All listed in `.env.example`.

**Required in production:**

| Var | Purpose |
|---|---|
| `PUBLIC_HOST` / `DOMAIN_NAME` | Hostname Traefik routes for (e.g. `product-editor.printo.in`) |
| `LETSENCRYPT_EMAIL` | Real address Traefik uses for ACME cert issuance |
| `AUTH_SECRET` | NextAuth JWT signing secret (≥ 32 chars) |
| `INTERNAL_API_KEY` | API key the internal proxy sends to Django |
| `PIA_API_BASE_URL` | Upstream auth (default `https://pia.printo.in/api/v1`) |
| `OMS_PRODUCTION_ESTIMATOR_URL` | Where rendered files get pushed |
| `POSTGRES_*` / `REDIS_URL` | Standard infra |

**Tunables with safe defaults:**

| Var | Default | Effect |
|---|---|---|
| `DEBUG` | `0` | Defaults off — production-safe even when var is missing |
| `MAX_UPLOAD_FILE_SIZE_MB` | `50` | Single source of truth — read by `settings.py`, `validators.py`, and chunked-upload init |
| `DB_CONN_MAX_AGE` | `600` | Persistent DB connection age in seconds; raise / set to `0` if PgBouncer is in front |
| `CSP_REPORT_ONLY` | `True` | django-csp emits headers but enforces nothing — flip to `False` once policy is validated |
| `CELERY_CONCURRENCY` | unset | Celery auto-detects from CPU count; set to cap on shared servers |
| `SECURE_SSL_REDIRECT` | `True` if `DEBUG=0` | Set to `False` if Traefik is doing the redirect |
| `CORS_ALLOW_ALL_DEVELOPMENT` | `true` | Only honored when `DEBUG=1` |

## Security Rules

- API keys must never appear in URLs — use the `EmbedSession` token system
- All file-serving endpoints must validate UUID v4 format on `upload_id` before opening any path derived from request input
- New API endpoints must use `IsAuthenticatedWithAPIKey` permission; add `is_ops_team` check for internal endpoints
- The login server action enforces a per-IP rate limit (5 attempts / 60 s, in-memory). If you scale the frontend container horizontally, replace it with a Redis-backed limiter — the in-memory `Map` in `src/app/actions/auth.ts` is per-process.
- `DEBUG` defaults to off (`os.getenv("DEBUG", "0") == "1"`) — production-safe even if the env var is missing. Don't flip the default back.
- django-csp ships in **report-only** mode (`CSP_REPORT_ONLY=True`). Watch DevTools and the violation reports; flip to `False` only after the policy has been validated against the editor (Fabric.js needs `'unsafe-eval'`) and the embed iframe (`frame-ancestors` allows `https://printo.in` and `https://*.printo.in`).
- `redirect` callback in `pia-auth.ts` clamps `callbackUrl` — relative paths join to `baseUrl`, absolute URLs only allowed on same origin. Don't loosen this without thinking through open-redirect attacks.

## Known Issues

No open P0/P1 issues. Previously tracked items B1, B3, B4, B5 have all shipped — see "Fixed" below for what each does and how to extend.

**Watch list (not blocking):**
- NextAuth 5 is still in beta. The `(session as any)` casts have been removed, but if you bump the version, recheck `next-auth.d.ts` against the upstream `Session` / `JWT` shapes.
- ESLint surfaces 18 dependency-array / purity warnings from the new react-hooks v7 rules. Triage and promote to errors once cleaned (`react-hooks/exhaustive-deps`, `react-hooks/purity`, `react-hooks/set-state-in-effect`, `react-hooks/refs`, `react-hooks/immutability` are all `warn` in `eslint.config.mjs`).
- `tsconfig.json` has `noImplicitAny: false` because ~200 `as any` casts (mostly Fabric.js custom properties) haven't been typed yet. The `eslint-config-next/typescript` preset is intentionally not loaded in `eslint.config.mjs` for the same reason.

### Fixed

- **B1 — Canvas state file persistence.** `src/lib/file-store.ts` is an IndexedDB store keyed by `(orderId, fileId)`. Each frame and image overlay carries an optional `fileId` (UUID) on `FrameState` / `ImageOverlay`. A self-stabilising effect in `editor/layout/[name]/page.tsx` walks `surfaceStates` after every change, persists any `originalFile` that lacks a `fileId`, and patches the new id back into state. The auto-restore effect calls `getFilesForOrder(orderId)` and rehydrates `originalFile` for any frame/overlay whose `fileId` is in the IndexedDB map. Net effect: refreshing the page restores not just dataUrl previews but the original Files needed to re-render.
- **B3 — SKU → layout resolution.** `storage/sku_layouts.json` holds a `{ sku → layout_name }` mapping. `GET /api/sku-layouts/` returns the full mapping; `GET /api/sku-layouts/<sku>/` returns a single resolution (404 if unmapped, 410 if mapped to a deleted layout). `PUT /api/sku-layouts/` replaces the mapping (ops-team only). Public-read so printo.in can resolve the layout before creating an embed session. Cache headers: `public, max-age=300, stale-while-revalidate=600`.
- **B4 — ESLint flat config.** Replaced `.eslintrc.json` with `eslint.config.mjs`. `pnpm lint` now runs `eslint src` directly (Next.js 16 removed the `next lint` subcommand). The strict TypeScript preset is intentionally not loaded — see watch list above.
- **B5 — Stale `.next/` cache.** Added `pnpm clean` (deletes `.next/`) and `pnpm dev:clean` (clean + start dev). If you ever see Next.js routes 404 in local dev, run `pnpm dev:clean` instead of `pnpm dev`.

## What to Do Next

The full prioritised list is in [PRD.md](PRD.md) §8 — these are the items that touch this codebase or its deploy.

### Before / during the next `./deploy.sh`

1. **Add `LETSENCRYPT_EMAIL=<real address>` to prod `.env`** — Traefik ACME issuance fails silently without it; previously undocumented.
2. **(Optional) Add `MAX_UPLOAD_FILE_SIZE_MB=50`** to prod `.env` if you want a non-default ceiling. Default 50 if absent.
3. **(Optional) Add `CSP_REPORT_ONLY=True`** — already the default; only set explicitly if you want to flip it later.
4. **Rebuild the backend image.** `requirements.txt` gained `django-csp==3.8` and the Dockerfile is now multi-stage. `deploy.sh` already runs `docker-compose build`, so this happens automatically.
5. **No new migrations.** Latest is still `0006_embedsession_order_id`. Keep running `docker-compose exec backend python manage.py migrate` after deploy as the standard step — it'll be a no-op if 0006 is already applied.
6. **Verify healthchecks come up green** — `docker-compose ps` should show `(healthy)` next to `backend` and `frontend`. The backend probe hits `/api/health`; the frontend probe hits `/`. Frontend now `depends_on: backend: { condition: service_healthy }`, so a slow backend will block frontend startup until ready.
7. **Smoke-test login on prod** — bad password should still say "Invalid credentials"; if PIA is reachable, login should succeed. The new error-code distinction (PiaTimeout / PiaServiceUnavailable) only surfaces during actual outages.

### Open follow-ups (not blocking)

| # | Action | Owner |
|---|---|---|
| Populate SKU mapping | `PUT /api/sku-layouts/` with real Printo SKU codes (top 5 SKUs from PRD: fridge magnets, photo prints, canvas prints, coasters, photo mugs). The endpoint exists; the data is empty. | Viji / Catalog Ops |
| Monitor CSP violations | Watch DevTools / browser console / future report endpoint while CSP is in report-only. Flip `CSP_REPORT_ONLY=False` once the policy is validated against the editor (Fabric.js `'unsafe-eval'`) and embed iframe (`frame-ancestors`). | Kanna |
| Triage 18 react-hooks warnings | `pnpm lint` lists them. Mostly `react-hooks/exhaustive-deps` and the new v7 `purity` / `set-state-in-effect` / `refs` / `immutability` rules. Promote each to `error` once the existing offenders are fixed. | Kanna |
| printo.in postMessage listener | The parent storefront still needs to listen for `pe:render_job` and poll `/api/render-status` for the embed > 20-canvas flow. | Frontend (printo.in) |
| Direct-to-production webhook | Post-checkout push to OMS for the legacy sync flow. | Kanna |
| Rate limiter → Redis | If the frontend container is ever scaled horizontally, swap the in-memory `Map` in `src/app/actions/auth.ts` for a Redis-backed limiter. Current single-process limiter is fine for the current single-replica deploy. | Kanna / DevOps |
| (Eventually) flip `tsconfig.json` `strict: true` | Requires typing the ~200 `as any` Fabric.js casts; not blocking. | Kanna |
