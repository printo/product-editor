#!/bin/bash

##############################################################################
#                                                                            #
#     DOCKER BUILD DEBUGGING FOR UBUNTU                                      #
#                                                                            #
##############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_header() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC} $1"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_header "DOCKER BUILD DEBUGGING"

cd ~/product-editor

# Step 1: Clear Docker build cache
log_info "Clearing Docker build cache..."
docker builder prune -f
log_success "Cache cleared"

# Step 2: Remove old images
log_info "Removing old images..."
docker rmi -f product-editor-frontend:latest 2>/dev/null || true
docker rmi -f product-editor-backend:latest 2>/dev/null || true
log_success "Old images removed"

# Step 3: Build frontend with full output
log_header "Building Frontend (No Cache)"
docker build \
  -f frontend/nextjs/Dockerfile \
  --no-cache \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api \
  -t product-editor-frontend:latest \
  . 2>&1 | tee /tmp/frontend-build.log

if [ $? -eq 0 ]; then
    log_success "Frontend build successful!"
else
    log_info "Frontend build failed. Check /tmp/frontend-build.log"
    log_info "Showing last 50 lines of build output:"
    tail -50 /tmp/frontend-build.log
    exit 1
fi

# Step 4: Build backend
log_header "Building Backend (No Cache)"
docker build \
  -f backend/django/Dockerfile \
  --no-cache \
  -t product-editor-backend:latest \
  . 2>&1 | tee /tmp/backend-build.log

if [ $? -eq 0 ]; then
    log_success "Backend build successful!"
else
    log_info "Backend build failed. Check /tmp/backend-build.log"
    tail -50 /tmp/backend-build.log
    exit 1
fi

log_success "All builds completed successfully!"
