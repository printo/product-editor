#!/usr/bin/env bash
set -e

# ============================================
# Product Editor - Database Reset Script
# ============================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

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

# Confirmation prompt
print_header "PostgreSQL Database Reset"
print_warning "This will delete ALL data in the database!"
echo ""
read -p "Are you sure you want to continue? (yes/no): " -r
echo ""

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
  print_info "Database reset cancelled"
  exit 0
fi

# Backup database
print_header "Backing Up Database"
print_action "Creating database backup..."
BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
docker-compose exec -T db pg_dump -U postgres product_editor > "$BACKUP_FILE" 2>/dev/null && {
  print_status "Database backed up to: $BACKUP_FILE"
} || {
  print_warning "Could not create backup (database may not exist yet)"
}

# Stop containers
print_header "Stopping Containers"
print_action "Stopping all services..."
docker-compose down 2>&1 | while read line; do
  if [[ "$line" =~ "Stopping" ]]; then
    echo -e "${CYAN}→${NC} $line"
  elif [[ "$line" =~ "Stopped" || "$line" =~ "Removed" ]]; then
    echo -e "${GREEN}✓${NC} $line"
  fi
done
print_status "All containers stopped"

# Remove volumes
print_header "Removing Database Volumes"
print_action "Removing PostgreSQL volume..."
docker volume rm product-editor_postgres_data 2>/dev/null && {
  print_status "PostgreSQL volume deleted"
} || {
  print_warning "Volume doesn't exist or already removed"
}

print_action "Checking for old volumes..."
docker volume rm product-editorold1775215119_postgres_data 2>/dev/null && {
  print_status "Old volume deleted"
} || {
  print_info "No old volume found"
}

# Start database
print_header "Creating Fresh Database"
print_action "Creating new PostgreSQL volume..."
docker volume create product-editor_postgres_data >/dev/null 2>&1
print_status "New volume created"

print_action "Starting PostgreSQL service..."
docker-compose up -d db 2>&1 | while read line; do
  if [[ "$line" =~ "Creating" || "$line" =~ "Starting" ]]; then
    echo -e "${CYAN}→${NC} $line"
  elif [[ "$line" =~ "Created" || "$line" =~ "Started" ]]; then
    echo -e "${GREEN}✓${NC} $line"
  fi
done
print_status "PostgreSQL started"

# Wait for database
print_header "Initializing Database"
print_action "Waiting for database to initialize..."
for i in {1..10}; do
  echo -e "${CYAN}→${NC} Checking database health... (attempt $i/10)"
  if docker-compose exec -T db pg_isready -U postgres >/dev/null 2>&1; then
    print_status "Database is ready"
    break
  fi
  sleep 2
done

# Verify connection
print_action "Verifying database connection..."
docker-compose exec -T db psql -U postgres -c "SELECT version();" >/dev/null 2>&1 && {
  print_status "Database connection verified"
} || {
  print_error "Database connection failed"
  exit 1
}

print_action "Creating product_editor database..."
docker-compose exec -T db psql -U postgres -c "CREATE DATABASE product_editor;" 2>/dev/null || print_info "Database already exists"
print_status "Database ready"

# Show database info
print_header "Database Information"
print_action "Checking database details..."
docker-compose exec -T db psql -U postgres -c "\l" | grep product_editor | while read line; do
  echo -e "${GREEN}✓${NC} $line"
done

# Final summary
print_header "Database Reset Complete"
print_status "Fresh PostgreSQL database is ready"
echo ""
print_info "Database: ${GREEN}product_editor${NC}"
print_info "User: ${GREEN}postgres${NC}"
print_info "Password: ${GREEN}postgres${NC}"
print_info "Backup saved: ${GREEN}$BACKUP_FILE${NC}"
echo ""
print_info "Next steps:"
echo "  1. Run: ${GREEN}docker-compose up -d${NC}"
echo "  2. Or run: ${GREEN}./deploy.sh${NC}"
echo ""
