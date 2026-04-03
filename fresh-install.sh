#!/bin/bash

##############################################################################
#                                                                            #
#     PRODUCT EDITOR - AUTOMATED FRESH INSTALL FOR UBUNTU                   #
#                                                                            #
#     Usage: bash fresh-install.sh                                          #
#                                                                            #
#     This script will:                                                      #
#     1. Clean up old Docker containers and images                          #
#     2. Remove old product-editor files                                    #
#     3. Install Docker & Docker Compose (if needed)                        #
#     4. Clone fresh repository                                             #
#     5. Setup environment file (.env)                                      #
#     6. Deploy application (both frontend & backend)                       #
#                                                                            #
##############################################################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
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

log_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Start
clear
log_header "PRODUCT EDITOR - FRESH INSTALLATION"
echo -e "${YELLOW}This script will perform a CLEAN installation of Product Editor${NC}"
echo ""
echo "Steps:"
echo "  1. Backup important data from old installation"
echo "  2. Stop and remove old Docker containers"
echo "  3. Remove old files"
echo "  4. Install Docker & Docker Compose"
echo "  5. Clone fresh repository"
echo "  6. Setup environment"
echo "  7. Deploy application"
echo ""
read -p "Continue? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    log_error "Installation cancelled"
    exit 1
fi

##############################################################################
# STEP 1: BACKUP OLD DATA
##############################################################################

log_header "STEP 1: BACKUP IMPORTANT DATA"

if [ -d ~/product-editor ]; then
    log_warning "Old product-editor directory found"
    
    mkdir -p ~/product-editor-backups
    
    if [ -f ~/product-editor/.env ]; then
        log_info "Backing up .env file..."
        cp ~/product-editor/.env ~/product-editor-backups/.env.backup.$(date +%Y%m%d_%H%M%S)
        log_success ".env backed up"
    fi
    
    if [ -d ~/product-editor/storage/uploads ]; then
        log_info "Backing up uploads folder..."
        tar -czf ~/product-editor-backups/uploads_backup_$(date +%Y%m%d_%H%M%S).tar.gz \
            ~/product-editor/storage/uploads/ 2>/dev/null || true
        log_success "Uploads backed up"
    fi
    
    if [ -d ~/product-editor/storage/exports ]; then
        log_info "Backing up exports folder..."
        tar -czf ~/product-editor-backups/exports_backup_$(date +%Y%m%d_%H%M%S).tar.gz \
            ~/product-editor/storage/exports/ 2>/dev/null || true
        log_success "Exports backed up"
    fi
    
    log_success "Backups saved to ~/product-editor-backups/"
fi

##############################################################################
# STEP 2: STOP OLD CONTAINERS
##############################################################################

log_header "STEP 2: CLEANUP OLD DOCKER CONTAINERS"

if command -v docker &> /dev/null; then
    log_info "Stopping Docker containers..."
    cd ~/product-editor 2>/dev/null && docker compose down 2>/dev/null || true
    cd ~ || true
    log_success "Containers stopped"
    
    log_info "Removing old product-editor images..."
    docker images | grep product-editor | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
    log_success "Old images removed"
    
    log_info "Removing stopped containers..."
    docker container prune -f &>/dev/null || true
    log_success "Stopped containers cleaned"
else
    log_warning "Docker not installed yet (will install in next step)"
fi

##############################################################################
# STEP 3: REMOVE OLD FILES
##############################################################################

log_header "STEP 3: REMOVE OLD FILES"

if [ -d ~/product-editor ]; then
    log_info "Archiving old product-editor directory..."
    mv ~/product-editor ~/product-editor.old.$(date +%s)
    log_success "Old installation archived"
fi

##############################################################################
# STEP 4: INSTALL DOCKER & DOCKER COMPOSE
##############################################################################

log_header "STEP 4: INSTALL DOCKER & DOCKER COMPOSE"

# Check Docker
if command -v docker &> /dev/null; then
    log_success "Docker already installed: $(docker --version)"
else
    log_info "Installing Docker..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo bash /tmp/get-docker.sh > /dev/null 2>&1
    log_success "Docker installed"
fi

# Check Docker Compose (modern integrated version)
if docker compose version &> /dev/null; then
    log_success "Docker Compose (integrated) already installed"
else
    log_info "Installing Docker Compose v2 (integrated)..."
    
    # Install via apt-get (installs docker-compose-plugin which provides 'docker compose')
    log_info "Installing docker-compose-plugin via apt-get..."
    sudo apt-get update > /dev/null 2>&1 || true
    
    if sudo apt-get install -y docker-compose-plugin > /dev/null 2>&1; then
        log_success "Docker Compose installed successfully"
    else
        log_error "Failed to install Docker Compose"
        log_error "Please install manually: sudo apt-get install -y docker-compose-plugin"
        exit 1
    fi
fi

# Verify docker compose command works
if docker compose version > /dev/null 2>&1; then
    log_success "Docker Compose verified: $(docker compose version | head -1)"
else
    log_error "docker compose command not working after installation"
    exit 1
fi

# Add user to docker group
log_info "Adding current user to docker group..."
sudo usermod -aG docker $USER 2>/dev/null || true

# Verify Docker
log_info "Verifying Docker installation..."
docker --version
docker compose version

##############################################################################
# STEP 5: CLONE REPOSITORY
##############################################################################

log_header "STEP 5: CLONE FRESH REPOSITORY"

log_info "Cloning Product Editor repository..."
cd ~
git clone git@github.com:printo/product-editor.git

cd product-editor
log_success "Repository cloned"

log_info "Current branch: $(git branch --show-current)"
log_info "Latest commit:"
git log -1 --oneline

log_info "Checking files..."
for file in docker-compose.yml deploy-server.sh deploy.sh start-dev.sh; do
    if [ -f $file ]; then
        log_success "$file found"
        chmod +x $file 2>/dev/null || true
    else
        log_error "$file NOT FOUND"
        exit 1
    fi
done

##############################################################################
# STEP 6: SETUP ENVIRONMENT
##############################################################################

log_header "STEP 6: SETUP ENVIRONMENT FILE"

if [ ! -f .env ]; then
    log_info "Creating .env file from template..."
    cp .env.example .env
    log_success ".env file created"
    
    log_warning "IMPORTANT: Please edit .env with your settings before deployment!"
    echo ""
    echo "Required settings to update:"
    echo "  - DATABASE_PASSWORD (PostgreSQL password)"
    echo "  - DJANGO_SECRET_KEY (Django secret key)"
    echo "  - ALLOWED_HOSTS (your domain name)"
    echo "  - DEBUG=False (for production)"
    echo ""
    echo "Edit with: nano .env"
    echo ""
    read -p "Press Enter after editing .env: "
else
    log_warning ".env already exists"
fi

##############################################################################
# STEP 7: PRE-DEPLOYMENT VERIFICATION
##############################################################################

log_header "STEP 7: VERIFICATION"

log_info "Checking docker-compose.yml..."
docker compose config > /dev/null 2>&1 && log_success "docker-compose.yml is valid" || {
    log_error "docker-compose.yml has errors"
    exit 1
}

log_info "Checking .env file..."
if [ -f .env ]; then
    log_success ".env file exists"
    # Check required variables
    required_vars=("DATABASE_PASSWORD" "DJANGO_SECRET_KEY" "ALLOWED_HOSTS")
    
    for var in "${required_vars[@]}"; do
        if grep -q "^$var=" .env; then
            log_success "$var is configured"
        else
            log_warning "$var may not be configured (check manually)"
        fi
    done
else
    log_error ".env file not found"
    exit 1
fi

##############################################################################
# STEP 8: DEPLOYMENT
##############################################################################

log_header "STEP 8: SYSTEM READY FOR DEPLOYMENT"

echo ""
echo "Your system is ready for deployment!"
echo ""
echo -e "${BLUE}Choose deployment option:${NC}"
echo ""
echo "  Option 1 (RECOMMENDED - Full Production Deploy):"
echo "    ${CYAN}./deploy-server.sh${NC}"
echo ""
echo "  Option 2 (Quick Deploy - Both Services):"
echo "    ${CYAN}./deploy.sh${NC}"
echo ""
echo "  Option 3 (Manual Docker Commands):"
echo "    ${CYAN}docker compose build${NC}"
echo "    ${CYAN}docker compose up -d${NC}"
echo ""
echo -e "${BLUE}Troubleshooting:${NC}"
echo "  View logs:      ${CYAN}docker compose logs -f${NC}"
echo "  View services:  ${CYAN}docker compose ps${NC}"
echo "  Stop services:  ${CYAN}docker compose down${NC}"
echo ""

read -p "Run deployment now? (yes/no): " -r
if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    read -p "Which option? (1/2/3) [default=1]: " option
    option=${option:-1}
    
    case $option in
        1)
            log_info "Starting full production deployment..."
            chmod +x deploy-server.sh
            ./deploy-server.sh
            ;;
        2)
            log_info "Starting quick deployment..."
            chmod +x deploy.sh
            ./deploy.sh
            ;;
        3)
            log_info "Starting manual deployment..."
            docker compose build
            docker compose up -d
            docker compose ps
            ;;
        *)
            log_warning "Invalid option"
            ;;
    esac
else
    log_info "Skipping deployment"
    echo ""
    echo "To deploy later, run:"
    echo "  cd ~/product-editor"
    echo "  ./deploy-server.sh"
fi

##############################################################################
# COMPLETION
##############################################################################

log_header "INSTALLATION COMPLETE!"

echo -e "${GREEN}✓ Fresh installation successful!${NC}"
echo ""
echo "Your application will be available at:"
echo "  - Frontend:  http://your-server-ip:5004"
echo "  - Backend:   http://your-server-ip:8000"
echo "  - Admin:     http://your-server-ip:8000/admin/django-admin/"
echo "  - API:       http://your-server-ip:8000/api"
echo ""
echo "Useful commands:"
echo "  ${CYAN}docker compose ps${NC}              - View running services"
echo "  ${CYAN}docker compose logs -f${NC}         - View live logs"
echo "  ${CYAN}docker compose restart${NC}         - Restart all services"
echo "  ${CYAN}docker compose down${NC}            - Stop all services"
echo ""
log_success "Setup complete. You're ready to go!"
echo ""

