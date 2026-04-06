# Production Readiness — Async Queue

**Date**: April 5, 2026
**Feature**: Async Image Generation (Celery + Redis)
**Status**: ✅ Production-Ready

---

## Summary

The async render queue is fully implemented and all known issues have been resolved. The system decouples image generation entirely from the HTTP request cycle. Post-checkout, the API responds immediately with a job ID; rendering happens in a dedicated worker pool in the background.

---

## Implementation Checklist

| Component | Status | Notes |
|---|---|---|
| Celery + Redis async queue | ✅ Done | `render_canvas_task` with exponential backoff |
| Priority / standard worker isolation | ✅ Done | Two dedicated services; priority never starves |
| Worker concurrency | ✅ Done | 2 slots per container, 512 MB limit |
| Retry logic (`self.retry()` only) | ✅ Done | `autoretry_for` removed; retry counter stays in sync |
| `SoftTimeLimitExceeded` handling | ✅ Done | Skips retries, fails immediately |
| `MemoryError` handling | ✅ Done | Skips retries, fails immediately |
| OMS push as separate task | ✅ Done | `push_to_production_estimator_task` never blocks render slot |
| `callback_url` webhook | ✅ Done | Stored on `CanvasData`, fired on OMS push success |
| `order_id` upsert (resubmit safety) | ✅ Done | `update_or_create` — no unique-constraint crash on retry |
| `celery_task_id` nullable | ✅ Done | Set to `None` at creation; populated after dispatch |
| Redis failure → job `failed` | ✅ Done | `on_commit` handler catches dispatch exception |
| `celery-beat` migration race | ✅ Done | Beat exits before migration block in `entrypoint.sh` |
| Hardcoded Redis URL removed | ✅ Done | `celery.py` reads from `CELERY_*` Django settings only |
| GC skips manual-review orders | ✅ Done | `requires_manual_review` path filter applied |
| Status polling with Redis cache | ✅ Done | 3s/10s/300s TTLs; estimated wait time corrected for concurrency |
| Migration 0007 (`callback_url`) | ✅ Done | Applied |

---

## Service Configuration

**Worker services** (two dedicated services, both `restart: unless-stopped`):

| Service | Queue | Concurrency | Memory limit |
|---|---|---|---|
| `celery-worker-priority` | `priority` | 2 | 512 MB |
| `celery-worker-standard` | `standard` | 2 | 512 MB |

**Capacity**: 4 concurrent render slots at baseline (2 workers × 2 slots each). Scale standard workers horizontally for peak load: `docker-compose up -d --scale celery-worker-standard=N`.

---

## API Behaviour

- `POST /api/layout/generate` with `order_id` → `202 Accepted` with `job_id`, `status_url`, `queue`, `estimated_wait_seconds`
- `GET /api/render-status/{job_id}/` → job status, Redis-cached (3s queued / 10s processing / 300s terminal)
- `GET /api/celery/monitor/` → queue depths, worker count, job stats (ops team only)

Priority routing: requests with `soft_proof=true` go to the `priority` queue; all others go to `standard`.

---

## Known Limitations

None blocking production deployment.

**Remaining PRD gaps** (not blocking, tracked in PRD.md):
- **B1 — Canvas state persistence**: editor state is lost on page refresh. Blocked designs do not survive the checkout flow. P0 — tracked as Action Item #4 (due Apr 18).
- **B3 — SKU-to-layout mapping**: currently manual configuration. P1 — tracked as Action Item #2.

---

## Monitoring

```bash
# Queue health (ops key required)
curl https://product-editor.printo.in/api/celery/monitor/ \
  -H "Authorization: Bearer $OPS_API_KEY"

# Live worker logs
docker-compose logs -f celery-worker-priority
docker-compose logs -f celery-worker-standard

# Worker memory
docker stats product-editor-celery-worker-standard-1
docker stats product-editor-celery-worker-priority-1
```

Key log patterns to watch:
- `INFO: Async job enqueued: order_id=..., job_id=..., queue=...` — healthy dispatch
- `INFO: Render job ... completed` — healthy render
- `ERROR: Render job ... failed after 3 retries` — investigate `RenderJob.error_message`
- `ERROR: Failed to push order ... to Production_Estimator` — OMS connectivity issue

---

## Rollback

If a critical regression is found:

```bash
git checkout {previous_commit}
docker-compose build backend
docker-compose up -d
```

If migration 0007 needs to be reversed:
```bash
docker-compose exec backend python manage.py migrate api 0006
```
