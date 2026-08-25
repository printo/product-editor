#!/usr/bin/env bash
set -e
# pipefail: without it a pipeline reports the exit status of its LAST command
# only, so `git pull | tee | while read` looked successful even when the pull
# failed — the script then rebuilt stale code and reported success. Every
# pipeline whose failure is genuinely expected is explicitly guarded with
# `|| true` or a trailing `|| { ... }` below.
# NOTE: `-u` is deliberately NOT set — the script tests optional .env vars
# (PUBLIC_HOST, DIRECT_API_KEY) with [ -n "$VAR" ], which -u would abort on.
set -o pipefail

# ============================================
# Product Editor - Deployment Script
# ============================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Usage information
usage() {
  echo -e "${BLUE}Usage:${NC}"
  echo "  $0 [frontend|backend|workers|both]"
  echo "  $0 rollback [backend|frontend|both]"
  echo ""
  echo -e "${BLUE}Examples:${NC}"
  echo "  $0              # Deploy both frontend and backend (default)"
  echo "  $0 frontend     # Deploy only frontend"
  echo "  $0 backend      # Deploy backend AND celery workers + beat"
  echo "                    (they share the same Dockerfile/source)"
  echo "  $0 workers      # Deploy ONLY celery workers + beat — useful when"
  echo "                    recovering from a worker memory leak / hang"
  echo "  $0 rollback     # Restore the most recent backup image and restart."
  echo "                    No git pull, no build, no migrations."
  echo "                    Add backend|frontend to roll back one half."
  echo ""
  echo -e "${BLUE}Environment overrides:${NC}"
  echo "  ALLOW_STALE_DEPLOY=1   deploy the current checkout even if git pull fails"
  echo "  COMPOSE_PROFILES=      skip the monitoring stack (loki/grafana/promtail/alloy)"
  echo "  SKIP_SMOKE_TESTS=1     skip the post-deploy smoke tests"
  echo "  SMOKE_TESTS=\"embed calendar book\"  which smoke tests to run (default: embed)"
  echo "  ROLLBACK_YES=1         skip the rollback confirmation prompt"
  exit 1
}

# Print colored message
print_status() {
  echo -e "${GREEN}✓${NC} $1"
}

print_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

print_action() {
  echo -e "${CYAN}→${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
  echo -e "${RED}✗${NC} $1"
}

print_header() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════${NC}"
  echo ""
}

# ── Deployment health gate ──────────────────────────────────────────────────
# Health checks used to print a red ✗ and carry on, so the script ended with
# "Deployment finished successfully" and exit 0 even when the backend was
# returning 500s. A broken deploy was indistinguishable from a good one, both
# on screen and to anything scripting around it.
#
# `fail` records a check that must hold for the deploy to be considered good;
# the run continues (so you see EVERY failure, not just the first) but the
# script exits non-zero at the end with the list. Use print_warning for things
# that are merely worth knowing — a missing API key, an unset optional var.
DEPLOY_FAILURES=0
DEPLOY_FAILURE_LIST=()

fail() {
  DEPLOY_FAILURES=$((DEPLOY_FAILURES + 1))
  DEPLOY_FAILURE_LIST+=("$1")
  echo -e "${RED}✗${NC} $1"
}

# Validate mode
MODE="${1:-both}"
if [[ "$MODE" != "frontend" && "$MODE" != "backend" && "$MODE" != "workers" \
   && "$MODE" != "both" && "$MODE" != "rollback" ]]; then
  print_error "Invalid mode: $MODE"
  usage
fi

# Which half to roll back. Only read in rollback mode.
ROLLBACK_TARGET="${2:-both}"
if [[ "$MODE" == "rollback" ]] \
   && [[ "$ROLLBACK_TARGET" != "backend" && "$ROLLBACK_TARGET" != "frontend" && "$ROLLBACK_TARGET" != "both" ]]; then
  print_error "Invalid rollback target: $ROLLBACK_TARGET (expected backend, frontend, or both)"
  usage
fi

# ── Single-deploy lock ──────────────────────────────────────────────────────
# Two deploys in the same checkout will interleave: one rebuilds an image while
# the other is recreating containers from it, and the pre-swap migration
# ordering stops meaning anything. It happens in practice — re-running after a
# mid-deploy hang, or a second person deploying while the first is mid-build.
#
# The lock is held on fd 9 for the lifetime of the process, so it releases on
# exit however the script ends — including a `set -e` abort or a Ctrl-C.
# flock is util-linux (present on the Ubuntu prod host); if it is missing we
# warn rather than block, since an unlocked deploy still beats no deploy.
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/product-editor-deploy.lock}"
if command -v flock >/dev/null 2>&1; then
  # `9>>` (append), not `9>`: the truncating form empties the file at open time,
  # i.e. BEFORE flock runs, so it wipes the holder's PID and the "another deploy
  # is running" message can never name the process you need to look at.
  exec 9>>"$DEPLOY_LOCK_FILE"
  if flock -n 9; then
    printf '%s\n' "$$" > "$DEPLOY_LOCK_FILE" || true
  else
    print_error "Another deploy is already running (lock: ${DEPLOY_LOCK_FILE})"
    print_info "Holder PID: $(cat "$DEPLOY_LOCK_FILE" 2>/dev/null || echo unknown)"
    print_info "If that process is dead, remove the file and re-run."
    exit 1
  fi
else
  print_warning "flock not found — running without the concurrent-deploy lock."
fi

# Worker services share backend/django/Dockerfile with the `backend` service
# but Docker Compose tags each one independently — so a code change in
# api/tasks.py, api/views.py, models, settings, etc. needs ALL of these
# images rebuilt for workers to see the new code. The `backend` and
# `workers` modes both rebuild this set; `both` does it implicitly via
# `docker-compose build` with no args.
WORKER_SERVICES="celery-worker-standard celery-beat"
BACKEND_SERVICES="backend $WORKER_SERVICES"

# ── Rollback ────────────────────────────────────────────────────────────────
# Every deploy tags the outgoing image `<repo>:backup-YYYYmmdd-HHMMSS` and the
# cleanup step keeps the last 3 — but until now nothing could restore one, so
# the only way back from a bad deploy was a forward fix under pressure.
#
# Deliberately does NOT touch the database. Migrations here are additive and
# backward-compatible by policy (nullable columns, new indexes), which is what
# makes rolling code back over a migrated schema safe: the old code simply does
# not use the new columns. A migration that ever breaks that policy makes this
# command unsafe — say so in its docstring if you write one.
#
# Workers are restored from the BACKEND backup image, not their own. They build
# from the same Dockerfile and context, so the backend image carries the same
# source; the differing entrypoint comes from compose's `command:`, at runtime.
# This is why worker images are not backed up separately (3.2 GB each).
latest_backup_tag() {
  local repo="$1"
  docker images --format '{{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null \
    | grep -E ':backup-[0-9]{8}-[0-9]{6}$' \
    | sort -r \
    | head -n 1 || true
}

do_rollback() {
  print_header "Rollback"
  print_info "Target: ${ROLLBACK_TARGET}"

  local backend_backup="" frontend_backup=""
  if [[ "$ROLLBACK_TARGET" == "backend" || "$ROLLBACK_TARGET" == "both" ]]; then
    backend_backup=$(latest_backup_tag product-editor-backend)
    if [ -z "$backend_backup" ]; then
      print_error "No backend backup image found — nothing to roll back to."
      print_info "Backups are created by a normal deploy; a first-ever deploy has none."
      exit 1
    fi
    print_info "Backend  → ${backend_backup}"
  fi
  if [[ "$ROLLBACK_TARGET" == "frontend" || "$ROLLBACK_TARGET" == "both" ]]; then
    frontend_backup=$(latest_backup_tag product-editor-frontend)
    if [ -z "$frontend_backup" ]; then
      print_error "No frontend backup image found — nothing to roll back to."
      exit 1
    fi
    print_info "Frontend → ${frontend_backup}"
  fi

  echo ""
  print_warning "This restarts containers on the OLD image. The database is NOT reverted."
  print_warning "Any migration applied by the bad deploy stays applied (additive by policy)."
  echo ""

  if [ "${ROLLBACK_YES:-0}" != "1" ]; then
    read -r -p "Proceed with rollback? [y/N] " reply
    case "$reply" in
      [yY]|[yY][eE][sS]) ;;
      *) print_info "Rollback cancelled."; exit 0 ;;
    esac
  fi

  # Preserve what we are rolling back FROM, as a backup tag of its own. Without
  # this the outgoing image loses its only tag and the `docker image prune -f`
  # in the cleanup step reclaims it — so you could roll back but never forward,
  # and the fix would need a full rebuild.
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  local svc services=()

  if [ -n "$backend_backup" ]; then
    docker tag product-editor-backend:latest "product-editor-backend:backup-${stamp}" 2>/dev/null || true
    print_action "Restoring backend image..."
    docker tag "$backend_backup" product-editor-backend:latest
    # Same source, different runtime command — see the note above.
    for svc in $WORKER_SERVICES; do
      docker tag "$backend_backup" "product-editor-${svc}:latest"
    done
    print_status "Backend + workers pointed at ${backend_backup}"
    services+=(backend $WORKER_SERVICES)
  fi

  if [ -n "$frontend_backup" ]; then
    docker tag product-editor-frontend:latest "product-editor-frontend:backup-${stamp}" 2>/dev/null || true
    print_action "Restoring frontend image..."
    docker tag "$frontend_backup" product-editor-frontend:latest
    print_status "Frontend pointed at ${frontend_backup}"
    services+=(frontend)
  fi

  print_action "Recreating containers on the restored image(s)..."
  if docker-compose up -d --force-recreate "${services[@]}"; then
    print_status "Containers recreated"
  else
    fail "Failed to recreate containers during rollback"
    docker-compose logs --tail=30 "${services[@]}" || true
  fi
}

# Skipped on rollback. nginx.conf is bind-mounted from the repo, not baked into
# an image, so rolling images back cannot fix a bad proxy config — but the
# `nginx -t` gate below exits 1, which would BLOCK the rollback of a broken
# deploy over a problem the rollback was never going to solve.
if [ "$MODE" = "rollback" ]; then
  print_header "Rollback — Skipping Proxy Preparation"
  print_info "nginx.conf and certs come from the repo, not the images being restored."
else
  # ── Prepare nginx config ────────────────────────────────────────────────────
  print_header "Preparing Proxy Configuration"
  mkdir -p proxy/nginx/certs

  # ── Origin TLS cert ─────────────────────────────────────────────────────────
  # Production: paste a Cloudflare Origin Certificate (CF dashboard → SSL/TLS →
  # Origin Server → Create Certificate) into proxy/nginx/certs/origin.crt and
  # origin.key. CF accepts it under "Full (strict)".
  # Bootstrap / dev: if no cert exists, generate a self-signed one. With CF in
  # "Full" mode (not strict) this works; CF won't validate against a public CA.
  if [ -d proxy/nginx/certs/origin.crt ]; then
    print_warning "Removing proxy/nginx/certs/origin.crt directory (Docker bind-mount auto-create)."
    rm -rf proxy/nginx/certs/origin.crt
  fi
  if [ -d proxy/nginx/certs/origin.key ]; then
    print_warning "Removing proxy/nginx/certs/origin.key directory (Docker bind-mount auto-create)."
    rm -rf proxy/nginx/certs/origin.key
  fi
  if [ ! -f proxy/nginx/certs/origin.crt ] || [ ! -f proxy/nginx/certs/origin.key ]; then
    print_warning "No origin TLS cert found. Generating a self-signed cert for bootstrap."
    print_warning "For production: paste the Cloudflare Origin Certificate into:"
    print_warning "  proxy/nginx/certs/origin.crt   (the certificate body)"
    print_warning "  proxy/nginx/certs/origin.key   (the private key)"
    print_warning "Then set Cloudflare SSL/TLS mode to 'Full (strict)'."
    CN_HOST="${PUBLIC_HOST:-product-editor.local}"
    openssl req -x509 -nodes -days 3650 \
      -newkey rsa:2048 \
      -keyout proxy/nginx/certs/origin.key \
      -out proxy/nginx/certs/origin.crt \
      -subj "/CN=${CN_HOST}/O=product-editor self-signed" \
      -addext "subjectAltName=DNS:${CN_HOST},DNS:*.${CN_HOST#*.}" 2>/dev/null
    chmod 600 proxy/nginx/certs/origin.key
    chmod 644 proxy/nginx/certs/origin.crt
    print_status "Self-signed origin cert generated for ${CN_HOST}"
  fi

  # ── nginx config syntax check ───────────────────────────────────────────────
  # Catches typos before we restart the proxy and 502 the world.
  print_action "Validating proxy/nginx/nginx.conf syntax..."
  if docker run --rm \
    -v "$(pwd)/proxy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$(pwd)/proxy/nginx/certs:/etc/nginx/certs:ro" \
    nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
    print_status "nginx.conf is valid"
  else
    print_error "nginx.conf failed validation — running nginx -t for details:"
    docker run --rm \
      -v "$(pwd)/proxy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
      -v "$(pwd)/proxy/nginx/certs:/etc/nginx/certs:ro" \
      nginx:1.27-alpine nginx -t || true
    exit 1
  fi
fi

# ── Use ONLY docker-compose.yml (never merge the dev override) ──────────────
# docker-compose.override.yml (when present) remaps ports and runs services in
# dev mode — all of which break production. Exporting COMPOSE_FILE guarantees
# every docker-compose call in this script ignores the override.
export COMPOSE_FILE=docker-compose.yml

# ── Include the monitoring stack ────────────────────────────────────────────
# loki / promtail / grafana / alloy sit behind compose's `monitoring` profile.
# `both` mode runs `down` (which stops all 12 containers) then `up -d` (which
# starts only the 8 non-profile ones), so every full deploy silently left the
# observability stack dead until someone restarted it by hand — exactly when
# you most want logs. Exporting the profile makes `up -d` restore them too.
# All four are image-only, so this adds nothing to the build step.
# Set COMPOSE_PROFILES= (empty) in the environment to opt out.
export COMPOSE_PROFILES="${COMPOSE_PROFILES-monitoring}"

# ── Pull latest code from GitHub before deploying ───────────────────────────
if [ "$MODE" = "rollback" ]; then
  print_header "Rollback — Skipping Code Pull"
  print_info "Rolling back IMAGES, not source. The checkout is left untouched."
else
  print_header "Pulling Latest Code"
  print_action "Running git pull..."
  # The pull IS the deploy — deploy.sh git-pulls main on the server, so a failed
  # pull means rebuilding the code already on disk. The previous form piped git
  # through `tee | while read`, and an `if` on a pipeline sees only the LAST
  # command's status: the while loop always succeeded, so the failure branch was
  # unreachable and a broken pull printed "Code updated successfully".
  #
  # Now the status is captured directly, and a failed pull ABORTS rather than
  # shipping stale code under a green message. Set ALLOW_STALE_DEPLOY=1 to
  # redeploy the current checkout on purpose (e.g. GitHub unreachable, or
  # re-running after a mid-deploy hang).
  GIT_PULL_LOG=$(mktemp -t git_pull_output.XXXXXX)
  GIT_PULL_STATUS=0
  git pull >"$GIT_PULL_LOG" 2>&1 || GIT_PULL_STATUS=$?

  while IFS= read -r line; do
    echo -e "${CYAN}→${NC} $line"
  done <"$GIT_PULL_LOG"

  if [ "$GIT_PULL_STATUS" -eq 0 ]; then
    if grep -q "Already up to date" "$GIT_PULL_LOG"; then
      print_info "Already up to date — no new changes"
    else
      print_status "Code updated successfully"
    fi
    rm -f "$GIT_PULL_LOG"
  else
    print_error "git pull FAILED (exit ${GIT_PULL_STATUS}) — check SSH key / remote / local changes"
    rm -f "$GIT_PULL_LOG"
    if [ "${ALLOW_STALE_DEPLOY:-0}" = "1" ]; then
      print_warning "ALLOW_STALE_DEPLOY=1 — continuing with the code already on disk."
      print_warning "This deploys commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown), NOT the latest main."
    else
      print_error "Refusing to deploy stale code. Fix the pull, or re-run with:"
      print_info "  ALLOW_STALE_DEPLOY=1 ./deploy.sh ${MODE}"
      exit 1
    fi
  fi
fi

# Start deployment
print_header "Product Editor Deployment"
print_info "Mode: ${MODE}"
print_info "Started at: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Backup existing images
print_header "Backing Up Current Images"
if [[ "$MODE" == "both" ]]; then
  if docker images | grep -q "product-editor-backend"; then
    print_action "Tagging backend image as backup..."
    docker tag product-editor-backend:latest product-editor-backend:backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
    print_status "Backend image backed up"
  fi
  if docker images | grep -q "product-editor-frontend"; then
    print_action "Tagging frontend image as backup..."
    docker tag product-editor-frontend:latest product-editor-frontend:backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
    print_status "Frontend image backed up"
  fi
elif [[ "$MODE" == "backend" ]]; then
  if docker images | grep -q "product-editor-backend"; then
    print_action "Tagging backend image as backup..."
    docker tag product-editor-backend:latest product-editor-backend:backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
    print_status "Backend image backed up"
  fi
elif [[ "$MODE" == "frontend" ]]; then
  if docker images | grep -q "product-editor-frontend"; then
    print_action "Tagging frontend image as backup..."
    docker tag product-editor-frontend:latest product-editor-frontend:backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
    print_status "Frontend image backed up"
  fi
fi

# Stop and remove containers
print_header "Stopping Services"
if [[ "$MODE" == "both" ]]; then
  print_action "Stopping all containers..."
  # Status captured explicitly rather than read off the end of a pipeline —
  # under pipefail a `down` failure would otherwise abort mid-teardown with no
  # explanation, and without pipefail it was invisible.
  DOWN_LOG=$(mktemp -t compose_down.XXXXXX)
  DOWN_STATUS=0
  docker-compose down --remove-orphans >"$DOWN_LOG" 2>&1 || DOWN_STATUS=$?
  while IFS= read -r line; do
    if [[ "$line" =~ "Stopping" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "Stopped" || "$line" =~ "Removed" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done <"$DOWN_LOG"
  if [ "$DOWN_STATUS" -eq 0 ]; then
    print_status "All services stopped and removed"
  else
    print_warning "docker-compose down exited ${DOWN_STATUS} — continuing; the port sweep below usually clears the cause"
    tail -5 "$DOWN_LOG"
  fi
  rm -f "$DOWN_LOG"
  
  # Kill any processes using ports 80, 443, 8000, 5004
  print_action "Freeing up ports..."
  for port in 80 443 8000 5004; do
    pid=$(sudo lsof -ti:$port 2>/dev/null || true)
    if [ ! -z "$pid" ]; then
      sudo kill -9 $pid 2>/dev/null && print_status "Freed port $port" || print_info "Port $port already free"
    fi
  done
elif [[ "$MODE" == "backend" ]]; then
  print_action "Stopping backend + celery worker containers..."
  docker-compose stop $BACKEND_SERVICES 2>&1 | grep -v "^$" || true
  print_status "Backend + workers stopped"
  print_action "Removing containers..."
  for svc in $BACKEND_SERVICES; do
    docker rm -f "product-editor-${svc}-1" 2>/dev/null && print_status "Removed product-editor-${svc}-1" || print_info "No product-editor-${svc}-1 to remove"
  done

  # Free port 8000 (only backend exposes a host port; workers are internal)
  pid=$(sudo lsof -ti:8000 2>/dev/null || true)
  if [ ! -z "$pid" ]; then
    sudo kill -9 $pid 2>/dev/null && print_status "Freed port 8000" || print_info "Port 8000 already free"
  fi
elif [[ "$MODE" == "workers" ]]; then
  print_action "Stopping celery worker containers..."
  docker-compose stop $WORKER_SERVICES 2>&1 | grep -v "^$" || true
  print_status "Workers stopped"
  print_action "Removing worker containers..."
  for svc in $WORKER_SERVICES; do
    docker rm -f "product-editor-${svc}-1" 2>/dev/null && print_status "Removed product-editor-${svc}-1" || print_info "No product-editor-${svc}-1 to remove"
  done
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Stopping frontend container..."
  docker-compose stop frontend 2>&1 | grep -v "^$" || true
  print_status "Frontend stopped"
  print_action "Removing frontend container..."
  docker rm -f product-editor-frontend-1 2>/dev/null && print_status "Frontend container removed" || print_info "No container to remove"
  
  # Free port 5004
  pid=$(sudo lsof -ti:5004 2>/dev/null || true)
  if [ ! -z "$pid" ]; then
    sudo kill -9 $pid 2>/dev/null && print_status "Freed port 5004" || print_info "Port 5004 already free"
  fi
fi

# Remove old images
print_header "Cleaning Old Images"
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  print_action "Removing old backend image..."
  docker rmi product-editor-backend:latest 2>/dev/null && print_status "Old backend image removed" || print_info "No old backend image found"
fi
if [[ "$MODE" == "frontend" || "$MODE" == "both" ]]; then
  print_action "Removing old frontend image..."
  docker rmi product-editor-frontend:latest 2>/dev/null && print_status "Old frontend image removed" || print_info "No old frontend image found"
fi

# Build services — stream full output so failures are visible
print_header "Building New Images"
if [[ "$MODE" == "backend" ]]; then
  # Rebuild backend AND all workers together — they share the same Dockerfile
  # so any code change in api/, models, settings, tasks needs all 4 images
  # rebuilt or workers will keep running stale code (e.g. registering
  # a renamed task under its old name and processing in-flight messages
  # against deleted code paths).
  print_action "Building backend + worker images (output below)..."
  if docker-compose build $BACKEND_SERVICES; then
    print_status "Backend + worker images built successfully"
  else
    print_error "Backend/worker build FAILED — aborting deployment"
    exit 1
  fi
elif [[ "$MODE" == "workers" ]]; then
  print_action "Building worker images (output below)..."
  if docker-compose build $WORKER_SERVICES; then
    print_status "Worker images built successfully"
  else
    print_error "Worker build FAILED — aborting deployment"
    exit 1
  fi
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Building frontend image (output below)..."
  if docker-compose build frontend; then
    print_status "Frontend image built successfully"
  else
    print_error "Frontend build FAILED — aborting deployment"
    exit 1
  fi
elif [[ "$MODE" == "both" ]]; then
  print_action "Building all images (output below)..."
  if docker-compose build; then
    print_status "All images built successfully"
  else
    print_error "Image build FAILED — aborting deployment"
    exit 1
  fi
fi

# Run migrations BEFORE recreating app containers. New-code containers
# started against an unmigrated DB 500 on submits and permanently fail any
# queued render job (burning its retries in ~14 s, firing a false "failed"
# webhook at the storefront). Migrations are always backward-compatible
# (nullable adds / index changes), so old containers keep working while
# the schema moves first. A migration failure must ABORT the deploy — the
# old code keeps running untouched.
if [[ "$MODE" == "backend" || "$MODE" == "both" || "$MODE" == "workers" ]]; then
  print_header "Database Migrations (before container swap)"
  print_action "Ensuring db is up..."
  docker-compose up -d db redis
  print_action "Running migrations with the freshly built image..."
  # --entrypoint bypasses entrypoint.sh here on PURPOSE. The web entrypoint
  # ignores its "$@" and always ends in `exec gunicorn`, so a plain
  # `run ... backend python manage.py migrate` starts a full server that never
  # exits — hanging the deploy. Invoking the venv python directly runs migrate
  # and returns, preserving the fail-fast-before-swap intent.
  if docker-compose run --rm --entrypoint /opt/venv/bin/python backend manage.py migrate --noinput; then
    print_status "Migrations applied"
  else
    print_error "Migrations FAILED — aborting before swapping containers (old code still running)"
    exit 1
  fi
fi

# Start services
print_header "Starting Services"
if [[ "$MODE" == "backend" ]]; then
  print_action "Creating and starting backend + worker containers..."
  # --force-recreate ensures containers pick up the freshly-built image
  # even when their config hash hasn't changed (Docker's default would
  # skip recreate and keep running the old image).
  if docker-compose up -d --force-recreate $BACKEND_SERVICES; then
    print_status "Backend + workers started"
  else
    print_error "Failed to start backend/workers"
    docker-compose logs --tail=30 $BACKEND_SERVICES
    exit 1
  fi
elif [[ "$MODE" == "workers" ]]; then
  print_action "Creating and starting worker containers..."
  if docker-compose up -d --force-recreate $WORKER_SERVICES; then
    print_status "Workers started"
  else
    print_error "Failed to start workers"
    docker-compose logs --tail=30 $WORKER_SERVICES
    exit 1
  fi
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Creating and starting frontend container..."
  if docker-compose up -d frontend; then
    print_status "Frontend started"
  else
    print_error "Failed to start frontend"
    docker-compose logs --tail=30 frontend
    exit 1
  fi
elif [[ "$MODE" == "both" ]]; then
  print_action "Creating and starting all containers..."
  if docker-compose up -d; then
    print_status "All services started"
  else
    print_error "Failed to start services — showing logs"
    docker-compose logs --tail=50
    exit 1
  fi
fi

# Rollback does its image restore + container recreate here — after the deploy
# paths above have all declined to match, and before the shared status/health
# reporting below, which it reuses unchanged.
if [[ "$MODE" == "rollback" ]]; then
  do_rollback
fi

# Migrations already ran before the container swap (see above). A no-op
# safety pass catches anything a hotfix added between build and start.
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  print_header "Database Migrations (post-start safety pass)"
  docker-compose exec -T backend python manage.py migrate --noinput 2>&1 | while read line; do
    if [[ "$line" =~ "Applying" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "OK" || "$line" =~ "No migrations" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done || {
    fail "Post-start migrate check failed — schema may not match the running code"
  }
  print_status "Migrations completed"
fi

# Show service status
print_header "Service Status"
docker-compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

# Health checks
print_header "Health Checks"

# Wait a bit for containers to fully start
if [[ "$MODE" == "both" ]]; then
  print_action "Waiting for services to initialize..."
  sleep 10
  print_status "Services initialized"
elif [[ "$MODE" == "backend" ]]; then
  print_action "Waiting for backend to initialize..."
  sleep 8
  print_status "Backend initialized"
elif [[ "$MODE" == "workers" ]]; then
  print_action "Waiting for workers to initialize..."
  sleep 5
  print_status "Workers initialized"
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Waiting for frontend to initialize..."
  sleep 5
  print_status "Frontend initialized"
elif [[ "$MODE" == "rollback" ]]; then
  print_action "Waiting for restored containers to initialize..."
  sleep 10
  print_status "Restored containers initialized"
fi

# Backend health check
#
# Extracted into a function so `./deploy.sh rollback` verifies the restored
# image with exactly the same checks a forward deploy runs — a rollback that
# is not health-checked is just a second untested deploy.
run_backend_health_checks() {
  print_action "Checking backend health..."
  
  # Get backend container name
  # `|| true`: grep exits 1 when no backend container exists. Under pipefail
  # that would abort the script here instead of reaching the check below.
  BACKEND_CONTAINER=$(docker ps --filter "name=backend" --format "{{.Names}}" | grep backend | head -n 1) || true
  
  if [ -z "$BACKEND_CONTAINER" ]; then
    fail "Backend container not found"
    docker ps -a | grep backend || print_warning "No backend container exists at all"
  else
    # Wait for backend to be ready
    print_action "Waiting for backend to start (max 30s)..."
    for i in {1..30}; do
      if curl -s http://localhost:8000/api/health > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    
    # Test health endpoint
    HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:8000/api/health 2>/dev/null || echo "failed\n000")
    HTTP_CODE=$(echo "$HEALTH_RESPONSE" | tail -n 1)
    
    if [ "$HTTP_CODE" = "200" ]; then
      print_status "Backend health endpoint OK (HTTP $HTTP_CODE)"
    else
      fail "Backend health endpoint failed (HTTP $HTTP_CODE)"
      print_warning "Check logs: docker logs $BACKEND_CONTAINER"
    fi
    
    # Test database connectivity
    print_action "Checking database connectivity..."
    DB_CHECK=$(docker exec $BACKEND_CONTAINER python manage.py check --database default 2>&1)
    if echo "$DB_CHECK" | grep -q "no issues"; then
      print_status "Database connection OK"
    else
      fail "Database connection issues"
      echo "$DB_CHECK"
    fi
    
    # Check storage directory
    print_action "Checking storage directory..."
    if docker exec $BACKEND_CONTAINER test -d /app/storage; then
      print_status "Storage directory accessible"
      LAYOUT_COUNT=$(docker exec $BACKEND_CONTAINER find /app/storage/layouts -name "*.json" 2>/dev/null | wc -l || echo "0")
      print_info "Found $LAYOUT_COUNT layout(s)"
    else
      fail "Storage directory not accessible"
    fi
    
    # Check API keys
    print_action "Checking API keys in database..."
    API_KEY_COUNT=$(docker exec $BACKEND_CONTAINER python manage.py shell -c "from api.models import APIKey; print(APIKey.objects.filter(is_active=True).count())" 2>/dev/null || echo "0")
    if [ "$API_KEY_COUNT" -gt 0 ]; then
      print_status "Found $API_KEY_COUNT active API key(s)"
    else
      print_warning "No active API keys found"
      print_info "Create one with: docker exec $BACKEND_CONTAINER python manage.py create_api_key"
    fi
    
    # Test layouts endpoint with API key
    if [ -f .env ]; then
      source .env 2>/dev/null || true
      if [ -n "$DIRECT_API_KEY" ]; then
        print_action "Testing layouts endpoint with API key..."
        LAYOUTS_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $DIRECT_API_KEY" http://localhost:8000/api/layouts 2>/dev/null || echo "failed\n000")
        HTTP_CODE=$(echo "$LAYOUTS_RESPONSE" | tail -n 1)
        
        if [ "$HTTP_CODE" = "200" ]; then
          print_status "Layouts endpoint OK (HTTP $HTTP_CODE)"
          LAYOUT_COUNT=$(echo "$LAYOUTS_RESPONSE" | head -n -1 | grep -o '"name"' | wc -l || echo "0")
          print_info "API returned $LAYOUT_COUNT layout(s)"
        else
          fail "Layouts endpoint failed (HTTP $HTTP_CODE)"
          RESPONSE_BODY=$(echo "$LAYOUTS_RESPONSE" | head -n -1)
          echo "  Response: $RESPONSE_BODY"
        fi
      fi
    fi
    
    # Check Redis connectivity
    print_action "Checking Redis connectivity..."
    if docker exec product-editor-redis-1 redis-cli ping 2>&1 | grep -q "PONG"; then
      print_status "Redis is responding"
    else
      fail "Redis is not responding"
    fi
  fi
}

# Rollback verifies through exactly the same checks as a forward deploy —
# an unverified rollback is just a second untested deploy.
if [[ "$MODE" == "backend" || "$MODE" == "both" ]] \
   || [[ "$MODE" == "rollback" && "$ROLLBACK_TARGET" != "frontend" ]]; then
  run_backend_health_checks
fi

# Frontend health check — see the note on run_backend_health_checks above.
run_frontend_health_checks() {
  print_action "Checking frontend health..."
  
  # Get frontend container name
  # `|| true`: see the BACKEND_CONTAINER note above.
  FRONTEND_CONTAINER=$(docker ps --filter "name=frontend" --format "{{.Names}}" | grep frontend | head -n 1) || true
  
  if [ -z "$FRONTEND_CONTAINER" ]; then
    fail "Frontend container not found"
    docker ps -a | grep frontend || print_warning "No frontend container exists at all"
  else
    # Wait for frontend to be ready
    print_action "Waiting for frontend to start (max 30s)..."
    for i in {1..30}; do
      if curl -s http://localhost:5004 > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    
    # Test frontend endpoint
    FRONTEND_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:5004 2>/dev/null || echo "failed\n000")
    HTTP_CODE=$(echo "$FRONTEND_RESPONSE" | tail -n 1)
    
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ] || [ "$HTTP_CODE" = "308" ]; then
      print_status "Frontend responding OK (HTTP $HTTP_CODE)"
    else
      fail "Frontend not responding (HTTP $HTTP_CODE)"
      print_warning "Check logs: docker logs $FRONTEND_CONTAINER"
    fi
    
    # Check if frontend can reach backend
    if [[ "$MODE" == "both" ]]; then
      print_action "Checking frontend-to-backend connectivity..."
      BACKEND_CHECK=$(docker exec $FRONTEND_CONTAINER wget -q -O- http://backend:8000/api/health 2>/dev/null || echo "failed")
      if echo "$BACKEND_CHECK" | grep -q "ok\|healthy\|status"; then
        print_status "Frontend can reach backend"
      else
        fail "Frontend cannot reach backend"
      fi
    fi
    
    # Check environment variables
    print_action "Checking frontend environment..."
    API_BASE=$(docker exec $FRONTEND_CONTAINER printenv NEXT_PUBLIC_API_BASE_URL 2>/dev/null || echo "not set")
    if [ "$API_BASE" != "not set" ]; then
      print_status "API base URL configured: $API_BASE"
    else
      print_warning "NEXT_PUBLIC_API_BASE_URL not set"
    fi
  fi
}

if [[ "$MODE" == "frontend" || "$MODE" == "both" ]] \
   || [[ "$MODE" == "rollback" && "$ROLLBACK_TARGET" != "backend" ]]; then
  run_frontend_health_checks
fi

# ── Post-deploy smoke tests ─────────────────────────────────────────────────
# The health checks above prove the containers are UP; they do not prove the
# customer flow still works. The repo already carries end-to-end scripts for
# that and the deploy ran none of them, so a deploy that broke embed-session
# creation still reported success.
#
# Defaults chosen to be safe to run on every deploy:
#   * BASE=https://localhost + CURL_INSECURE=1 — exercises the real nginx edge
#     (the path prod actually serves) rather than the container ports. The
#     origin cert is a Cloudflare Origin cert, not publicly trusted, so without
#     CURL_INSECURE every check returns 000 and reads as a total outage.
#   * embed only. It is the core customer path. calendar/book are read-only
#     too and can be added via SMOKE_TESTS, but each extra script is another
#     ~3 s on every deploy.
#   * SMOKE_RENDER is deliberately NOT set: a real render occupies a Celery
#     worker slot and writes 300-DPI output, competing with live customer jobs
#     on the 2-core prod box.
#
# A failed smoke test records a deploy failure (see `fail`) but does not abort —
# you still get the remaining checks and the summary.
run_smoke_tests() {
  local base="${SMOKE_BASE:-https://localhost}"
  local tests="${SMOKE_TESTS:-embed}"
  local key="${SMOKE_API_KEY:-${DIRECT_API_KEY:-}}"
  local name script

  if [ -z "$key" ]; then
    print_warning "No DIRECT_API_KEY in .env — skipping smoke tests"
    print_info "Set SMOKE_API_KEY=<key> to run them explicitly."
    return 0
  fi

  for name in $tests; do
    script="scripts/smoke-test-${name}.sh"
    if [ ! -x "$script" ]; then
      print_warning "Smoke test not found or not executable: ${script} — skipping"
      continue
    fi
    print_action "Running ${script} against ${base}..."
    if API_KEY="$key" BASE="$base" CURL_INSECURE=1 "$script"; then
      print_status "Smoke test '${name}' passed"
    else
      fail "Smoke test '${name}' failed (${script} against ${base})"
    fi
  done
}

if [ "${SKIP_SMOKE_TESTS:-0}" = "1" ]; then
  print_header "Smoke Tests"
  print_info "SKIP_SMOKE_TESTS=1 — skipped"
elif [[ "$MODE" == "workers" ]]; then
  : # workers mode restarts neither the API nor the frontend — nothing to smoke
else
  print_header "Smoke Tests"
  # .env is sourced inside the backend health check above, but not on every
  # path (frontend-only deploys, rollback), so read it here too before
  # reaching for DIRECT_API_KEY.
  if [ -f .env ]; then
    source .env 2>/dev/null || true
  fi
  run_smoke_tests
fi

# Show API keys
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  echo ""
  print_header "API Keys"
  print_action "Retrieving API keys..."
  sleep 2
  docker-compose logs backend 2>/dev/null | grep -A 5 "Available API Keys" | tail -5 | while read line; do
    if [[ "$line" =~ ":" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done || {
    print_warning "Could not retrieve API keys from logs"
  }
fi

# Cleanup old backup images (keep last 3)
# Workers share content with the backend image but get tagged separately; we
# don't bother backing them up individually (rolling back the backend image
# and rebuilding workers from the same Dockerfile gets the old code back).
#
# Two bugs kept this from ever holding the "last 3" limit in production, where
# 11 backend backups (2.46 GB each) had piled up since a single busy deploy day:
#
#   1. It was gated on $MODE, so `deploy.sh frontend` never pruned backend
#      backups. Since a frontend-only deploy also never rebuilds the backend,
#      nothing pruned them for as long as nobody ran a backend deploy — 12 days
#      in the case that surfaced this. The prune is now unconditional: old
#      backups are dead weight regardless of which half we are deploying.
#
#   2. It deleted by IMAGE ID (`awk '{print $3}'`). Retagging the same image on
#      successive deploys gives several backup tags one shared ID, and
#      `docker rmi <id>` refuses to remove a multiply-tagged image without -f.
#      The `2>/dev/null` then swallowed the error and the script reported
#      success. Deleting by TAG instead simply drops the tag; Docker reclaims
#      the layers when the last tag referencing them goes.
#
# Sorting is on the tag's own `backup-YYYYmmdd-HHMMSS` stamp, not CreatedAt:
# retagged images share a build date, so CreatedAt cannot order them.
prune_backup_images() {
  local repo="$1"
  local stale
  stale=$(
    docker images --format '{{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null \
      | grep -E ':backup-[0-9]{8}-[0-9]{6}$' \
      | sort -r \
      | tail -n +4
  ) || true

  if [[ -z "$stale" ]]; then
    print_info "No old ${repo##*-} backups to remove"
    return 0
  fi

  local count=0
  while IFS= read -r tag; do
    [[ -z "$tag" ]] && continue
    if docker rmi "$tag" >/dev/null 2>&1; then
      count=$((count + 1))
    else
      print_warning "Could not remove $tag (still in use?)"
    fi
  done <<< "$stale"
  print_status "Removed ${count} old ${repo##*-} backup image(s), kept last 3"
}

print_header "Cleanup"
print_action "Removing old backup images (keeping last 3)..."
prune_backup_images product-editor-backend
prune_backup_images product-editor-frontend

# Reclaim build cache and dangling images.
#
# The backup-image cleanup above only ever removed images tagged *backup*, so
# nothing pruned Docker's build cache or the untagged layers each rebuild
# leaves behind. On the production host these had grown to ~37 GB of build
# cache and 118 images (~33 GB) — the disk hit 86% with 9.8 GB free.
#
# Deliberately narrow:
#   * `image prune -f`   — DANGLING (untagged) images only. The *backup* images
#     kept for rollback are tagged, so they survive. NEVER use -a here: that
#     removes every image not backing a running container, which is exactly the
#     rollback set.
#   * `builder prune`    — cache older than 7 days, so a same-week redeploy
#     still gets warm layers while old cache cannot accumulate forever.
print_action "Reclaiming dangling images + build cache older than 7 days..."
BEFORE_AVAIL=$(df -h / | awk 'NR==2 {print $4}')
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
AFTER_AVAIL=$(df -h / | awk 'NR==2 {print $4}')
print_status "Docker cleanup done — disk available: ${BEFORE_AVAIL} -> ${AFTER_AVAIL}"

# ── Final summary ───────────────────────────────────────────────────────────
# A function so the rollback path reports through the same gate as a deploy.
# Exits the script: non-zero when any check failed, 0 otherwise.
print_final_summary() {
  # Final summary
  if [ "$DEPLOY_FAILURES" -gt 0 ]; then
    print_header "Deployment Completed WITH FAILURES"
    print_error "${DEPLOY_FAILURES} health check(s) failed:"
    for failure in "${DEPLOY_FAILURE_LIST[@]}"; do
      echo -e "    ${RED}✗${NC} ${failure}"
    done
    echo ""
    print_warning "The containers ARE running the new image — this is not a rollback."
    print_warning "Investigate before sending customer traffic. Logs: docker-compose logs --tail=100"
  else
    print_header "Deployment Complete"
    print_status "Deployment finished successfully"
  fi
  print_info "Completed at: $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""

  # Detect server hostname/IP
  if [ -f .env ]; then
    source .env 2>/dev/null || true
  fi

  # Determine the base URL
  if [ -n "$PUBLIC_HOST" ] && [ "$PUBLIC_HOST" != "product-editor.printo.in" ]; then
    BASE_URL="https://${PUBLIC_HOST}"
    BACKEND_URL="https://${PUBLIC_HOST}"
  elif [ -n "$PUBLIC_HOST" ]; then
    BASE_URL="https://${PUBLIC_HOST}"
    BACKEND_URL="https://${PUBLIC_HOST}"
  else
    # Fallback to server IP or localhost
    # `|| true`: `hostname -I` is Linux-only and exits non-zero elsewhere.
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}') || true
    if [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "127.0.0.1" ]; then
      BASE_URL="http://${SERVER_IP}:5004"
      BACKEND_URL="http://${SERVER_IP}:8000"
    else
      BASE_URL="http://localhost:5004"
      BACKEND_URL="http://localhost:8000"
    fi
  fi

  # Show access URLs
  if [[ "$MODE" == "frontend" || "$MODE" == "both" || "$MODE" == "rollback" ]]; then
    print_info "Frontend: ${GREEN}${BASE_URL}${NC}"
  fi

  if [[ "$MODE" == "backend" || "$MODE" == "both" || "$MODE" == "rollback" ]]; then
    print_info "Backend API: ${GREEN}${BACKEND_URL}/api${NC}"
    print_info "Health Check: ${GREEN}${BACKEND_URL}/api/health${NC}"
    print_info "Admin Panel: ${GREEN}${BACKEND_URL}/django-admin/${NC}"
  fi

  echo ""
  # Non-zero exit on a failed check, so a human skimming the tail of the log —
  # and anything wrapping this script — can tell a good deploy from a bad one.
  if [ "$DEPLOY_FAILURES" -gt 0 ]; then
    print_error "Exiting non-zero: ${DEPLOY_FAILURES} check(s) failed."
    echo ""
    exit 1
  fi
  print_status "Ready to use!"
  echo ""
}

print_final_summary
