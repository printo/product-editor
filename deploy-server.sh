#!/bin/bash
set -e

# Product Editor Server Deployment Script
# For production server deployment with zero-downtime

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're running as root or with sudo
if [[ $EUID -eq 0 ]]; then
    log_warning "Running as root. Consider using a non-root user with docker permissions."
fi

# Check if docker and docker-compose are available
if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed or not in PATH"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    log_error "Docker Compose is not installed or not in PATH"
    exit 1
fi

log_info "🚀 Starting Product Editor server deployment..."

# Check if we're in the right directory
if [[ ! -f "docker-compose.yml" ]]; then
    log_error "docker-compose.yml not found. Are you in the project root?"
    exit 1
fi

# Check if .env file exists
if [[ ! -f ".env" ]]; then
    log_error ".env file not found. Please create it from .env.example"
    log_info "Run: cp .env.example .env && nano .env"
    exit 1
fi

# Backup current .env
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
log_info "Backed up current .env file"

# Update code from git
log_info "📥 Updating code from git repository..."
if git pull origin main; then
    log_success "Code updated successfully"
else
    log_warning "Git pull failed or no changes. Continuing with deployment..."
fi

# Create backup of current containers
log_info "📦 Creating backup of current deployment..."
docker-compose ps > deployment_backup_$(date +%Y%m%d_%H%M%S).txt

# Stop services gracefully
log_info "⏹️  Stopping current services..."
docker-compose down --timeout 30

# Clean up old images and containers
log_info "🧹 Cleaning up old Docker resources..."
docker container prune -f
docker image prune -f
docker volume prune -f
docker network prune -f

# Remove old product-editor images specifically
log_info "🗑️  Removing old product-editor images..."
docker images | grep "product-editor" | awk '{print $3}' | xargs -r docker rmi -f || true

# Build new images
log_info "🔨 Building new images..."
docker-compose build --no-cache --parallel

# Start database first and wait for it to be ready
log_info "🗄️  Starting database..."
docker-compose up -d db

# Wait for database to be ready
log_info "⏳ Waiting for database to be ready..."
timeout=60
counter=0
while ! docker-compose exec -T db pg_isready -U postgres > /dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        log_error "Database failed to start within $timeout seconds"
        exit 1
    fi
    sleep 2
    counter=$((counter + 2))
    echo -n "."
done
echo ""
log_success "Database is ready"

# Start backend and run migrations
log_info "🔧 Starting backend and running migrations..."
docker-compose up -d backend

# Wait for backend to be ready
log_info "⏳ Waiting for backend to be ready..."
timeout=120
counter=0
while ! docker-compose exec -T backend python manage.py check > /dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        log_error "Backend failed to start within $timeout seconds"
        docker-compose logs backend
        exit 1
    fi
    sleep 3
    counter=$((counter + 3))
    echo -n "."
done
echo ""
log_success "Backend is ready"

# Run database migrations
log_info "🔄 Running database migrations..."
if docker-compose exec -T backend python manage.py migrate --noinput; then
    log_success "Database migrations completed"
else
    log_error "Database migrations failed"
    docker-compose logs backend
    exit 1
fi

# Collect static files
log_info "📁 Collecting static files..."
docker-compose exec -T backend python manage.py collectstatic --noinput || log_warning "Static files collection failed (might be normal)"

# Start frontend
log_info "🎨 Starting frontend..."
docker-compose up -d frontend

# Start proxy (Traefik)
log_info "🔀 Starting proxy..."
docker-compose up -d proxy

# Wait for all services to be ready
log_info "⏳ Waiting for all services to be ready..."
sleep 15

# Verify deployment
log_info "✅ Verifying deployment..."

# Check service status
services_status=$(docker-compose ps --services --filter "status=running")
expected_services=("db" "backend" "frontend" "proxy")

for service in "${expected_services[@]}"; do
    if echo "$services_status" | grep -q "$service"; then
        log_success "$service is running"
    else
        log_error "$service is not running"
        docker-compose logs "$service"
        exit 1
    fi
done

# Test backend health
log_info "🏥 Testing backend health..."
if curl -f -s http://localhost:8000/api/health > /dev/null; then
    log_success "Backend health check passed"
else
    log_warning "Backend health check failed (might be normal if using Traefik only)"
fi

# Show service status
log_info "📊 Service status:"
docker-compose ps

# Show resource usage
log_info "💾 Resource usage:"
docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"

# Get API keys
log_info "🔑 Available API keys:"
docker-compose exec -T backend python manage.py shell -c "
from api.models import APIKey
keys = APIKey.objects.filter(is_active=True)
if keys.exists():
    for key in keys:
        print(f'  {key.name}: {key.key}')
else:
    print('  No API keys found. Create one with: docker-compose exec backend python manage.py create_api_key \"App Name\"')
" || log_warning "Could not retrieve API keys"

# Show recent logs
log_info "📋 Recent logs:"
docker-compose logs --tail=10 backend frontend

# Final success message
echo ""
log_success "🎉 Server deployment completed successfully!"
echo ""
log_info "🌐 Access URLs:"
echo "  Production: https://yourdomain.com"
echo "  Admin: https://yourdomain.com/admin/django-admin/"
echo "  API: https://yourdomain.com/api"
echo ""
log_info "📝 Next steps:"
echo "  1. Update your DNS to point to this server"
echo "  2. Test the application with your API key"
echo "  3. Monitor logs: docker-compose logs -f"
echo "  4. Set up automated backups"
echo ""
log_info "🔧 Management commands:"
echo "  View logs: docker-compose logs -f"
echo "  Restart: docker-compose restart"
echo "  Stop: docker-compose down"
echo "  Update: ./deploy-server.sh"
echo ""