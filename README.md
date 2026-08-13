# Product Editor — Printo.in Photo Layout Generator

A production-ready full-stack application for generating photo layouts for personalised print products. Customers upload images, compose them on an interactive canvas, and the system renders high-resolution print files. Files are delivered either by direct download (dashboard) or by a signed HMAC webhook to the embed caller's `callback_url` (printo.in's storefront pulls the ZIP from its backend). The app is a **standalone print-file generator** — no internal OMS push.

---

## Knowledge Graph

The repository includes a code knowledge graph in `graphify-out/`. For architecture questions, dependency tracing, or understanding how a frontend flow reaches the backend render pipeline, query it before grepping the tree.

```bash
graphify query "how does the render pipeline work"
graphify path "EditorRenderView" "notify_caller_webhook_task"
graphify explain "render_canvas_task"
graphify update .
```

Use `graphify update .`, not `graphify . --update`. The `update` subcommand refreshes the code graph locally without requiring an LLM API key.

---

## Technology Stack

**Backend**
- Django 5.0.6 + Django REST Framework
- PostgreSQL 16 (tuned: `shared_buffers=128MB`, `work_mem=8MB`, `effective_cache_size=384MB`, slow-query log at 1 s)
- Pillow — high-resolution rendering at 300 DPI (PNG default, PDF alternate)
- Celery 5 + Redis 7 — async render queue with priority/standard worker isolation; Redis split (broker on db `0`, Django cache on db `1`) so `allkeys-lru` eviction can't drop in-flight task messages
- Gunicorn (gthread, `(2 × nproc) + 1` workers) — web serving
- Bearer token API authentication + short-lived embed session tokens (HMAC-signed callback webhooks)

**Frontend**
- Next.js 16 (App Router, `output: 'standalone'`)
- React 19, TypeScript 5.7 (full strict mode)
- Fabric.js 7.2 — interactive canvas editing, lazy-loaded via `next/dynamic`
- Tailwind CSS 3.4
- Service Worker at `/sw.js` — cache-first for `/_next/static/*` and `/static/*` (warm visits skip the CDN)
- Performance optimized for large batches (100–200+ images) via parallel BATCH_SIZE-8 metadata extraction, IndexedDB-cached smartcrop, and content-hashed asset caching

**Infrastructure**
- Docker Compose
- nginx 1.27 — edge proxy; TLS terminates at the origin using a Cloudflare Origin Certificate
- Redis 7 — Celery broker, result backend, and status-polling cache
- PostgreSQL 16

---

## Services

| Service | Purpose |
|---|---|
| `backend` | Django API + Gunicorn web server |
| `frontend` | Next.js customer-facing editor |
| `celery-worker-standard` | Render worker — the only one. Consumes `priority,standard` (nothing produces to `priority`; it is drained so a stray dispatch can't be lost) |
| `celery-beat` | Periodic task scheduler (daily GC at 02:00 UTC) |
| `redis` | Broker, result backend, status cache |
| `db` | PostgreSQL database |
| `proxy` | nginx edge proxy + TLS termination (Cloudflare Origin Certificate) |

---

## Quick Start (Local Dev)

```bash
git clone <repository-url>
cd product-editor
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY, AUTH_SECRET, EMBED_INTERNAL_SECRET,
# INTERNAL_API_KEY, POSTGRES_PASSWORD, DIRECT_API_KEY (see .env.example for
# generation commands)
```

**First-time-only step:** the nginx `proxy` service bind-mounts a TLS cert that's gitignored, so a bare `docker-compose up -d` on a fresh clone will crash-loop `proxy` until one exists. Either let `./deploy.sh` bootstrap a self-signed one, or generate it yourself:

```bash
mkdir -p proxy/nginx/certs
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout proxy/nginx/certs/origin.key -out proxy/nginx/certs/origin.crt \
  -subj "/CN=localhost/O=product-editor self-signed"
chmod 600 proxy/nginx/certs/origin.key
```

Then bring the stack up:

```bash
docker-compose up -d
docker-compose exec backend python manage.py migrate
```

| Endpoint | URL |
|---|---|
| Frontend | https://localhost (via nginx proxy) or http://localhost:5004 (direct) |
| Backend API | http://localhost:8000/api |
| Django Admin | http://localhost:8000/django-admin/ |
| API Docs (Scalar) | http://localhost:8000/docs/api/ |

> **Note:** `.env.local` in `frontend/nextjs/` overrides docker-compose env vars. Always set `INTERNAL_API_URL=http://backend:8000/api` (not `localhost`) when running inside Docker. If `5004`/`8000`/`5432` conflict with other projects on your machine, override `FRONTEND_HOST_PORT` / `BACKEND_HOST_PORT` / `POSTGRES_HOST_PORT` in `.env`.

### Alternative: frontend outside Docker (faster iteration)

Run the backend + infra in Docker, but the Next.js dev server on the host for hot reload:

```bash
docker-compose up -d backend db redis redis-cache celery-worker-standard
cd frontend/nextjs
pnpm install
pnpm dev         # http://localhost:3000
# If routes start 404ing in dev, use:
pnpm dev:clean
```

Set `frontend/nextjs/.env.local` so it talks to the Dockerized backend (`INTERNAL_API_URL=http://localhost:8000/api`, plus the same `INTERNAL_API_KEY` / `AUTH_SECRET` as `.env`).

---

## Development Commands

### Frontend

```bash
cd frontend/nextjs
pnpm dev
pnpm dev:clean
pnpm build
pnpm typecheck
pnpm lint
pnpm lint:fix
```

### Backend

```bash
cd backend/django
python manage.py migrate
python manage.py showmigrations
python manage.py shell
```

### Tests

Frontend tests run with Jest:

```bash
cd frontend/nextjs
pnpm test
pnpm test:watch
pnpm test -- src/lib/__tests__/dpi-utils.test.ts
pnpm test -- -t "clamps the offset"
pnpm test:parity
```

Backend tests are standalone modules under `backend/django/services/tests/` and are usually run through the backend container because the host Python environment often lacks Django/Pillow:

```bash
docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_caption_layout
docker-compose run --rm --entrypoint bash backend -c 'for f in services/tests/test_*.py; do /opt/venv/bin/python -m "services.tests.$(basename "$f" .py)" || echo "FAIL $f"; done'
```

If you already have a local virtualenv with `requirements.txt` installed, set `DEBUG=1` before running the backend tests directly so Django's production secret-key guard does not abort startup.

---

## Utility Scripts

```bash
./deploy.sh
./fresh-install.sh
./benchmark.sh
API_KEY=<key> [BASE=<url>] ./scripts/smoke-test-embed.sh
API_KEY=<key> [BASE=<url>] ./scripts/smoke-test-calendar.sh
./scripts/test-backup-restore.sh
./scripts/backup.sh
./scripts/restore.sh
```

Both smoke tests default to `BASE=http://localhost:5004`. To exercise the nginx edge locally, use `BASE=https://localhost` and pass `-k` to `curl` because the local certificate is self-signed.

---

## Production Deployment

### 1. Server prerequisites

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo apt install docker-compose-plugin -y
```

### 2. Configure environment

```bash
cp .env.example .env && nano .env
```

Required production values:

```env
DJANGO_SECRET_KEY=<50-char random string>
AUTH_SECRET=<50-char random string>          # NextAuth JWT signing secret
EMBED_INTERNAL_SECRET=<random string>        # gates the embed session-validate endpoint
DEBUG=0
PUBLIC_HOST=product-editor.printo.in
POSTGRES_PASSWORD=<strong password>
DIRECT_API_KEY=<ops team key>
EXTERNAL_API_KEY=<embed partner key>
INTERNAL_API_KEY=<same value as DIRECT_API_KEY — server-only, never NEXT_PUBLIC_>
REDIS_URL=redis://redis:6379/0
```

Compose aborts on boot if `AUTH_SECRET` is missing, and Django refuses to start under `DEBUG=0` with a default `DJANGO_SECRET_KEY` — both are hard requirements, not just recommended.

Generate secret key:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

### 3. TLS preparation (nginx + Cloudflare Origin Certificate)

```bash
# Production: paste the Cloudflare Origin Certificate into these files.
# Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate
# (defaults are fine: RSA 2048, 15-year). Then SSL/TLS mode → "Full (strict)".
mkdir -p proxy/nginx/certs
echo "<paste cert body>"  > proxy/nginx/certs/origin.crt
echo "<paste private key>" > proxy/nginx/certs/origin.key
chmod 600 proxy/nginx/certs/origin.key

# OR: skip this step — `./deploy.sh` will generate a self-signed cert as a
# bootstrap. Works only with Cloudflare SSL/TLS mode set to "Full" (not strict).
```

### 4. Deploy

```bash
docker-compose up -d
docker-compose logs -f backend   # watch for migration output
```

### 5. Scale workers for peak load

```bash
# Add more standard workers during festival seasons
docker-compose up -d --scale celery-worker-standard=4
```

---

## API Reference

All backend endpoints (except `/api/health`) require `Authorization: Bearer YOUR_API_KEY`.

If you want to browse the API in the browser:

| Purpose | Local URL | Path |
|---|---|---|
| Interactive API docs (Scalar UI) | `http://localhost:8000/docs/api/` | `/docs/api/` |
| Raw OpenAPI schema (JSON) | `http://localhost:8000/api/schema/` | `/api/schema/` |

If you're using the nginx edge locally, the docs are also available at `https://localhost/docs/api/`.

The Next.js frontend uses two server-side proxies — neither exposes an API key to the browser:

| Proxy | Path | Used by |
|---|---|---|
| Embed proxy | `/api/embed/proxy/[...path]` | Customer-facing iframe embed (X-Embed-Token auth) |
| Internal proxy | `/api/internal/proxy/[...path]` | Dashboard + editor (NextAuth session cookie auth) |

### Core endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check (public) |
| `GET` | `/api/layouts` | List available layouts |
| `GET` | `/api/layouts/{name}` | Layout definition |
| `POST` | `/api/layout/generate` | Direct partner API — always async, requires `order_id` |
| `POST` | `/api/editor/render` | Editor/embed render submission (used by the dashboard + iframe editor, not direct partners) |
| `GET` | `/api/render-status/{job_id}/` | Async job status |
| `GET` | `/api/jobs/{job_id}/download/` | Download the rendered ZIP |
| `POST` | `/api/embed/session` | Create short-lived embed token (accepts `order_id` + optional `callback_url`) |
| `GET` | `/api/celery/monitor/` | Queue/worker stats (ops team only) |

### Direct partner generation

Every request is async — `order_id` is mandatory (there is no synchronous mode). The old `soft_proof` / `tiff_cmyk` / `callback_url` body params were removed in v1.8; output is PNG (default) or PDF only, and webhooks are configured exclusively at embed-session creation (see below), never per-request.

```bash
curl -X POST https://product-editor.printo.in/api/layout/generate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "layout=CIRCLE_48MM" \
  -F "order_id=ORD-20260405-001" \
  -F "fit_mode=cover" \
  -F "export_format=png" \
  -F "images=@photo.jpg"
```

Response `202 Accepted`:
```json
{
  "job_id": "cb842c45-b0e7-41bb-8a70-9cf72473ec55",
  "status_url": "/api/render-status/cb842c45-b0e7-41bb-8a70-9cf72473ec55/",
  "queue": "standard",
  "estimated_wait_seconds": 60
}
```

Poll status:
```bash
curl https://product-editor.printo.in/api/render-status/cb842c45-.../
  -H "Authorization: Bearer YOUR_API_KEY"
```

Then download:
```bash
curl -o output.zip https://product-editor.printo.in/api/jobs/cb842c45-.../download/ \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Webhook delivery (embed flow only)

Webhooks are opt-in, set once at `POST /api/embed/session` via `callback_url` — not per render request. When a job created through an embed session completes, `notify_caller_webhook_task` POSTs the payload below to that URL with an `X-Signature: sha256=<hmac>` header (HMAC-SHA256 of the raw body, keyed by the caller's api_key):

```json
{
  "order_id": "EXT-JOB-123",
  "job_id": "<RenderJob uuid>",
  "status": "completed",
  "download_url": "https://product-editor.printo.in/api/jobs/<uuid>/download/",
  "expires_at": "<ISO 8601>",
  "file_count": 12,
  "layout_name": "circle_48mm",
  "export_format": "png"
}
```

Direct API callers without an `EmbedSession` (i.e. the `/api/layout/generate` flow above) always poll `/api/render-status/{job_id}/` — no webhook fires for them.

### Output formats

`export_format` is `png` (default) or `pdf`. The CMYK / soft-proof / TIFF pipeline was retired in v1.8 — output is RGB PNG/PDF only.

```bash
-F "export_format=pdf"   # default is 'png'
```

---

## Async Queue Architecture

```
dashboard or embed editor submit
        │
        ├── uploads source files via chunked upload API
        │
        ▼
POST /api/editor/render (or embed proxy)
        │
        ▼
  ┌─────────────────┐        ┌──────────────────────────────────┐
  │   Django API    │─enqueue─▶  Redis (standard queue)          │──▶ celery-worker-standard
  │  (202 response) │        │  Redis (priority queue — unused)  │──▶  (same worker, -Q both)
  └─────────────────┘        └──────────────────────────────────┘
                                             │
                                     render complete
                                             │
                 ┌───────────────────────────┴───────────────────────────┐
                 │                                                       │
      embed flow with callback_url                              dashboard / direct API
                 │                                                       │
      ┌──────────▼──────────────┐                              poll /api/render-status
      │ notify_caller_webhook_  │──▶ HMAC-signed POST to       then GET /api/jobs/<id>/download
      │ task (separate task)    │    EmbedSession.callback_url
      └─────────────────────────┘
```

Key behaviours:
- **At-least-once delivery** — `task_acks_late=True` + `task_reject_on_worker_lost=True`
- **Retry on failure** — up to 3× with exponential backoff (2s, 4s, 8s); tracked in `RenderJob.retry_count`
- **MemoryError / soft time limit** — skips retries, fails immediately
- **Order resubmit** — `update_or_create` on `order_id`; resubmissions never crash
- **Dispatch safety** — Redis failure in `on_commit` marks job `failed` with error; never silently stuck in `queued`
- **Caller webhook** — separate Celery task, only dispatched when `canvas.callback_url` is set; retries 5× independently; sets `requires_manual_review=True` on final failure
- **Single render path** — both embed "Save & Continue" and dashboard download use the same server-side render flow; the old small-job browser render shortcut is gone

---

## Database Management

```bash
# Backup
docker-compose exec db pg_dump -U postgres product_editor > backup_$(date +%Y%m%d).sql

# Restore
cat backup.sql | docker-compose exec -T db psql -U postgres product_editor

# Run migrations after code update
docker-compose exec backend python manage.py migrate
```

Current migrations (latest: `0014_audit_trail`):

| Migration | Change |
|---|---|
| 0001 | Initial schema — `APIKey`, `RenderJob`, `ExportedResult`, `EmbedSession`, `UploadedFile`, `CanvasData` |
| 0002 | `CanvasData.callback_url` |
| 0003 | `CanvasData.editor_state` + `UploadedFile.upload_session` |
| 0004 | `CanvasData.updated_at` + GC index |
| 0005 | `CanvasData` uniqueness changed to `(order_id, api_key)` for tenant isolation |
| 0006 | `EmbedSession.order_id` — caller's job ID injected as `X-Order-ID` by the embed proxy |
| 0007 | v1.8 bundle: partial GC index on `ExportedResult`, removal of CMYK soft-proof fields, `export_format` choices `png|pdf`, and `EmbedSession.callback_url` |
| 0008 | `CanvasData.render_state` — separates submit-time render payload from autosaved `editor_state` |
| 0009 | Adds missing `RenderJob` indexes, removes duplicate `celery_task_id` index, renames the 0007 partial index to Django's auto-generated name |
| 0010 | `EmbedSession.include_uploads` — allows the delivered ZIP to omit original uploads |
| 0011 | `UploadedFile.order_id` — preserves order linkage for DPDP erasure and file cleanup |
| 0012 | Stored `expires_at` defaults and backfill for `UploadedFile` / `ExportedResult` so webhook expiry and GC retention stay aligned |
| 0013 | `CanvasData.image_paths` default list — fixes first-autosave failures on new orders |
| 0014 | API audit trail hardening: `APIRequest.api_key` becomes nullable `SET_NULL`, plus `APIRequest.auth_source` |

---

## Monitoring

```bash
# Service status
docker-compose ps

# Live logs
docker-compose logs -f celery-worker-standard

# Queue depth + worker stats (ops key required)
curl https://product-editor.printo.in/api/celery/monitor/ \
  -H "Authorization: Bearer OPS_API_KEY"

# Worker memory
docker stats product-editor-celery-worker-standard-1
```

---

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Jobs stuck in `queued` | `docker-compose ps celery-worker-*` | Restart workers; verify Redis is reachable |
| Worker exits immediately | `docker-compose logs celery-worker-*` | Check Redis connection; verify migrations ran |
| `ClientFetchError` on frontend login | `frontend/nextjs/.env.local` | Set `INTERNAL_API_URL=http://backend:8000/api` (not `localhost`) |
| Dashboard shows empty / 500 | Missing `INTERNAL_API_KEY` env var | Add `INTERNAL_API_KEY=<same as DIRECT_API_KEY>` to `.env.local` — the internal proxy refuses to forward without it |
| Dashboard/editor returns 401 after long idle | Session token expired | `pia-auth.ts` refresh flow kicks in automatically; if PIA is unreachable the user is redirected to `/login` |
| Frontend not loading | Port | Use `localhost:5004`, not `:3000` |
| Webhook push failing repeatedly | `CanvasData.requires_manual_review` in Admin | Check the caller's `callback_url` is reachable + accepts POST; order flagged after 5 failures |
| High worker memory | `docker stats` | Workers are already at concurrency=2; scale out with `--scale celery-worker-standard=N` |

---

## Security

- Bearer token + per-key permission flags (`can_generate_layouts`, `can_access_exports`, `is_ops_team`)
- **Embed flow**: short-lived UUID embed tokens exchanged server-side at `/api/embed/proxy` — real API key never touches the browser
- **Dashboard / editor flow**: all calls proxied through `/api/internal/proxy` (gated by NextAuth session cookie + `INTERNAL_API_KEY` server env var) — no API key in client JS bundle
- Destructive internal ops routes need an explicit proxy-side guard. The shared `INTERNAL_API_KEY` is ops-flagged, so Django-side `IsOpsTeam` alone does not protect routes reached through the internal proxy
- Path traversal protection: UUID v4 regex validation on all `upload_id` parameters
- `APIKey.last_used_at` writes throttled to once per 5 minutes to reduce DB write churn
- CORS restriction + security headers (HSTS, X-Frame-Options, nosniff)
- File upload validation (type, size, dimensions)
- Full request audit trail in `api_requests` table
- `Retry-After` header included in all 429 rate-limit responses

### Production checklist

- [ ] `DEBUG=0`
- [ ] `DJANGO_SECRET_KEY` — strong random value
- [ ] `ALLOWED_HOSTS` set to production domain
- [ ] `POSTGRES_PASSWORD` — strong random value
- [ ] `INTERNAL_API_KEY` set (server-only, same value as `DIRECT_API_KEY`) — **never** use `NEXT_PUBLIC_DIRECT_API_KEY` in production
- [ ] `NEXT_PUBLIC_DIRECT_API_KEY` removed from all env files once `INTERNAL_API_KEY` is confirmed working
- [ ] Rotate `DIRECT_API_KEY` / `INTERNAL_API_KEY` if either was ever deployed as `NEXT_PUBLIC_*`
- [ ] Firewall: open only 80, 443, 22
- [ ] `proxy/nginx/certs/origin.key` — `chmod 600` (Cloudflare Origin Certificate, or self-signed bootstrap)
- [ ] API keys have minimum necessary permissions
- [ ] Regular DB backups scheduled

---

## File Storage

```
storage/
├── uploads/    # customer-uploaded source images
├── layouts/    # JSON layout templates
├── masks/      # SVG/PNG mask files
└── exports/    # generated render outputs
```

Retention is controlled by stored `expires_at` values and `EXPORT_RETENTION_DAYS` rather than the older hard-coded 30-day / 14-day behaviour. The repo also stores SKU mappings in `storage/sku_layouts.json`, and chunk uploads are staged under `UPLOADS_DIR/.chunks/<upload_id>/` during assembly.

---

## Environment Variables

The README now follows `.env.example`, which is the source of truth for local and production configuration.

### Core runtime

| Variable | Required | Description |
|---|---|---|
| `COMPOSE_PROFILES` | No | Compose profile selection. `.env.example` enables the nginx edge via `prod` |
| `NODE_ENV` | Yes | Runtime mode. `.env.example` uses `production` |
| `DEBUG` | Yes | `0` for production; defaults to off even if unset |
| `DJANGO_SECRET_KEY` | Yes | Django secret key. Boot fails under `DEBUG=0` if left at the dev default |
| `PUBLIC_HOST` | Yes | Hostname nginx accepts; also used in the bootstrap cert CN |
| `SECURE_SSL_REDIRECT` | No | Set `False` when nginx already redirects HTTP→HTTPS |
| `ALLOWED_HOSTS` | Yes | Comma-separated Django host allowlist |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed browser origins |

### Database

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_HOST` | Yes | Database host, usually `db` in Docker |
| `POSTGRES_PORT` | Yes | Database container port |
| `POSTGRES_HOST_PORT` | No | Host-mapped Postgres port (default `5432`) |
| `POSTGRES_USER` | Yes | Database user |
| `POSTGRES_PASSWORD` | Yes | Database password |
| `POSTGRES_DB` | Yes | Database name |

### API keys and auth

| Variable | Required | Description |
|---|---|---|
| `DIRECT_API_KEY` | Yes | Internal ops team API key seeded into Django on boot |
| `EXTERNAL_API_KEY` | No | External partner key |
| `TESTING_API_KEY` | No | Testing key |
| `INTERNAL_API_KEY` | Yes | Server-only key used by the Next.js internal proxy. Set it to the **same value** as `DIRECT_API_KEY` |
| `AUTH_SECRET` | Yes | NextAuth JWT signing secret (≥ 32 chars). Compose aborts on boot if unset |
| `AUTH_URL` | Yes | Public auth base URL for NextAuth |
| `AUTH_TRUST_HOST` | No | NextAuth host trust toggle |
| `EMBED_INTERNAL_SECRET` | Yes | Shared secret for `/api/embed/session/validate`, used by the embed proxy |
| `PIA_API_BASE_URL` | No | Upstream Printo auth service base URL |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | No | Public Google Sign-In client ID, inlined at frontend build time |

### Frontend and proxy

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Yes | Frontend API base path. `.env.example` uses `/api` through nginx |
| `FRONTEND_HOST_PORT` | No | Host port for the frontend container (default `5004`) |
| `BACKEND_HOST_PORT` | No | Host port for the backend container (default `8000`) |
| `CSP_REPORT_ONLY` | No | Keeps django-csp in report-only mode until policy is validated |

### Storage, uploads, and retention

| Variable | Required | Description |
|---|---|---|
| `STORAGE_ROOT` | Yes | Base storage path from which uploads, layouts, masks, and exports are derived |
| `MAX_UPLOAD_FILE_SIZE_MB` | No | Single source of truth for file upload limits (default `50`) |
| `MAX_IMAGE_DIMENSION_PX` | No | Upload-side decompression-bomb guard for very large images (default `16384`) |
| `EXPORT_RETENTION_DAYS` | No | Retention for rendered outputs and uploaded originals |
| `EXPORT_RETENTION_DAYS_UNDER_PRESSURE` | No | Optional shorter retention once export disk usage crosses the pressure threshold |
| `AUTO_ORIENTATION_MODE` | No | Server-side orientation detection mode: `mediapipe`, `hybrid`, or `off` |

### Redis, workers, and web serving

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | Yes | Redis connection string for Celery broker / result backend |
| `REDIS_CACHE_URL` | No | Django cache Redis URL. In app settings it defaults by swapping Redis db `0` to db `1` |
| `CELERY_CONCURRENCY` | No | Worker slots per container. Leave unset to auto-detect from CPU count |
| `GUNICORN_WORKERS` | No | Gunicorn worker count override |
| `GUNICORN_THREADS` | No | Gunicorn threads per worker |
| `GUNICORN_TIMEOUT` | No | Gunicorn request timeout |
| `GUNICORN_MAX_REQUESTS` | No | Gunicorn recycle threshold per worker |
| `GUNICORN_LOG_LEVEL` | No | Gunicorn log level |

### Audit and security tuning

| Variable | Required | Description |
|---|---|---|
| `API_AUDIT_RETENTION_DAYS` | No | Retention for `APIRequest` audit rows (default `90`) |

---

## License

Proprietary — All rights reserved. Printo.in internal use only.
