#!/bin/bash
# ═══════════════════════════════════════════
#  Product Editor — Full-Stack Benchmark
# ═══════════════════════════════════════════

set -e

# .env is a Docker env-file, not a shell script. `source`-ing it dies on any
# value bash can't parse (CORS_ALLOWED_ORIGINS did: exit 2 before a line of
# output), so read just the keys this script needs.
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }

API_KEY="${DIRECT_API_KEY:-$(env_value DIRECT_API_KEY)}"
BACKEND_PORT="${BACKEND_HOST_PORT:-$(env_value BACKEND_HOST_PORT)}"
FRONTEND_PORT="${FRONTEND_HOST_PORT:-$(env_value FRONTEND_HOST_PORT)}"
HOST="http://localhost:${BACKEND_PORT:-8000}"
FRONTEND="http://localhost:${FRONTEND_PORT:-5004}"
RUNS=5

# A layout that exists on the target. Hardcoding one (classic_5x7 was) goes
# stale as the catalogue changes. BENCH_LAYOUT=<name> overrides.
first_layout() {
  curl -s "$HOST/api/layouts?fields=summary" -H "Authorization: Bearer $API_KEY" 2>/dev/null | python3 -c '
import json, sys
try:
    items = [d for d in (json.load(sys.stdin).get("layouts") or []) if isinstance(d, dict) and d.get("name")]
except Exception:
    items = []
plain = [d for d in items if d.get("productType") not in ("calendar", "book") and d.get("surfaceCount") == 1]
print(((plain or items) or [{}])[0].get("name", ""))
' 2>/dev/null || true
}
BENCH_LAYOUT="${BENCH_LAYOUT:-$(first_layout)}"

red='\033[0;31m'; green='\033[0;32m'; yellow='\033[1;33m'; cyan='\033[0;36m'; nc='\033[0m'

bench() {
  local label="$1"; local url="$2"; shift 2   # anything left is passed to curl
  local total=0; local max=0; local min=999
  local sizes=0; local status=""

  for i in $(seq 1 $RUNS); do
    result=$(curl -s -w '%{time_total} %{time_starttransfer} %{size_download} %{http_code}' \
      -o /dev/null "$@" "$url" 2>/dev/null)
    t=$(echo "$result" | awk '{print $1}')
    ttfb=$(echo "$result" | awk '{print $2}')
    sz=$(echo "$result" | awk '{print $3}')
    sc=$(echo "$result" | awk '{print $4}')
    total=$(echo "$total + $t" | bc)
    sizes=$sz
    status=$sc
    if (( $(echo "$t > $max" | bc -l) )); then max=$t; fi
    if (( $(echo "$t < $min" | bc -l) )); then min=$t; fi
  done
  avg=$(echo "scale=3; $total / $RUNS" | bc)

  # Color based on avg time
  if (( $(echo "$avg < 0.100" | bc -l) )); then color=$green
  elif (( $(echo "$avg < 0.500" | bc -l) )); then color=$yellow
  else color=$red; fi

  printf "  %-45s ${color}avg=%ss${nc}  min=%ss  max=%ss  status=%s  size=%sb\n" \
    "$label" "$avg" "$min" "$max" "$status" "$sizes"
}

echo ""
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo -e "${cyan}  Backend API Benchmark ($RUNS runs each)${nc}"
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo ""

bench "GET /api/health (no auth)"          "$HOST/api/health"
bench "GET /api/layouts (list all)"         "$HOST/api/layouts"         -H "Authorization: Bearer $API_KEY"
if [ -n "$BENCH_LAYOUT" ]; then
  bench "GET /api/layouts/$BENCH_LAYOUT"    "$HOST/api/layouts/$BENCH_LAYOUT" -H "Authorization: Bearer $API_KEY"
else
  echo "  (skipped GET /api/layouts/<name>: $HOST/api/layouts returned no layouts; set BENCH_LAYOUT=<name>)"
fi
bench "GET /api/fonts"                      "$HOST/api/fonts"           -H "Authorization: Bearer $API_KEY"
bench "GET /api/canvas-state/PE-BENCH/"     "$HOST/api/canvas-state/PE-BENCH/" -H "Authorization: Bearer $API_KEY"

echo ""
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo -e "${cyan}  Frontend Benchmark ($RUNS runs each)${nc}"
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo ""

bench "GET / (Next.js homepage)"                    "$FRONTEND/"
bench "GET /dashboard (SSR page)"                   "$FRONTEND/dashboard"
bench "GET /api/auth/session (NextAuth)"            "$FRONTEND/api/auth/session"

echo ""
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo -e "${cyan}  Database Query Profiling${nc}"
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo ""

docker exec product-editor-backend-1 python manage.py shell -c "
import time, json

# 1. Count queries for layouts endpoint
from django.test.utils import CaptureQueriesContext
from django.db import connection

# APIKey lookup
start = time.time()
from api.models import APIKey
for _ in range(100):
    APIKey.objects.filter(key='$API_KEY', is_active=True).first()
elapsed = (time.time() - start) * 10  # ms per query
print(f'  APIKey lookup (100x avg):              {elapsed:.1f}ms')

# CanvasData lookup
start = time.time()
from api.models import CanvasData
for _ in range(100):
    CanvasData.objects.filter(order_id='PE-BENCH').first()
elapsed = (time.time() - start) * 10
print(f'  CanvasData lookup (100x avg):          {elapsed:.1f}ms')

# RenderJob aggregation (N+1 pattern)
from api.models import RenderJob
from django.utils import timezone
from datetime import timedelta
start = time.time()
for _ in range(10):
    q = RenderJob.objects.filter(status='queued').count()
    p = RenderJob.objects.filter(status='processing').count()
    c = RenderJob.objects.filter(status='completed', created_at__gte=timezone.now()-timedelta(hours=24)).count()
    f = RenderJob.objects.filter(status='failed', created_at__gte=timezone.now()-timedelta(hours=24)).count()
elapsed = (time.time() - start) * 100
print(f'  RenderJob 4x COUNT (10x avg):          {elapsed:.1f}ms  (N+1 pattern)')

# Single aggregation alternative
from django.db.models import Count, Q
start = time.time()
for _ in range(10):
    agg = RenderJob.objects.aggregate(
        queued=Count('id', filter=Q(status='queued')),
        processing=Count('id', filter=Q(status='processing')),
        completed_24h=Count('id', filter=Q(status='completed', created_at__gte=timezone.now()-timedelta(hours=24))),
        failed_24h=Count('id', filter=Q(status='failed', created_at__gte=timezone.now()-timedelta(hours=24))),
    )
elapsed = (time.time() - start) * 100
print(f'  RenderJob single aggregate (10x avg):  {elapsed:.1f}ms  (optimized)')

# Table sizes
from django.db import connection
from api.models import APIRequest, EmbedSession
with connection.cursor() as cursor:
    for table in [m._meta.db_table for m in (APIRequest, RenderJob, CanvasData, APIKey, EmbedSession)]:
        try:
            cursor.execute(f'SELECT count(*) FROM {table}')
            count = cursor.fetchone()[0]
            cursor.execute(f\"SELECT pg_size_pretty(pg_total_relation_size('{table}'))\")
            size = cursor.fetchone()[0]
            print(f'  Table {table:30s} rows={count:>8}  size={size}')
        except Exception as e:
            print(f'  Table {table:30s} error: {e}')
" 2>/dev/null

echo ""
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo -e "${cyan}  Container Resource Usage${nc}"
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo ""
docker stats --no-stream --format "  {{.Name}}:{{.CPUPerc}}:{{.MemUsage}}:{{.MemPerc}}:{{.NetIO}}" | \
  column -t -s ':'

echo ""
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo -e "${cyan}  Backend Middleware Timing (from logs)${nc}"
echo -e "${cyan}═══════════════════════════════════════════${nc}"
echo ""
docker logs product-editor-backend-1 2>&1 | grep "API Response" | tail -20 | \
  awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+\.[0-9]+s$/) print $0}' | \
  sort -t' ' -k$(docker logs product-editor-backend-1 2>&1 | grep "API Response" | head -1 | tr ' ' '\n' | grep -n "[0-9]s" | head -1 | cut -d: -f1) -rn 2>/dev/null | head -10

# Simpler fallback
echo ""
echo "  Last 20 API response times:"
docker logs product-editor-backend-1 2>&1 | grep "API Response" | tail -20 | \
  sed 's/.*API Response: /  /'

echo ""
echo -e "${green}═══════════════════════════════════════════${nc}"
echo -e "${green}  Benchmark complete${nc}"
echo -e "${green}═══════════════════════════════════════════${nc}"
