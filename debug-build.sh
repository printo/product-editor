#!/bin/bash

##############################################################################
#                                                                            #
#     PRODUCT EDITOR - BUILD DEBUGGING SCRIPT                               #
#                                                                            #
#     This script builds Docker images with verbose output for debugging    #
#                                                                            #
#     Usage: bash debug-build.sh                                            #
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

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

log_header "PRODUCT EDITOR - BUILD DEBUGGING"

# Ensure .env exists
if [ ! -f .env ]; then
    log_info "Creating .env from template..."
    cp .env.example .env
    log_success ".env created"
fi

log_header "Building Frontend Image"
log_info "Building product-editor-frontend..."
docker build -f frontend/nextjs/Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api \
  --target builder \
  -t product-editor-frontend:debug \
  . 2>&1

if [ $? -eq 0 ]; then
    log_success "Frontend builder image built successfully"
else
    log_error "Frontend builder image build failed"
    exit 1
fi

log_header "Building Backend Image"
log_info "Building product-editor-backend..."
docker build -f backend/django/Dockerfile \
  -t product-editor-backend:debug \
  . 2>&1

if [ $? -eq 0 ]; then
    log_success "Backend image built successfully"
else
    log_error "Backend image build failed"
    exit 1
fi

log_success "All images built successfully!"
