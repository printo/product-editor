
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
