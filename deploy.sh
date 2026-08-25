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
  echo "  SKIP_SMOKE_TESTS=1     skip the post-deploy smoke tests"
  echo "  SMOKE_TESTS=\"embed calendar book\"  which smoke tests to run (default: embed)"
  echo "  ROLLBACK_YES=1         skip the rollback confirmation prompt"
  echo "  READY_TIMEOUT=240      seconds to wait for containers to report ready"
  echo "  DEPLOY_BRANCH=main     branch the server is expected to be on"
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

# ── Readiness polling ───────────────────────────────────────────────────────
# Replaces the fixed `sleep 5/8/10` that used to stand in for "containers are
# up". A fixed sleep is wrong in both directions: too short when the box is
# busy (health checks then fail a container that was merely still booting) and
# needlessly slow when everything is already warm.
#
# Reports a service ready when its healthcheck says `healthy`, or — for
# services that declare no healthcheck, e.g. celery-beat — when the container
# is simply `running`. `starting` and `unhealthy` keep polling: an unhealthy
# container can still recover within its retries.
container_state() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing
}

wait_for_healthy() {
  local timeout="$1"; shift
  local deadline=$(( SECONDS + timeout ))
  local svc cid state pending shown=""

  while :; do
    pending=""
    for svc in "$@"; do
      cid=$(docker-compose ps -q "$svc" 2>/dev/null | head -n 1) || true
      if [ -z "$cid" ]; then
        pending="${pending} ${svc}(no container)"
        continue
      fi
      state=$(container_state "$cid")
      case "$state" in
        healthy|running) ;;
        *) pending="${pending} ${svc}(${state})" ;;
      esac
    done

    if [ -z "$pending" ]; then
      print_status "All services ready ($*)"
      return 0
    fi
    # Only reprint when the set of not-ready services actually changes, so a
    # slow start is one or two lines rather than a wall of identical output.
    if [ "$pending" != "$shown" ]; then
      print_action "Waiting for:${pending}"
      shown="$pending"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      print_warning "Timed out after ${timeout}s still waiting for:${pending}"
      return 1
    fi
    sleep 2
  done
}

# ── Port reclamation ────────────────────────────────────────────────────────
# This used to be `sudo lsof -ti:<port> | xargs kill -9` — kill whatever holds
# the port, no questions asked. On a box shared with anything else that is a
# loaded gun: the deploy would SIGKILL an unrelated service and report it as
# "Freed port 8000".
#
# The only legitimate case is one of OUR OWN containers still holding the
# binding after `docker rm -f`, so that is the only case handled automatically.
# Anything else is reported as a deploy failure and left alone — a port held by
# something unexpected is a situation for a human, not for `kill -9`.
#
# Note it no longer needs sudo to act, only (optionally) to see processes owned
# by other users during identification.
ensure_port_free() {
  local port="$1"
  local holder pids first cmd

  holder=$(docker ps --filter "publish=${port}" --format '{{.Names}}' 2>/dev/null | head -n 1) || true
  if [ -n "$holder" ]; then
    if [[ "$holder" == product-editor-* ]]; then
      print_action "Port ${port} still held by our own container ${holder} — removing it"
      docker rm -f "$holder" >/dev/null 2>&1 || true
      print_status "Port ${port} released"
      return 0
    fi
    fail "Port ${port} is published by container '${holder}', which is not part of product-editor — refusing to touch it"
    return 1
  fi

  pids=$(lsof -ti:"${port}" -sTCP:LISTEN 2>/dev/null || sudo lsof -ti:"${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    print_info "Port ${port} is free"
    return 0
  fi

  first=$(echo "$pids" | head -n 1)
  cmd=$(ps -o comm= -p "$first" 2>/dev/null || echo "unknown")
  fail "Port ${port} held by PID(s) $(echo $pids | tr '\n' ' ')(${cmd}) with no matching container — not killing it; investigate and re-run"
  return 1
}

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

# Services rebuilt from this repo, i.e. the ones a deploy actually needs to
# swap. Deliberately EXCLUDES proxy, db, redis and redis-cache:
#   * db / redis / redis-cache run stock upstream images that a deploy never
#     rebuilds. Restarting them drops every open DB connection and kills any
#     in-flight Celery render for no benefit.
#   * proxy runs stock nginx and resolves upstreams at REQUEST time —
#     nginx.conf uses `resolver 127.0.0.11 valid=10s` with variables in
#     proxy_pass precisely so a recreated backend's new IP is picked up
#     without a reload. Leaving it up keeps TLS termination and the health
#     probe alive across the whole swap.
APP_SERVICES="backend frontend $WORKER_SERVICES"

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

# ── The monitoring stack is deliberately NOT profile-activated here ─────────
# loki / promtail / grafana / alloy sit behind compose's `monitoring` profile.
# It is tempting to export COMPOSE_PROFILES=monitoring so `up -d` covers them —
# don't. Verified on the prod host (2026-08-25): the grafana container had been
# up continuously since 2026-08-10, across several `both` deploys, so
# `down --remove-orphans` never touched it. Activating the profile would pull
# all four INTO the down/up cycle and tear down observability on every deploy —
# precisely during the window you most want logs.
#
# This is version-specific and worth re-checking if the binary changes.
# `deploy.sh` invokes `docker-compose` (hyphenated), which on prod is 2.37.1 and
# leaves profile-disabled services alone. The newer `docker compose` plugin
# (verified at v5.4.0) DOES remove them on `down --remove-orphans`. If the two
# are ever unified, re-test before assuming the stack survives a deploy.
#
# To (re)start the monitoring stack by hand after stopping it:
#   COMPOSE_PROFILES=monitoring docker-compose up -d

# ── Pull latest code from GitHub before deploying ───────────────────────────
if [ "$MODE" = "rollback" ]; then
  print_header "Rollback — Skipping Code Pull"
  print_info "Rolling back IMAGES, not source. The checkout is left untouched."
else
  print_header "Pulling Latest Code"

  # ── Which branch are we about to ship? ───────────────────────────────────
  # deploy.sh pulls and builds whatever branch the server happens to be sitting
  # on, and never said which. A checkout left on a feature branch after some
  # debugging session would deploy that branch to customers, reporting nothing
  # unusual. `main` IS production here, so anything else is a mistake until an
  # operator says otherwise: set DEPLOY_BRANCH to deploy something else on
  # purpose. Detached HEAD reports as "HEAD" and is caught by the same test.
  DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
  if [ "$CURRENT_BRANCH" != "$DEPLOY_BRANCH" ]; then
    print_error "Checkout is on '${CURRENT_BRANCH}', expected '${DEPLOY_BRANCH}'."
    print_info "Deploying a non-production branch is almost always a mistake."
    print_info "  git checkout ${DEPLOY_BRANCH}        # the usual fix"
    print_info "  DEPLOY_BRANCH=${CURRENT_BRANCH} ./deploy.sh ${MODE}   # if you really mean it"
    exit 1
  fi
  print_status "On branch ${CURRENT_BRANCH}"

  # ── Locally-modified tracked files ───────────────────────────────────────
  # Reported, NOT treated as an error. Prod legitimately carries modified
  # storage/layouts/*.json because ops edits layouts at runtime and they are
  # written to disk. Aborting on a dirty tree would block every deploy on that
  # box. A modification that genuinely conflicts with incoming changes makes
  # the pull itself fail, and a failed pull already aborts, so the dangerous
  # case is covered — this is here so the operator can SEE what is local.
  DIRTY=$(git status --porcelain --untracked-files=no 2>/dev/null || true)
  if [ -n "$DIRTY" ]; then
    print_warning "Locally-modified tracked files in the checkout:"
    echo "$DIRTY" | sed 's/^/      /'
    print_info "storage/ edits are expected here (ops edits layouts at runtime)."
    print_info "The pull below fails, and aborts the deploy, if any of these conflict."
  fi

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
  # Nothing is stopped here any more, and that is the point.
  #
  # This used to run `docker-compose down --remove-orphans` BEFORE the image
  # build. Since the build is the slow part, the outage was not the container
  # swap — it was the entire build, minutes of it, with the site down the whole
  # time. It also took Postgres and Redis down (stock images a deploy never
  # rebuilds) and killed any in-flight Celery render mid-job.
  #
  # The old containers now keep serving through the build and migrations, and
  # the swap happens afterwards via `up -d --force-recreate` on APP_SERVICES
  # only (see "Starting Services"). Downtime drops from the build duration to
  # a few seconds per container.
  #
  # The port sweep that used to follow the `down` is gone with it: it killed
  # whatever held 80/443/8000/5004, which — with the containers still running —
  # is now OUR OWN proxy and backend. It existed to clear stragglers left by
  # the teardown, and there is no teardown left to strand anything.
  print_info "Leaving current containers serving; they are swapped after the build."
elif [[ "$MODE" == "backend" ]]; then
  print_action "Stopping backend + celery worker containers..."
  docker-compose stop $BACKEND_SERVICES 2>&1 | grep -v "^$" || true
  print_status "Backend + workers stopped"
  print_action "Removing containers..."
  for svc in $BACKEND_SERVICES; do
    docker rm -f "product-editor-${svc}-1" 2>/dev/null && print_status "Removed product-editor-${svc}-1" || print_info "No product-editor-${svc}-1 to remove"
  done

  # Only backend publishes a host port; workers are internal.
  ensure_port_free "${BACKEND_HOST_PORT:-8000}" || true
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
  
  ensure_port_free "${FRONTEND_HOST_PORT:-5004}" || true
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
  # Two steps on purpose:
  #   1. --force-recreate ONLY the services built from this repo. Verified that
  #      naming services keeps compose from recreating their dependencies, so
  #      db / redis / redis-cache keep their connections and proxy keeps
  #      serving. (Worst case, if a compose version ever did recreate deps, the
  #      result is merely today's old behaviour — a restart — not something
  #      worse.)
  #   2. A plain `up -d` afterwards starts anything not currently running and
  #      sweeps orphans. --remove-orphans is deliberately NOT on the scoped
  #      call above, where the service list makes its blast radius harder to
  #      reason about.
  print_action "Swapping app containers onto the new images..."
  if docker-compose up -d --force-recreate $APP_SERVICES; then
    print_status "App containers swapped ($APP_SERVICES)"
  else
    print_error "Failed to swap app containers — showing logs"
    docker-compose logs --tail=50 $APP_SERVICES
    exit 1
  fi
  print_action "Ensuring supporting services are up..."
  if docker-compose up -d --remove-orphans; then
    print_status "All services running"
  else
    print_error "Failed to start supporting services — showing logs"
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

# Wait for containers to report ready, rather than guessing with a fixed sleep.
#
# 240s because celery-worker's healthcheck has start_period=60s AND
# interval=60s, so its first verdict cannot arrive before ~60s and a retry
# pushes that further; anything tighter would fail a perfectly healthy worker.
# A timeout is recorded via `fail` (deploy exits non-zero) rather than aborting,
# so the checks below still run and you see the full picture.
READY_TIMEOUT="${READY_TIMEOUT:-240}"
case "$MODE" in
  both)
    wait_for_healthy "$READY_TIMEOUT" backend frontend proxy db redis redis-cache $WORKER_SERVICES \
      || fail "Containers did not become ready within ${READY_TIMEOUT}s"
    ;;
  backend)
    wait_for_healthy "$READY_TIMEOUT" $BACKEND_SERVICES \
      || fail "Backend/workers did not become ready within ${READY_TIMEOUT}s"
    ;;
  workers)
    wait_for_healthy "$READY_TIMEOUT" $WORKER_SERVICES \
      || fail "Workers did not become ready within ${READY_TIMEOUT}s"
    ;;
  frontend)
    wait_for_healthy "$READY_TIMEOUT" frontend \
      || fail "Frontend did not become ready within ${READY_TIMEOUT}s"
    ;;
  rollback)
    ROLLBACK_WAIT=""
    [[ "$ROLLBACK_TARGET" != "frontend" ]] && ROLLBACK_WAIT="$ROLLBACK_WAIT backend $WORKER_SERVICES"
    [[ "$ROLLBACK_TARGET" != "backend"  ]] && ROLLBACK_WAIT="$ROLLBACK_WAIT frontend"
    wait_for_healthy "$READY_TIMEOUT" $ROLLBACK_WAIT \
      || fail "Restored containers did not become ready within ${READY_TIMEOUT}s"
    ;;
esac

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
