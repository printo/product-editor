# Performance Tuning Guide — Async Queue

Overview of tuning levers for the Celery render queue.

---

## Baseline Configuration

### Workers (two dedicated services)

```yaml
# docker-compose.yml
celery-worker-priority:
  environment:
    - CELERY_QUEUE=priority
    - CELERY_CONCURRENCY=2
  deploy:
    resources:
      limits:
        memory: 512M

celery-worker-standard:
  environment:
    - CELERY_QUEUE=standard
    - CELERY_CONCURRENCY=2
  deploy:
    resources:
      limits:
        memory: 512M
```

**Current settings:**
- Concurrency: **2 slots per container** (~256 MB per task slot)
- Queue isolation: `priority` and `standard` workers never share tasks
- Memory limit: 512 MB per container

> **Do not raise concurrency above 2 without raising the memory limit.** Pillow high-res renders (300 DPI, large images) can use 200–250 MB per task. At concurrency=3 with 512 MB you risk OOM kills.

### Database Connection Pool

```python
# settings.py
DATABASES['default']['CONN_MAX_AGE'] = 60  # 60-second persistent connections
```

Expected connection usage at baseline: 2 priority slots + 2 standard slots + 4 Gunicorn threads + beat = ~12 connections. Well within Postgres default of 100.

### Redis Cache TTLs

```python
RENDER_JOB_STATUS_CACHE_TTL = {
    'queued': 3,        # 3 seconds
    'processing': 10,   # 10 seconds
    'completed': 300,   # 5 minutes
    'failed': 300,      # 5 minutes
}
```

---

## Scaling Strategy

### Horizontal scaling (recommended for peak load)

Add more **standard** worker containers. Priority workers intentionally stay at 1 replica.

```bash
# Festival season / peak load
docker-compose up -d --scale celery-worker-standard=4

# Verify workers registered with broker
docker-compose exec celery-worker-standard celery -A product_editor inspect ping
```

Each additional standard container adds 2 render slots and requires 512 MB RAM on the host.

### Vertical scaling (increase slots per container)

Only do this if the host has abundant RAM (>= 1 GB free per worker container):

```yaml
celery-worker-standard:
  environment:
    - CELERY_CONCURRENCY=4
  deploy:
    resources:
      limits:
        memory: 1024M  # Must increase proportionally
```

### Decision matrix

| Queue depth | Worker CPU | Worker memory | Action |
|---|---|---|---|
| < 50 | < 60% | < 300 MB | No change |
| 50–100 | < 70% | < 350 MB | Add 1 standard worker container |
| > 100 | < 70% | < 350 MB | Add 2–3 standard worker containers |
| Any | > 80% | Any | Reduce concurrency or add CPU |
| Any | Any | > 450 MB | Reduce concurrency or add memory |

---

## Queue Priority Tuning

The `priority` queue is exclusively for:
- Soft-proof CMYK requests (`soft_proof=true`)
- Express delivery / store pickup orders

These must never compete with standard queue backlog for worker slots. The architecture guarantees this via dedicated services — do not merge the queues.

If priority queue depth exceeds 50 regularly, add a second priority worker:
```bash
docker-compose up -d --scale celery-worker-priority=2
```

---

## Database Connection Tuning

At larger scale (10+ worker containers), connection pressure increases:

```
max_connections needed = (workers × concurrency × 2) + (gunicorn threads × 2) + buffer
Example at 4 standard containers × 2 slots = 8 workers:
= (8 × 2) + (4 × 2) + 20 = 44 connections — well within 100
```

If you hit `remaining connection slots are reserved` errors, add PgBouncer before increasing `max_connections`.

---

## File I/O

Exports are written atomically (`.tmp` → `os.replace()`). On network volumes, atomic writes can be slow. If disk I/O is the bottleneck:

1. Mount a local SSD instead of a network volume for `EXPORTS_DIR`.
2. Verify writes are hitting local storage: `docker stats` → check I/O counters.

---

## Redis Memory

At high throughput, result backend entries accumulate. Set a TTL:

```python
# settings.py
CELERY_RESULT_EXPIRES = 3600  # 1 hour
```

Monitor Redis memory:
```bash
docker-compose exec redis redis-cli INFO memory
```

---

## Monitoring

```bash
# Queue depths and worker stats
curl -s https://product-editor.printo.in/api/celery/monitor/ \
  -H "Authorization: Bearer $OPS_API_KEY" | python3 -m json.tool

# Worker memory per container
docker stats product-editor-celery-worker-standard-1
docker stats product-editor-celery-worker-priority-1

# Active tasks on workers
docker-compose exec celery-worker-standard celery -A product_editor inspect active
```

### Success targets

| Metric | Target |
|---|---|
| Async enqueue response time | < 200 ms (P95) |
| Status query response time | < 50 ms (P95) |
| Priority queue completion | < 30 s (P95) |
| Standard queue completion | < 5 min (normal load) |
| Render job success rate | > 99.5% |
| Concurrent orders (baseline) | 200+ |

---

## Load Testing

Use Locust or k6. Key scenario: submit async render jobs with `order_id` and poll status.

Success criteria:
- P95 enqueue < 200 ms
- P95 status query < 50 ms
- Error rate < 1%
- Queue depth stabilises (does not grow unbounded)
- No OOM kills or worker crashes

Always load test with realistic image sizes — small test images are not representative of real Pillow memory usage.

---

## Common Bottlenecks

| Symptom | Cause | Fix |
|---|---|---|
| Queue depth growing unbounded | Too few workers | Scale standard workers horizontally |
| OOM kills | Concurrency too high for memory limit | Keep concurrency=2 per 512 MB; scale out instead of up |
| Database connection exhaustion | Too many workers without connection pooler | Add PgBouncer, or keep worker count low |
| Slow atomic writes | Network volume for exports | Mount local SSD for `EXPORTS_DIR` |
| Priority jobs backed up | Only 1 priority worker, high soft-proof volume | Add second priority worker replica |
