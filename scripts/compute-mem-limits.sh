#!/usr/bin/env bash
# Derives BACKEND_MEM_LIMIT / CELERY_MEM_LIMIT from the host's total memory,
# so the two heaviest containers' memory caps scale with whatever box they're
# running on instead of staying pinned at whatever was hardcoded into
# docker-compose.yml when it was last edited. Mirrors how CELERY_CONCURRENCY
# is deliberately left unset so Celery re-detects CPU count at every worker
# boot rather than reusing a number written down for an old spec.
#
# Nothing here is persisted — it's recomputed fresh on every run. deploy.sh
# evals this before any `docker-compose up`; for a manual local
# `docker-compose up`, eval it yourself first:
#   eval "$(./scripts/compute-mem-limits.sh)"
# Skip it entirely and docker-compose.yml's `${VAR:-2G}` fallback keeps
# today's fixed 2G behavior.
#
# Formula: reserve a fixed pool for the OS + nginx + db + redis + redis-cache
# (none of which scale with the app-memory pressure backend/celery-worker
# see), then split 85% of whatever's left evenly between backend and
# celery-worker-standard — the only two services whose `deploy.resources
# .limits.memory` is actually enforced by plain `docker compose up` (Compose
# only reads `reservations` under Swarm). The remaining 15% is deliberately
# left unclaimed by any container's ceiling: two cgroup limits that summed to
# 100% of host RAM would mean a simultaneous burst in both (plus whatever
# db/redis/nginx are using, which are NOT capped) has no slack before the
# kernel OOM-killer starts picking a container — possibly the wrong one, mid
# render job. Floors at 2048M each: today's hardcoded value, so a host at or
# below the current prod spec behaves exactly as it always has. No ceiling —
# a bigger box should let both scale up, not just sit on unused headroom.
set -eu

RESERVED_MB=1536
USABLE_PCT=85
FLOOR_MB=2048

total_mem_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/MemTotal:/ { print int($2 / 1024); found=1 } END { if (!found) exit 1 }' /proc/meminfo
  elif command -v sysctl >/dev/null 2>&1; then
    local bytes
    bytes=$(sysctl -n hw.memsize 2>/dev/null) || return 1
    [ -n "$bytes" ] || return 1
    echo $(( bytes / 1024 / 1024 ))
  else
    return 1
  fi
}

if total_mb=$(total_mem_mb) && [ "$total_mb" -gt 0 ]; then
  remaining=$(( total_mb - RESERVED_MB ))
  usable=$(( remaining * USABLE_PCT / 100 ))
  per_service=$(( usable / 2 ))
  if [ "$per_service" -lt "$FLOOR_MB" ]; then
    per_service=$FLOOR_MB
  fi
else
  # Detection failed (unreadable /proc/meminfo, no sysctl, sandboxed CI) —
  # fall back to the value that was hardcoded here before, not a guess.
  per_service=$FLOOR_MB
fi

echo "export BACKEND_MEM_LIMIT=${per_service}M"
echo "export CELERY_MEM_LIMIT=${per_service}M"
