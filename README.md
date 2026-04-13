# Product Editor — Printo.in Photo Layout Generator

A production-ready full-stack application for generating photo layouts for personalised print products. Customers upload images, compose them on an interactive canvas, and post-checkout the system renders high-resolution print files and pushes them directly to the production estimator — zero manual preflight required.

---

## Technology Stack

**Backend**
- Django 5.0.6 + Django REST Framework
- PostgreSQL 16
- Pillow — high-resolution image rendering (300 DPI PNG / CMYK TIFF)
- Celery 5 + Redis — async render queue with priority/standard worker isolation
- Gunicorn (gthread) — web serving
- Bearer token API authentication + short-lived embed session tokens

**Frontend**
- Next.js 16 (App Router)
- React 19, TypeScript 5.7
- Fabric.js 7.2 — interactive canvas editing
- Tailwind CSS 3.4
- Performance optimized for large batches (100–200+ images) via parallel rendering and metadata caching

**Infrastructure**
- Docker Compose
- Traefik v3 — reverse proxy with automatic Let's Encrypt TLS
- Redis 7 — Celery broker, result backend, and status-polling cache
- PostgreSQL 16

---

## Services

| Service | Purpose |
|---|---|
| `backend` | Django API + Gunicorn web server |
| `frontend` | Next.js customer-facing editor |
| `celery-worker-priority` | Render worker — `priority` queue only (express / store-pickup orders) |
| `celery-worker-standard` | Render worker — `standard` queue only (regular delivery orders) |
| `celery-beat` | Periodic task scheduler (daily GC at 02:00 UTC) |
| `redis` | Broker, result backend, status cache |
| `db` | PostgreSQL database |
| `proxy` | Traefik reverse proxy + TLS |

---

## Quick Start (Local Dev)

```bash
git clone <repository-url>
cd product-editor
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY, POSTGRES_PASSWORD, API keys
docker-compose up -d
```

| Endpoint | URL |
|---|---|
| Frontend | http://localhost:5004 |
| Backend API | http://localhost:8000/api |
| Django Admin | http://localhost:8000/admin/django-admin/ |
| API Docs (Swagger) | http://localhost:8000/api/docs/ |

> **Note:** `.env.local` in `frontend/nextjs/` overrides docker-compose env vars. Always set `INTERNAL_API_URL=http://backend:8000/api` (not `localhost`) when running inside Docker.

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
DEBUG=0
PUBLIC_HOST=product-editor.printo.in
LETSENCRYPT_EMAIL=devops@printo.in
POSTGRES_PASSWORD=<strong password>
DIRECT_API_KEY=<ops team key>
EXTERNAL_API_KEY=<embed partner key>
INTERNAL_API_KEY=<same value as DIRECT_API_KEY — server-only, never NEXT_PUBLIC_>
REDIS_URL=redis://redis:6379/0
OMS_PRODUCTION_ESTIMATOR_URL=http://oms-service:8080/api/production/estimate
```

Generate secret key:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

### 3. SSL preparation

```bash
touch proxy/traefik/acme.json && chmod 600 proxy/traefik/acme.json
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
| `POST` | `/api/layout/generate` | Generate layout (sync or async) |
| `GET` | `/api/render-status/{job_id}/` | Async job status |
| `GET` | `/api/exports/{filename}` | Download export file |
| `POST` | `/api/embed/session` | Create short-lived embed token |
| `GET` | `/api/celery/monitor/` | Queue/worker stats (ops team only) |

### Sync generation (backward compatible)

```bash
curl -X POST https://product-editor.printo.in/api/layout/generate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "layout=CIRCLE_48MM" \
  -F "fit_mode=cover" \
  -F "images=@photo.jpg"
```

Response: `{"canvases": ["output_abc123.png"]}`

### Async generation (recommended for production)

Include `order_id` in the request to trigger async mode:

```bash
curl -X POST https://product-editor.printo.in/api/layout/generate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "layout=CIRCLE_48MM" \
  -F "order_id=ORD-20260405-001" \
  -F "callback_url=https://oms.printo.in/webhooks/render" \
  -F "fit_mode=cover" \
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

When complete, `callback_url` receives a POST with `status: "completed"` and `output_files`.

### CMYK soft-proof (priority queue)

```bash
-F "soft_proof=true"   # routes to priority queue; outputs PNG + TIFF CMYK + preview PNG
```

---

## Async Queue Architecture

```
POST /api/layout/generate (with order_id)
        │
        ▼
  ┌─────────────────┐        ┌──────────────────────────────────┐
  │   Django API    │─enqueue─▶  Redis (priority queue)          │──▶ celery-worker-priority
  │  (202 response) │        │  Redis (standard queue)           │──▶ celery-worker-standard
  └─────────────────┘        └──────────────────────────────────┘
                                              │
                                      render complete
                                              │
                                  ┌───────────▼────────────┐
                                  │  push_to_production_   │──▶ OMS API + callback_url
                                  │  estimator_task        │    (separate Celery task)
                                  └────────────────────────┘
```

Key behaviours:
- **At-least-once delivery** — `task_acks_late=True` + `task_reject_on_worker_lost=True`
- **Retry on failure** — up to 3× with exponential backoff (2s, 4s, 8s); tracked in `RenderJob.retry_count`
- **MemoryError / soft time limit** — skips retries, fails immediately
- **Order resubmit** — `update_or_create` on `order_id`; resubmissions never crash
- **Dispatch safety** — Redis failure in `on_commit` marks job `failed` with error; never silently stuck in `queued`
- **OMS push** — separate Celery task, retries 5× independently; sets `requires_manual_review=True` on final failure

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

Current migrations:

| Migration | Change |
|---|---|
| 0001 | Initial schema — `APIKey`, `RenderJob`, `ExportedResult`, `EmbedSession`, `UploadedFile`, `CanvasData` |
| 0002 | `CanvasData.callback_url` — per-request webhook URL for OMS push |
| 0003 | `CanvasData.editor_state` JSON field + `UploadedFile.upload_session` — canvas persistence and chunked-upload session tracking |
| 0004 | `CanvasData.updated_at` (`auto_now`) + `canvas_data_expires_idx` index — GC age queries |
| 0005 | `CanvasData` uniqueness changed from global `order_id` to composite `(order_id, api_key)` — tenant isolation fix |

---

## Monitoring

```bash
# Service status
docker-compose ps

# Live logs
docker-compose logs -f celery-worker-priority
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
| OMS push failing repeatedly | `CanvasData.requires_manual_review` in Admin | Check OMS endpoint; order flagged after 5 failures |
| High worker memory | `docker stats` | Workers are already at concurrency=2; scale out with `--scale celery-worker-standard=N` |

---

## Security

- Bearer token + per-key permission flags (`can_generate_layouts`, `can_access_exports`, `is_ops_team`)
- **Embed flow**: short-lived UUID embed tokens exchanged server-side at `/api/embed/proxy` — real API key never touches the browser
- **Dashboard / editor flow**: all calls proxied through `/api/internal/proxy` (gated by NextAuth session cookie + `INTERNAL_API_KEY` server env var) — no API key in client JS bundle
- Ops-path guard in internal proxy: `ops/*` routes re-check `session.is_ops_team` before forwarding, preventing privilege escalation through the shared key
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
- [ ] `proxy/traefik/acme.json` — `chmod 600`
- [ ] API keys have minimum necessary permissions
- [ ] Regular DB backups scheduled

---

## File Storage

```
storage/
├── uploads/    # customer-uploaded source images (30-day expiry)
├── layouts/    # JSON layout templates
├── masks/      # SVG/PNG mask files
└── exports/    # generated render outputs (14-day expiry; 7-day when disk > 80%)
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DJANGO_SECRET_KEY` | Yes | Django secret key |
| `DEBUG` | Yes | `0` for production |
| `PUBLIC_HOST` | Yes | Production domain |
| `LETSENCRYPT_EMAIL` | Yes | Let's Encrypt ACME email |
| `POSTGRES_PASSWORD` | Yes | Database password |
| `REDIS_URL` | Yes | Redis connection string |
| `DIRECT_API_KEY` | Yes | Internal ops team API key (seeded into Django DB on first run) |
| `EXTERNAL_API_KEY` | No | External partner key |
| `TESTING_API_KEY` | No | Testing key |
| `INTERNAL_API_KEY` | Yes | Server-only key for the Next.js internal proxy — same value as `DIRECT_API_KEY`. **Must NOT be prefixed `NEXT_PUBLIC_`** |
| `OMS_PRODUCTION_ESTIMATOR_URL` | Yes | OMS webhook endpoint |
| `CELERY_CONCURRENCY` | No | Worker slots per container (default: 2) |
| `CELERY_QUEUE` | No | Queue name(s) for worker (default: `priority,standard`) |
| `FRONTEND_HOST_PORT` | No | Host port for frontend (default: 5004) |

---

## License

Proprietary — All rights reserved. Printo.in internal use only.
