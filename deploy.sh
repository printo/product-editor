#!/usr/bin/env bash
set -e

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
  echo ""
  echo -e "${BLUE}Examples:${NC}"
  echo "  $0              # Deploy both frontend and backend (default)"
  echo "  $0 frontend     # Deploy only frontend"
  echo "  $0 backend      # Deploy backend AND celery workers + beat"
  echo "                    (they share the same Dockerfile/source)"
  echo "  $0 workers      # Deploy ONLY celery workers + beat — useful when"
  echo "                    recovering from a worker memory leak / hang"
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

# Validate mode
MODE="${1:-both}"
if [[ "$MODE" != "frontend" && "$MODE" != "backend" && "$MODE" != "workers" && "$MODE" != "both" ]]; then
  print_error "Invalid mode: $MODE"
  usage
fi

# Worker services share backend/django/Dockerfile with the `backend` service
# but Docker Compose tags each one independently — so a code change in
# api/tasks.py, api/views.py, models, settings, etc. needs ALL of these
# images rebuilt for workers to see the new code. The `backend` and
# `workers` modes both rebuild this set; `both` does it implicitly via
# `docker-compose build` with no args.
WORKER_SERVICES="celery-worker-priority celery-worker-standard celery-beat"
BACKEND_SERVICES="backend $WORKER_SERVICES"

# ── Prepare nginx config ────────────────────────────────────────────────────
print_header "Preparing Proxy Configuration"
mkdir -p proxy/nginx/certs

# Ensure .htpasswd is a file, not a directory. Docker bind-mounts auto-create
# missing host paths AS DIRECTORIES, which silently breaks any container
# expecting a file at that path. (This was the same footgun that nuked the
# previous Traefik acme.json — keep the defensive rm.)
if [ -d proxy/nginx/.htpasswd ]; then
  print_warning "Removing existing proxy/nginx/.htpasswd directory (Docker bind-mount auto-create)."
  rm -rf proxy/nginx/.htpasswd
fi
if [ ! -f proxy/nginx/.htpasswd ]; then
  print_action "Creating default admin htpasswd..."
  # default: admin / admin (same hash as the old Traefik file)
  echo "admin:\$apr1\$1mi1zF/0\$xS99PzABcMUa4qvh9b7aQ." > proxy/nginx/.htpasswd
  print_status "Default .htpasswd created"
fi

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
  -v "$(pwd)/proxy/nginx/.htpasswd:/etc/nginx/.htpasswd:ro" \
  nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
  print_status "nginx.conf is valid"
else
  print_error "nginx.conf failed validation — running nginx -t for details:"
  docker run --rm \
    -v "$(pwd)/proxy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$(pwd)/proxy/nginx/certs:/etc/nginx/certs:ro" \
    -v "$(pwd)/proxy/nginx/.htpasswd:/etc/nginx/.htpasswd:ro" \
    nginx:1.27-alpine nginx -t || true
  exit 1
fi

# ── Use ONLY docker-compose.yml (never merge the dev override) ──────────────
# docker-compose.override.yml (when present) remaps ports and runs services in
# dev mode — all of which break production. Exporting COMPOSE_FILE guarantees
# every docker-compose call in this script ignores the override.
export COMPOSE_FILE=docker-compose.yml

# ── Pull latest code from GitHub before deploying ───────────────────────────
print_header "Pulling Latest Code"
print_action "Running git pull..."
if git pull 2>&1 | tee /tmp/git_pull_output.txt | while read line; do
  echo -e "${CYAN}→${NC} $line"
done; then
  if grep -q "Already up to date" /tmp/git_pull_output.txt; then
    print_info "Already up to date — no new changes"
  else
    print_status "Code updated successfully"
  fi
else
  print_error "git pull failed — check your SSH key / remote connection"
  print_warning "Continuing with existing code..."
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
  docker-compose down --remove-orphans 2>&1 | while read line; do
    if [[ "$line" =~ "Stopping" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "Stopped" || "$line" =~ "Removed" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done
  print_status "All services stopped and removed"
  
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
else
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
  if docker-compose run --rm backend python manage.py migrate --noinput; then
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
else
  print_action "Creating and starting all containers..."
  if docker-compose up -d; then
    print_status "All services started"
  else
    print_error "Failed to start services — showing logs"
    docker-compose logs --tail=50
    exit 1
  fi
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
    print_warning "Post-start migrate check failed — investigate before routing traffic"
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
fi

# Backend health check
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  print_action "Checking backend health..."
  
  # Get backend container name
  BACKEND_CONTAINER=$(docker ps --filter "name=backend" --format "{{.Names}}" | grep backend | head -n 1)
  
  if [ -z "$BACKEND_CONTAINER" ]; then
    print_error "Backend container not found"
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
      print_error "Backend health endpoint failed (HTTP $HTTP_CODE)"
      print_warning "Check logs: docker logs $BACKEND_CONTAINER"
    fi
    
    # Test database connectivity
    print_action "Checking database connectivity..."
    DB_CHECK=$(docker exec $BACKEND_CONTAINER python manage.py check --database default 2>&1)
    if echo "$DB_CHECK" | grep -q "no issues"; then
      print_status "Database connection OK"
    else
      print_error "Database connection issues"
      echo "$DB_CHECK"
    fi
    
    # Check storage directory
    print_action "Checking storage directory..."
    if docker exec $BACKEND_CONTAINER test -d /app/storage; then
      print_status "Storage directory accessible"
      LAYOUT_COUNT=$(docker exec $BACKEND_CONTAINER find /app/storage/layouts -name "*.json" 2>/dev/null | wc -l || echo "0")
      print_info "Found $LAYOUT_COUNT layout(s)"
    else
      print_error "Storage directory not accessible"
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
          print_error "Layouts endpoint failed (HTTP $HTTP_CODE)"
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
      print_error "Redis is not responding"
    fi
  fi
fi

# Frontend health check
if [[ "$MODE" == "frontend" || "$MODE" == "both" ]]; then
  print_action "Checking frontend health..."
  
  # Get frontend container name
  FRONTEND_CONTAINER=$(docker ps --filter "name=frontend" --format "{{.Names}}" | grep frontend | head -n 1)
  
  if [ -z "$FRONTEND_CONTAINER" ]; then
    print_error "Frontend container not found"
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
      print_error "Frontend not responding (HTTP $HTTP_CODE)"
      print_warning "Check logs: docker logs $FRONTEND_CONTAINER"
    fi
    
    # Check if frontend can reach backend
    if [[ "$MODE" == "both" ]]; then
      print_action "Checking frontend-to-backend connectivity..."
      BACKEND_CHECK=$(docker exec $FRONTEND_CONTAINER wget -q -O- http://backend:8000/api/health 2>/dev/null || echo "failed")
      if echo "$BACKEND_CHECK" | grep -q "ok\|healthy\|status"; then
        print_status "Frontend can reach backend"
      else
        print_error "Frontend cannot reach backend"
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
print_header "Cleanup"
print_action "Removing old backup images (keeping last 3)..."
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  docker images | grep "product-editor-backend.*backup" | tail -n +4 | awk '{print $3}' | xargs -r docker rmi 2>/dev/null && print_status "Old backend backups removed" || print_info "No old backend backups to remove"
fi
if [[ "$MODE" == "frontend" || "$MODE" == "both" ]]; then
  docker images | grep "product-editor-frontend.*backup" | tail -n +4 | awk '{print $3}' | xargs -r docker rmi 2>/dev/null && print_status "Old frontend backups removed" || print_info "No old frontend backups to remove"
fi

# Final summary
print_header "Deployment Complete"
print_status "Deployment finished successfully"
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
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "127.0.0.1" ]; then
    BASE_URL="http://${SERVER_IP}:5004"
    BACKEND_URL="http://${SERVER_IP}:8000"
  else
    BASE_URL="http://localhost:5004"
    BACKEND_URL="http://localhost:8000"
  fi
fi

# Show access URLs
if [[ "$MODE" == "frontend" || "$MODE" == "both" ]]; then
  print_info "Frontend: ${GREEN}${BASE_URL}${NC}"
fi

if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  print_info "Backend API: ${GREEN}${BACKEND_URL}/api${NC}"
  print_info "Health Check: ${GREEN}${BACKEND_URL}/api/health${NC}"
  print_info "Admin Panel: ${GREEN}${BACKEND_URL}/admin/django-admin/${NC}"
fi

echo ""
print_status "Ready to use!"
echo ""
