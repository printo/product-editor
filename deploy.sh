#!/usr/bin/env bash
set -e

# Product Editor Deployment Script
# Usage:
#   ./deploy.sh frontend    # deploy only frontend
#   ./deploy.sh backend     # deploy only backend
#   ./deploy.sh             # deploy both (default)

MODE="${1:-both}"
if [[ "$MODE" != "frontend" && "$MODE" != "backend" && "$MODE" != "both" ]]; then
  echo "Invalid mode: $MODE"
  echo "Usage: $0 [frontend|backend|both]"
  exit 1
fi

echo "Starting deployment (mode: $MODE)"

# Stop target services only
if [[ "$MODE" == "both" ]]; then
  docker-compose down --remove-orphans || docker compose down --remove-orphans || true
elif [[ "$MODE" == "backend" ]]; then
  (docker-compose stop backend || docker compose stop backend) || true
  docker rm -f product-editor-backend-1 2>/dev/null || true
elif [[ "$MODE" == "frontend" ]]; then
  (docker-compose stop frontend || docker compose stop frontend) || true
  docker rm -f product-editor-frontend-1 2>/dev/null || true
fi

# Build and start
if [[ "$MODE" == "backend" ]]; then
  docker-compose build backend || docker compose build backend
  docker-compose up -d backend || docker compose up -d backend
elif [[ "$MODE" == "frontend" ]]; then
  docker-compose build frontend || docker compose build frontend
  docker-compose up -d frontend || docker compose up -d frontend
else
  docker-compose build --no-cache || docker compose build --no-cache
  docker-compose up -d || docker compose up -d
fi

# Run migrations when backend is involved
if [[ "$MODE" == "backend" || "$MODE" == "both" ]]; then
  echo "Applying migrations..."
  docker-compose exec -T backend python manage.py migrate --noinput || docker compose exec -T backend python manage.py migrate --noinput || true
fi

echo "Deployment completed (mode: $MODE)"
