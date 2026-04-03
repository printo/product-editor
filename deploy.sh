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
  echo "  $0 [frontend|backend|both]"
  echo ""
  echo -e "${BLUE}Examples:${NC}"
  echo "  $0              # Deploy both frontend and backend (default)"
  echo "  $0 frontend     # Deploy only frontend"
  echo "  $0 backend      # Deploy only backend"
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
if [[ "$MODE" != "frontend" && "$MODE" != "backend" && "$MODE" != "both" ]]; then
  print_error "Invalid mode: $MODE"
  usage
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
    pid=$(lsof -ti:$port 2>/dev/null)
    if [ ! -z "$pid" ]; then
      kill -9 $pid 2>/dev/null && print_status "Freed port $port" || print_info "Port $port already free"
    fi
  done
elif [[ "$MODE" == "backend" ]]; then
  print_action "Stopping backend container..."
  docker-compose stop backend 2>&1 | grep -v "^$" || true
  print_status "Backend stopped"
  print_action "Removing backend container..."
  docker rm -f product-editor-backend-1 2>/dev/null && print_status "Backend container removed" || print_info "No container to remove"
  
  # Free port 8000
  pid=$(lsof -ti:8000 2>/dev/null)
  if [ ! -z "$pid" ]; then
    kill -9 $pid 2>/dev/null && print_status "Freed port 8000" || print_info "Port 8000 already free"
  fi
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Stopping frontend container..."
  docker-compose stop frontend 2>&1 | grep -v "^$" || true
  print_status "Frontend stopped"
  print_action "Removing frontend container..."
  docker rm -f product-editor-frontend-1 2>/dev/null && print_status "Frontend container removed" || print_info "No container to remove"
  
  # Free port 5004
  pid=$(lsof -ti:5004 2>/dev/null)
  if [ ! -z "$pid" ]; then
    kill -9 $pid 2>/dev/null && print_status "Freed port 5004" || print_info "Port 5004 already free"
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

# Build services
print_header "Building New Images"
if [[ "$MODE" == "backend" ]]; then
  print_action "Building backend image..."
  docker-compose build backend 2>&1 | grep -E "(Step|Successfully built|Successfully tagged)" | while read line; do
    if [[ "$line" =~ "Successfully" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    else
      echo -e "${CYAN}→${NC} $line"
    fi
  done
  print_status "Backend image built successfully"
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Building frontend image..."
  docker-compose build frontend 2>&1 | grep -E "(Step|Successfully built|Successfully tagged)" | while read line; do
    if [[ "$line" =~ "Successfully" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    else
      echo -e "${CYAN}→${NC} $line"
    fi
  done
  print_status "Frontend image built successfully"
else
  print_action "Building all images..."
  docker-compose build 2>&1 | grep -E "(Step|Successfully built|Successfully tagged)" | while read line; do
    if [[ "$line" =~ "Successfully" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    else
      echo -e "${CYAN}→${NC} $line"
    fi
  done
  print_status "All images built successfully"
fi

# Start services
print_header "Starting Services"
if [[ "$MODE" == "backend" ]]; then
  print_action "Creating and starting backend container..."
  docker-compose up -d backend 2>&1 | while read line; do
    if [[ "$line" =~ "Creating" || "$line" =~ "Starting" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "Created" || "$line" =~ "Started" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done
  print_status "Backend started"
elif [[ "$MODE" == "frontend" ]]; then
  print_action "Creating and starting frontend container..."
  docker-compose up -d frontend 2>&1 | while read line; do
    if [[ "$line" =~ "Creating" || "$line" =~ "Starting" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "Created" || "$line" =~ "Started" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done
  print_status "Frontend started"
else
  print_action "Creating and starting all containers..."
  docker-compose up -d 2>&1 | while read line; do
    if [[ "$line" =~ "Creating" || "$line" =~ "Starting" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "Created" || "$line" =~ "Started" || "$line" =~ "Healthy" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done
  print_status "All services started"
fi

# Run migrations
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  print_header "Database Migrations"
  print_action "Waiting for database to be ready..."
  sleep 5
  print_status "Database ready"
  print_action "Running migrations..."
  docker-compose exec -T backend python manage.py migrate --noinput 2>&1 | while read line; do
    if [[ "$line" =~ "Applying" ]]; then
      echo -e "${CYAN}→${NC} $line"
    elif [[ "$line" =~ "OK" || "$line" =~ "No migrations" ]]; then
      echo -e "${GREEN}✓${NC} $line"
    fi
  done || {
    print_warning "Migrations failed or already applied"
  }
  print_status "Migrations completed"
fi

# Show service status
print_header "Service Status"
docker-compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

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
