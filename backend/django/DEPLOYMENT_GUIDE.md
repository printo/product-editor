# Deployment Guide — Product Editor

Step-by-step instructions for deploying and operating the Product Editor in production.

---

## Prerequisites

- Docker and Docker Compose v2 installed on the server
- Access to the production server
- Database backup capability
- `.env` file configured (see below)

---

## Environment Variables

Required in `.env` at the project root:

```bash
# Django
DJANGO_SECRET_KEY=<50-char random string>
DEBUG=0
PUBLIC_HOST=product-editor.printo.in
LETSENCRYPT_EMAIL=devops@printo.in
ALLOWED_HOSTS=product-editor.printo.in

# Database
POSTGRES_DB=product_editor
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<strong password>
POSTGRES_HOST=db
POSTGRES_PORT=5432

# Redis
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=redis://redis:6379/0

# OMS Integration
OMS_PRODUCTION_ESTIMATOR_URL=http://oms-service:8080/api/production/estimate

# API Keys
DIRECT_API_KEY=<ops team key>
EXTERNAL_API_KEY=<embed partner key>

# Storage
STORAGE_ROOT=/app/storage
EXPORTS_DIR=/app/storage/exports

# Worker tuning (optional)
CELERY_CONCURRENCY=2
FRONTEND_HOST_PORT=5004
```

Generate a secret key:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

---

## Services Overview

| Service | Role | Runs migrations? |
|---|---|---|
| `backend` | Django/Gunicorn web server | **Yes — only this service** |
| `frontend` | Next.js customer-facing editor | No |
| `celery-worker-priority` | Render worker — `priority` queue only | No |
| `celery-worker-standard` | Render worker — `standard` queue only | No |
| `celery-beat` | Periodic scheduler (daily GC at 02:00 UTC) | No |
| `redis` | Broker, result backend, status cache | No |
| `db` | PostgreSQL 16 | No |
| `proxy` | Traefik v3 + Let's Encrypt TLS | No |

**Important**: Only the `backend` container runs `python manage.py migrate`. The worker and beat containers exit before the migration block in `entrypoint.sh`.

---

## Deployment Steps

### 1. Backup Current State

```bash
docker-compose exec db pg_dump -U postgres product_editor > backup_$(date +%Y%m%d_%H%M%S).sql
tar -czf storage_backup_$(date +%Y%m%d_%H%M%S).tar.gz storage/
```

### 2. Pull Latest Code

```bash
git fetch origin && git checkout main && git pull origin main
git log -1
```

### 3. Build Updated Images

```bash
docker-compose build backend celery-worker-priority celery-worker-standard celery-beat
```

### 4. Stop Application Services

```bash
docker-compose stop backend celery-worker-priority celery-worker-standard celery-beat
```

### 5. Run Database Migrations

Only run migrations via the `backend` service:

```bash
docker-compose up -d db redis
docker-compose run --rm backend python manage.py migrate
docker-compose run --rm backend python manage.py showmigrations
```

Expected output — all migrations checked:
```
api
 [X] 0001_initial
 [X] 0002_apikey_is_ops_team
 [X] 0003_embedsession
 [X] 0004_rename_embed_sessions_token_idx_embed_sessi_token_0e7d0a_idx_and_more
 [X] 0005_canvasdata_renderjob_and_more
 [X] 0006_allow_null_celery_task_id
 [X] 0007_canvasdata_callback_url
```

### 6. Start All Services

```bash
docker-compose up -d
sleep 10
docker-compose ps
```

Expected running services:
```
product-editor-backend-1                  Up (healthy)
product-editor-celery-worker-priority-1   Up
product-editor-celery-worker-standard-1   Up
product-editor-celery-beat-1              Up
product-editor-db-1                       Up (healthy)
product-editor-redis-1                    Up (healthy)
product-editor-frontend-1                 Up
product-editor-proxy-1                    Up
```

### 7. Verify Service Health

```bash
docker-compose logs backend --tail=50
docker-compose logs celery-worker-priority --tail=50
docker-compose logs celery-worker-standard --tail=50
docker-compose logs celery-beat --tail=20
```

Look for: worker startup messages, no import errors, database connection success.

### 8. Smoke Test

```bash
# Health check (public)
curl https://product-editor.printo.in/api/health

# Submit async render job
curl -X POST https://product-editor.printo.in/api/layout/generate \
  -H "Authorization: Bearer $DIRECT_API_KEY" \
  -F "layout=CIRCLE_48MM" \
  -F "fit_mode=cover" \
  -F "order_id=smoke_$(date +%s)" \
  -F "callback_url=https://example.com/webhook" \
  -F "images=@test_image.jpg"
# Expected: 202 response with job_id

# Poll status
curl https://product-editor.printo.in/api/render-status/{job_id}/ \
  -H "Authorization: Bearer $DIRECT_API_KEY"

# Monitor queue (ops key required)
curl https://product-editor.printo.in/api/celery/monitor/ \
  -H "Authorization: Bearer $DIRECT_API_KEY"
```

---

## Scaling Workers

### Scale standard workers for peak load

```bash
# Add more standard workers during festival seasons
docker-compose up -d --scale celery-worker-standard=4

# Verify
docker-compose ps | grep celery-worker
```

Priority workers intentionally remain at 1 replica — they handle a small volume of express/soft-proof orders.

### Worker resource configuration

Each worker container:
- Memory limit: 512 MB
- Concurrency: 2 task slots per container (~256 MB per slot)
- Controlled via `CELERY_CONCURRENCY` env var (default: `2`)

Do not increase concurrency above 2 without raising the memory limit proportionally. Pillow high-res renders can use 200–250 MB per task.

---

## Post-Deployment Monitoring

### First hour — check every 5 minutes

```bash
# Service status
docker-compose ps

# Worker errors
docker-compose logs celery-worker-standard --tail=100 | grep -i error
docker-compose logs celery-worker-priority --tail=100 | grep -i error

# Queue depths and job counts
curl -s https://product-editor.printo.in/api/celery/monitor/ \
  -H "Authorization: Bearer $DIRECT_API_KEY" | python3 -m json.tool
```

### Ongoing alerts

| Metric | Alert threshold |
|---|---|
| Priority queue depth | > 50 jobs |
| Standard queue depth | > 200 jobs |
| Worker memory | > 400 MB (80% of 512 MB limit) |
| Render job failure rate | > 1% in 24 h |
| Enqueue response time | > 200 ms |
| Status query response time | > 50 ms |

---

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Jobs stuck in `queued` | `docker-compose ps celery-worker-*` | Restart workers; verify Redis is reachable |
| Worker exits immediately | `docker-compose logs celery-worker-*` | Check Redis connection; verify migrations ran on backend |
| `priority` jobs not moving | `celery-worker-priority` running? | It only listens to `priority` queue — check `CELERY_QUEUE=priority` env var |
| OMS push failing repeatedly | `CanvasData.requires_manual_review` in Admin | Check OMS endpoint; order flagged after 5 failures |
| High worker memory | `docker stats` | Workers are at concurrency=2; scale out with `--scale celery-worker-standard=N` |
| `ClientFetchError` on frontend | `.env.local` in `frontend/nextjs/` | Set `INTERNAL_API_URL=http://backend:8000/api` (not `localhost`) |
| Frontend not loading | Port | Use `localhost:5004`, not `:3000` |
| Migrations on worker startup | `entrypoint.sh` branch | Worker/beat branches must exit before the migration block |

---

## Rollback Procedure

```bash
# Stop services
docker-compose stop backend celery-worker-priority celery-worker-standard celery-beat

# Restore database
cat backup_{timestamp}.sql | docker-compose exec -T db psql -U postgres product_editor

# Checkout previous commit
git checkout {previous_commit_hash}
docker-compose build backend

# Start services
docker-compose up -d

# Verify
docker-compose ps
curl https://product-editor.printo.in/api/health
```

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

---

## SSL Preparation (first deploy only)

```bash
touch proxy/traefik/acme.json && chmod 600 proxy/traefik/acme.json
```

---

## Production Checklist

- [ ] `DEBUG=0`
- [ ] `DJANGO_SECRET_KEY` — strong random value
- [ ] `ALLOWED_HOSTS` set to production domain
- [ ] `POSTGRES_PASSWORD` — strong random value
- [ ] Firewall: open only 80, 443, 22
- [ ] `proxy/traefik/acme.json` — `chmod 600`
- [ ] API keys have minimum necessary permissions
- [ ] Regular DB backups scheduled
- [ ] Migration 0007 applied (`CanvasData.callback_url`)
