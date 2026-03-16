# Advanced Image Processing - Production Deployment Guide

## 🚀 Production Deployment Steps

### 1. Server Requirements
- **OS**: Ubuntu 20.04+ or similar Linux distribution
- **CPU**: 2+ cores (4+ recommended)
- **RAM**: 4GB minimum (8GB+ recommended)
- **Storage**: 50GB+ available space
- **Python**: 3.8+

### 2. Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Python and pip
sudo apt install python3 python3-pip python3-venv -y

# Install system dependencies for AI processing
sudo apt install python3-dev build-essential -y

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt

# Install additional AI dependencies
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install transformers ultralytics rembg pillow opencv-python psutil
```

### 3. Configure Environment

```bash
# Copy environment file
cp .env.example .env

# Edit environment variables
nano .env
```

**Key Environment Variables:**
```bash
# Django settings
DEBUG=False
DJANGO_SECRET_KEY=your-secret-key-here
ALLOWED_HOSTS=your-domain.com,your-ip-address

# Database (if using PostgreSQL)
POSTGRES_DB=product_editor
POSTGRES_USER=your-db-user
POSTGRES_PASSWORD=your-db-password
POSTGRES_HOST=localhost
POSTGRES_PORT=5432

# AI Processing (auto-configured, but can override)
AI_PROCESSING_ENABLED=true
AI_FORCE_CPU_ONLY=false  # Will auto-detect
AI_CACHE_TTL=3600
AI_PROCESSING_TIMEOUT=60
AI_BACKGROUND_PROCESSING=true

# File storage
STORAGE_ROOT=/var/www/product-editor/storage
```

### 4. Database Setup

```bash
# Run migrations
python manage.py migrate

# Create superuser (optional)
python manage.py createsuperuser

# Create API key for testing
python manage.py create_api_key --name "production-key"
```

### 5. Verify System Configuration

```bash
# Check system auto-detection
python manage.py show_system_config

# Verify deployment readiness
python verify_deployment.py

# Test AI services (if dependencies installed)
python -c "
from ai_engine.system_info import get_system_info
import json
print('System Configuration:')
print(json.dumps(get_system_info(), indent=2))
"
```

### 6. Configure Web Server (Nginx + Gunicorn)

**Install Nginx and Gunicorn:**
```bash
sudo apt install nginx -y
pip install gunicorn
```

**Create Gunicorn service file:**
```bash
sudo nano /etc/systemd/system/product-editor.service
```

```ini
[Unit]
Description=Product Editor Django App
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/product-editor/backend/django
Environment="PATH=/var/www/product-editor/venv/bin"
ExecStart=/var/www/product-editor/venv/bin/gunicorn --workers 3 --bind unix:/var/www/product-editor/product-editor.sock product_editor.wsgi:application
Restart=always

[Install]
WantedBy=multi-user.target
```

**Configure Nginx:**
```bash
sudo nano /etc/nginx/sites-available/product-editor
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location = /favicon.ico { access_log off; log_not_found off; }
    
    location /static/ {
        root /var/www/product-editor/backend/django;
    }
    
    location /media/ {
        root /var/www/product-editor/storage;
    }

    location / {
        include proxy_params;
        proxy_pass http://unix:/var/www/product-editor/product-editor.sock;
        
        # Increase timeouts for AI processing
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Increase max body size for image uploads
        client_max_body_size 100M;
    }
}
```

**Enable and start services:**
```bash
sudo ln -s /etc/nginx/sites-available/product-editor /etc/nginx/sites-enabled
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

sudo systemctl daemon-reload
sudo systemctl start product-editor
sudo systemctl enable product-editor
```

### 7. Set Up File Permissions

```bash
# Create storage directories
sudo mkdir -p /var/www/product-editor/storage/{uploads,layouts,exports}

# Set proper permissions
sudo chown -R www-data:www-data /var/www/product-editor/storage
sudo chmod -R 755 /var/www/product-editor/storage

# Set Django static files permissions
sudo chown -R www-data:www-data /var/www/product-editor/backend/django/staticfiles
```

### 8. Configure SSL (Optional but Recommended)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo systemctl enable certbot.timer
```

## 🔧 System Auto-Configuration

The system automatically detects and configures based on server resources:

### Typical Configurations

**Small Server (2 vCPU, 4GB RAM):**
- Max concurrent requests: 1
- Max requests per user: 1
- Memory threshold: 75%
- CPU threshold: 80%

**Medium Server (4 vCPU, 8GB RAM):**
- Max concurrent requests: 2
- Max requests per user: 2
- Memory threshold: 80%
- CPU threshold: 85%

**Large Server (8+ vCPU, 16+ GB RAM):**
- Max concurrent requests: 4+
- Max requests per user: 2
- Memory threshold: 85%
- CPU threshold: 90%

### Image Processing Limits
- **Max image size**: 100MB (as requested)
- **Target image size**: None (no automatic resizing unless exceeding max)
- **Supported formats**: JPEG, PNG, WebP, TIFF
- **Processing timeout**: 60 seconds (configurable)

## 📊 Monitoring and Maintenance

### Health Checks

```bash
# Check system status
curl http://your-domain.com/api/ai/status/

# Monitor resource usage
python manage.py ai_resource_monitor --stats

# Check service logs
sudo journalctl -u product-editor -f
sudo tail -f /var/log/nginx/access.log
```

### Performance Monitoring

```bash
# Generate performance report
python manage.py optimize_ai_performance --report

# Monitor resource usage continuously
python manage.py ai_resource_monitor --daemon --interval=60 &
```

### Maintenance Tasks

```bash
# Daily cleanup (add to cron)
python manage.py ai_resource_monitor --cleanup

# Weekly optimization
python manage.py optimize_ai_performance --optimize

# Check system configuration
python manage.py show_system_config
```

## 🔒 Security Considerations

### API Security
- All AI endpoints require API key authentication
- File upload validation and size limits (100MB)
- Path traversal protection
- Input sanitization for processing parameters

### System Security
- Run services as non-root user (www-data)
- Configure firewall (UFW)
- Regular security updates
- SSL/TLS encryption
- Rate limiting on API endpoints

### File Security
- Validate uploaded file types
- Scan for malicious content
- Isolate processing environment
- Regular cleanup of temporary files

## 🚨 Troubleshooting

### Common Issues

**1. AI Processing Fails**
```bash
# Check dependencies
pip list | grep -E "(torch|transformers|ultralytics|rembg)"

# Check system resources
python manage.py show_system_config

# Check logs
sudo journalctl -u product-editor | grep -i error
```

**2. High Memory Usage**
```bash
# Check current usage
python -c "
from ai_engine.resource_manager import get_resource_manager
metrics = get_resource_manager().get_resource_metrics()
print(f'Memory: {metrics.memory_percent:.1f}%')
print(f'Active requests: {metrics.active_requests}')
"

# Restart service if needed
sudo systemctl restart product-editor
```

**3. Slow Processing**
```bash
# Check system load
htop

# Optimize performance
python manage.py optimize_ai_performance --optimize

# Check cache hit rate
python -c "
from ai_engine.resource_manager import get_resource_manager
stats = get_resource_manager().get_comprehensive_stats()
print(f'Cache hit rate: {stats[\"result_cache\"][\"hit_rate\"]:.1%}')
"
```

## ✅ Deployment Checklist

- [ ] Server meets minimum requirements
- [ ] Dependencies installed correctly
- [ ] Environment variables configured
- [ ] Database migrations completed
- [ ] System configuration verified
- [ ] Web server configured and running
- [ ] SSL certificate installed (if applicable)
- [ ] File permissions set correctly
- [ ] Health checks passing
- [ ] Monitoring configured
- [ ] Backup procedures in place

## 🎯 Expected Performance

### Processing Times (CPU-only)
- **Background removal**: 30-90 seconds for large images
- **Product detection**: 5-20 seconds for standard images
- **Design placement**: 2-10 seconds for perspective correction
- **Complete pipeline**: 1-3 minutes for full processing

### Resource Usage
- **Memory**: Optimized for available RAM with automatic thresholds
- **CPU**: Conservative limits to prevent system overload
- **Disk**: Automatic cleanup of temporary files
- **Cache**: 50%+ hit rate reduces processing load

The system is designed to automatically adapt to your server's capabilities while maintaining stability and performance.