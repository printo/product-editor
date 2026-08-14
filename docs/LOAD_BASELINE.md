# Load Baselines

Append-only log of web-tier load measurements. Each entry is a dated snapshot
against a specific commit — **never edit an old row to "correct" it**, add a new
run. Numbers are only comparable to other runs on the same machine.

Re-measure with `scripts/load-baseline.sh`. The `RateLimitMiddleware` ceiling
quoted below (200 req / 60 s per IP) is still current as of `main` @ `79104d0` —
`RATE_LIMIT = 200` in `backend/django/api/middleware.py`. It is set that high
because a 200-photo calendar legitimately fires ~600 API calls in under a minute.

---

## 2026-07-11 — `c2babbe` (Darwin arm64, dev Docker stack)

_Web-tier baseline (ApacheBench, keep-alive). `/api/health` is unthrottled —
it's the raw proxy+gunicorn ceiling. Authenticated read endpoints are
rate-limited to 200 req/60s per IP by design (P4.1), so a flood of
`/api/layouts` mostly returns 429 (visible as Non-2xx) — that is the limiter
working, not a throughput number; the small in-window sample records its
warm latency. Dev-Docker numbers — compare deltas on the same machine only._

| Endpoint | Concurrency | Requests/sec | p95 (ms) | Failed | Non-2xx |
|---|---|---|---|---|---|
| GET /api/health (unthrottled) | 10 | 2006.31 | 10 | 0 | 0 |
| GET /api/health (unthrottled) | 50 | 3859.01 | 35 | 0 | 0 |
| GET /api/layouts (warm, in-limit) | 10 | 753.32 | 21 | 0 | 0 |
