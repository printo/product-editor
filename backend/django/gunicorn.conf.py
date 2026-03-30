"""
Gunicorn configuration for Product Editor backend.

Worker math:
  CPU-bound (image generation):  workers = cpu_count (no hyperthreading benefit)
  I/O-bound (DB, file reads):    workers = cpu_count * 2 + 1
  We use gthread so each worker handles multiple requests via OS threads.
  Formula: workers = cpu_count * 2 + 1, threads = 4  →  max concurrency = workers * threads
"""

import multiprocessing
import os

# ── Binding ──────────────────────────────────────────────────────────────────
bind = f"0.0.0.0:{os.getenv('PORT', '8000')}"

# ── Workers ──────────────────────────────────────────────────────────────────
# gthread: sync worker with OS thread pool — best for mixed CPU/IO workloads
# and avoids event-loop complexity while still handling concurrent requests.
worker_class = "gthread"
workers = int(os.getenv("GUNICORN_WORKERS", min(multiprocessing.cpu_count() * 2 + 1, 8)))
threads = int(os.getenv("GUNICORN_THREADS", 4))

# ── Timeouts ─────────────────────────────────────────────────────────────────
# Image generation can take 10–30s for large/multi-surface layouts.
timeout = int(os.getenv("GUNICORN_TIMEOUT", 300))   # 5 minutes hard kill
graceful_timeout = 60                                 # allow in-flight to finish on reload
keepalive = 5                                         # seconds for keep-alive connections

# ── Worker recycling (prevent memory leaks from PIL) ─────────────────────────
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", 500))
max_requests_jitter = 50   # randomised so workers don't all recycle at once

# ── Logging ──────────────────────────────────────────────────────────────────
accesslog = "-"    # stdout (captured by Docker / container log driver)
errorlog  = "-"    # stderr
loglevel  = os.getenv("GUNICORN_LOG_LEVEL", "info")
access_log_format = (
    '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s %(D)sµs'
)

# ── Process ──────────────────────────────────────────────────────────────────
proc_name = "product_editor"

# ── Request limits ───────────────────────────────────────────────────────────
limit_request_line   = 8190
limit_request_fields = 100
