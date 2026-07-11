#!/usr/bin/env bash
# Web-tier load baseline (Phase 4) — a pre-marketing reference for the read
# path, so future changes can be compared like-for-like on the same machine.
#
# Usage:
#   API_KEY=<key> [BASE=https://localhost] ./scripts/load-baseline.sh
#   API_KEY=<key> BASE=http://localhost:8000 ./scripts/load-baseline.sh   # gunicorn-direct
#
# Endpoints (and why):
#   GET /api/health   — AllowAny, no DB. The pure proxy+gunicorn floor.
#   GET /api/layouts  — Bearer auth + APIKey lookup + cached layout list.
#                       The read path every storefront embed session hits.
# POST /api/editor/render is deliberately EXCLUDED: it is stateful (upserts
# CanvasData, creates a RenderJob, dispatches a Celery render per request), so
# hammering it measures the async tier and floods the queue/disk — not the
# web tier this baseline targets.
#
# Tool: ApacheBench (`ab`), present by default on macOS; no new dependency.
# Numbers are dev-Docker numbers (self-signed TLS, gunicorn defaults) — record
# machine context and only compare deltas on the same host.
set -u

BASE="${BASE:-https://localhost}"
API_KEY="${API_KEY:-}"
OUT="docs/LOAD_BASELINE.md"

if ! command -v ab >/dev/null 2>&1; then
  echo "ApacheBench (ab) is not installed." >&2
  exit 2
fi
if [[ -z "$API_KEY" ]]; then
  echo "API_KEY is required (GET /api/layouts uses Bearer auth)." >&2
  echo "Usage: API_KEY=<key> [BASE=$BASE] $0" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
mkdir -p docs

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DATE="$(date -u +%Y-%m-%d)"
UNAME="$(uname -sm)"

# ab flags: -q quiet, -k keep-alive, -n requests, -c concurrency.
# -H auth for the layouts endpoint. ab does not verify TLS, so the self-signed
# bootstrap cert is fine over https.
run_ab() {   # run_ab <label> <url> <n> <c> [auth_header]
  local label="$1" url="$2" n="$3" c="$4" auth="${5:-}"
  # Build args as an array so an auth header stays ONE properly-quoted arg.
  local args=(-q -k -l)
  [[ -n "$auth" ]] && args+=(-H "$auth")
  # Warm-up (discarded) so caches/connection pools are primed.
  ab "${args[@]}" -n 50 -c 10 "$url" >/dev/null 2>&1
  local out
  # -l tolerates variable response length (a cached JSON list can legitimately
  # differ in length between warm/cold), so ab's "Failed" reflects real
  # transport/HTTP failures, not length variance.
  out="$(ab "${args[@]}" -n "$n" -c "$c" "$url" 2>/dev/null)"
  local rps p95 failed non2xx
  rps="$(echo "$out" | awk -F: '/Requests per second/ {gsub(/ /,"",$2); split($2,a,"["); print a[1]}')"
  p95="$(echo "$out" | awk '/^ *95%/ {print $2}')"
  failed="$(echo "$out" | awk -F: '/Failed requests/ {gsub(/ /,"",$2); print $2}')"
  non2xx="$(echo "$out" | awk -F: '/Non-2xx responses/ {gsub(/ /,"",$2); print $2}')"
  echo "| $label | $c | ${rps:-?} | ${p95:-?} | ${failed:-0} | ${non2xx:-0} |"
}

echo "Running load baseline against $BASE …" >&2

{
  echo ""
  echo "## $DATE — \`$SHA\` ($UNAME, dev Docker stack)"
  echo ""
  echo "_Web-tier baseline (ApacheBench, keep-alive). \`/api/health\` is unthrottled —"
  echo "it's the raw proxy+gunicorn ceiling. Authenticated read endpoints are"
  echo "rate-limited to 200 req/60s per IP by design (P4.1), so a flood of"
  echo "\`/api/layouts\` mostly returns 429 (visible as Non-2xx) — that is the limiter"
  echo "working, not a throughput number; the small in-window sample records its"
  echo "warm latency. Dev-Docker numbers — compare deltas on the same machine only._"
  echo ""
  echo "| Endpoint | Concurrency | Requests/sec | p95 (ms) | Failed | Non-2xx |"
  echo "|---|---|---|---|---|---|"
  run_ab "GET /api/health (unthrottled)" "$BASE/api/health"  2000 10
  run_ab "GET /api/health (unthrottled)" "$BASE/api/health"  5000 50
  # Small in-window sample (≤ the 200/60s limit) for authenticated read latency.
  run_ab "GET /api/layouts (warm, in-limit)" "$BASE/api/layouts" 150 10 "Authorization: Bearer $API_KEY"
} | tee -a "$OUT"

echo "" >&2
echo "Appended to $OUT" >&2
