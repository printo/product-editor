# Product Editor - Photo Layout Generator

A production-ready full-stack application for generating photo layouts and collages. Upload multiple images, select a layout template, and export as PNG files.

## Technology Stack

**Backend**
- Django 5.0.6 with Django REST Framework
- PostgreSQL 16
- Pillow for image processing
- Bearer token API authentication
- Gunicorn for production

**Frontend**
- Next.js 14.2.4
- React 18.2.0
- TypeScript 5.4.5
- Tailwind CSS 3.4.3

**Infrastructure**
- Docker & Docker Compose
- Traefik reverse proxy with SSL/TLS
- PostgreSQL database

## Features

- **API Key Authentication**: Secure Bearer token-based authentication
- **Layout Management**: List and retrieve layout specifications
- **Image Upload**: Multi-file upload with validation (size, type, dimensions)
- **Layout Generation**: Arrange images into predefined layouts
- **Export**: Generate and download PNG files
- **Audit Trail**: Complete request logging and tracking
- **Admin Dashboard**: Django admin for managing API keys and monitoring
- **Rate Limiting**: Configurable per API key
- **Security**: Path traversal protection, CORS restriction, security headers

## Quick Start

### Development Setup

1. **Clone and configure**
```bash
git clone <repository-url>
cd product-editor
cp .env.example .env
```

2. **Edit `.env` for development**
```env
DEBUG=1
POSTGRES_PASSWORD=devpassword
DJANGO_SECRET_KEY=dev-secret-key
```

3. **Start services**
```bash
docker-compose up -d
```

4. **Access application**
- Frontend: http://localhost:5004
- Backend API: http://localhost:8000/api
- Admin: http://localhost:8000/admin/django-admin/
- Database: localhost:5432

5. **Get API key**
```bash
docker-compose logs backend | grep "Development API key created"
```

### Production Deployment

1. **Server setup**
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo apt install docker-compose-plugin -y
```

2. **Configure production environment**
```bash
cp .env.example .env
nano .env
```

Set production values:
```env
DJANGO_SECRET_KEY=<generate-strong-random-key>
DEBUG=0
ALLOWED_HOSTS=yourdomain.com,www.yourdomain.com
POSTGRES_PASSWORD=<strong-random-password>
CORS_ALLOWED_ORIGINS=https://yourdomain.com
```

Generate secret key:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

3. **Configure Traefik**
Edit `docker-compose.yml`:
```yaml
- --certificatesresolvers.le.acme.email=your-email@example.com
```

4. **Prepare SSL**
```bash
touch proxy/traefik/acme.json
chmod 600 proxy/traefik/acme.json
```

5. **Deploy**
```bash
docker-compose up -d
```

6. **Create production API key**
```bash
docker-compose exec backend python manage.py create_api_key "Production App" \
  --can-generate-layouts \
  --can-list-layouts \
  --can-access-exports \
  --max-requests-per-day 10000
```

## API Documentation

### Authentication
All endpoints (except `/api/health`) require Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://yourdomain.com/api/layouts
```

### Endpoints

**Health Check**
```bash
GET /api/health
```

**List Layouts**
```bash
GET /api/layouts
Authorization: Bearer YOUR_API_KEY
```

**Get Layout Details**
```bash
GET /api/layouts/{name}
Authorization: Bearer YOUR_API_KEY
```

**Generate Layout**
```bash
POST /api/layout/generate
Authorization: Bearer YOUR_API_KEY
Content-Type: multipart/form-data

Form Data:
- layout: "4x6-20"
- images: [file1.jpg, file2.jpg, ...]
```

**Download Export**
```bash
GET /api/exports/{filename}
Authorization: Bearer YOUR_API_KEY
```

### Example: Generate Layout

```bash
curl -X POST https://yourdomain.com/api/layout/generate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "layout=4x6-20" \
  -F "images=@photo1.jpg" \
  -F "images=@photo2.jpg" \
  -F "images=@photo3.jpg"
```

Response:
```json
{
  "canvases": ["output_abc123.png"]
}
```

## API Key Management

### Create API Key
```bash
docker-compose exec backend python manage.py create_api_key "App Name" \
  --can-generate-layouts \
  --can-list-layouts \
  --can-access-exports \
  --max-requests-per-day 1000
```

### List API Keys
```bash
docker-compose exec backend python manage.py shell -c \
  "from api.models import APIKey; [print(f'{k.name}: {k.key}') for k in APIKey.objects.filter(is_active=True)]"
```

### Manage via Admin
Access `/admin/django-admin/` to:
- View all API keys
- Enable/disable keys
- Set permissions per key
- Monitor request logs
- Track uploads and exports

## Database Management

### Backup
```bash
docker-compose exec db pg_dump -U postgres product_editor > backup.sql
```

### Restore
```bash
cat backup.sql | docker-compose exec -T db psql -U postgres product_editor
```

### Access Database
```bash
docker-compose exec db psql -U postgres product_editor
```

### Automated Backups
Create `/opt/product-editor/backup.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/opt/product-editor/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR
docker-compose exec -T db pg_dump -U postgres product_editor > $BACKUP_DIR/backup_$DATE.sql
find $BACKUP_DIR -name "backup_*.sql" -mtime +7 -delete
```

Schedule with cron:
```bash
crontab -e
# Add: 0 2 * * * cd /opt/product-editor && ./backup.sh
```

## Monitoring

### View Logs
```bash
docker-compose logs -f
docker-compose logs -f backend
docker-compose logs --tail=100 backend
```

### Check Status
```bash
docker-compose ps
docker stats
```

### Database Monitoring
```bash
docker-compose exec db psql -U postgres product_editor

# Check table sizes
SELECT schemaname, tablename, 
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Maintenance

### Update Application
```bash
git pull
docker-compose build
docker-compose up -d
```

### Restart Services
```bash
docker-compose restart
docker-compose restart backend
```

### Clean Up
```bash
docker image prune -a
docker volume prune  # Careful!
```

### Database Maintenance
```bash
docker-compose exec db psql -U postgres product_editor -c "VACUUM ANALYZE;"
docker-compose exec db psql -U postgres product_editor -c "REINDEX DATABASE product_editor;"
```

## Troubleshooting

### Service Won't Start
```bash
docker-compose logs backend
sudo netstat -tulpn | grep :80
sudo systemctl restart docker
```

### Database Connection Issues
```bash
docker-compose ps db
docker-compose logs db
docker-compose exec backend python manage.py dbshell
```

### SSL Certificate Issues
```bash
docker-compose logs proxy
ls -la proxy/traefik/acme.json
chmod 600 proxy/traefik/acme.json
```

### Out of Disk Space
```bash
df -h
docker system prune -a --volumes
find /opt/product-editor/backups -mtime +30 -delete
```

### API Key Not Working
```bash
docker-compose exec backend python manage.py shell -c \
  "from api.models import APIKey; print(APIKey.objects.filter(is_active=True).values('name', 'key', 'is_active'))"
```

## Security

### Production Checklist
- [ ] Changed default admin credentials
- [ ] Strong `DJANGO_SECRET_KEY` set
- [ ] `DEBUG=0` in production
- [ ] `ALLOWED_HOSTS` configured
- [ ] Strong database password
- [ ] CORS origins restricted
- [ ] Firewall configured (ports 80, 443, 22)
- [ ] SSL/TLS enabled
- [ ] Regular backups scheduled
- [ ] API keys have appropriate permissions
- [ ] Rate limits configured

### Firewall Setup
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp
sudo ufw enable
```

### Security Features
- Bearer token API authentication
- Per-key permissions (generate, list, export)
- Rate limiting (configurable per key)
- Path traversal protection
- File upload validation (size, type, dimensions)
- Request audit trail
- CORS restriction
- Security headers (CSP, X-Frame-Options, HSTS)
- Timeout protection for image processing

## File Storage

- **Uploads**: `/storage/uploads/` - Uploaded images
- **Layouts**: `/storage/layouts/` - Layout JSON templates
- **Exports**: `/storage/exports/` - Generated PNG files

## Environment Variables

### Backend (Django)
- `DJANGO_SECRET_KEY` - Secret key (required in production)
- `DEBUG` - Debug mode (0=production, 1=development)
- `ALLOWED_HOSTS` - Comma-separated allowed hosts
- `POSTGRES_DB` - Database name
- `POSTGRES_USER` - Database user
- `POSTGRES_PASSWORD` - Database password
- `POSTGRES_HOST` - Database host (default: db)
- `POSTGRES_PORT` - Database port (default: 5432)
- `CORS_ALLOWED_ORIGINS` - Comma-separated CORS origins
- `DEV_ADMIN_USERNAME` - Admin username (development)
- `DEV_ADMIN_PASSWORD` - Admin password (development)

### Frontend (Next.js)
- `NEXT_PUBLIC_API_BASE_URL` - Backend API URL
- `NODE_ENV` - Node environment (development/production)

### Database (PostgreSQL)
- `POSTGRES_DB` - Database name
- `POSTGRES_USER` - Database user
- `POSTGRES_PASSWORD` - Database password

## Development

### Run Tests

**In Docker:**
```bash
docker-compose exec backend python manage.py test
```

**Locally (outside Docker):**
Ensure you have a local PostgreSQL instance running or override the database host:
```bash
# Using localhost (default)
source venv/bin/activate
cd backend/django
python manage.py test

# Overriding host if needed
POSTGRES_HOST=127.0.0.1 python manage.py test
```

### Create Migrations
```bash
docker-compose exec backend python manage.py makemigrations
docker-compose exec backend python manage.py migrate
```

### Django Shell
```bash
docker-compose exec backend python manage.py shell
```

### Frontend Development
```bash
cd frontend/nextjs
npm install
npm run dev
```

## Performance Optimization

### Increase Backend Workers
Edit `backend/django/Dockerfile`:
```dockerfile
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "5", "product_editor.wsgi:application"]
```

### Database Connection Pooling
Add to `settings.py`:
```python
DATABASES = {
    "default": {
        # ... existing config ...
        "CONN_MAX_AGE": 600,
        "OPTIONS": {"connect_timeout": 10}
    }
}
```

## Architecture

### Request Flow
1. User enters API key in frontend
2. Frontend fetches layouts with Bearer token
3. User selects layout and uploads images
4. Frontend validates files and sends to `/api/layout/generate`
5. Backend validates files, processes images with PIL
6. Backend generates PNG and stores in `/storage/exports`
7. Frontend displays preview and download links
8. All requests logged to database for audit trail

### Authentication
- Bearer token API key system only
- API keys stored in PostgreSQL
- Per-key permissions and rate limiting
- Automatic last-used timestamp tracking

### Database Schema
- `api_keys` - API key management
- `api_requests` - Request audit trail
- `uploaded_files` - File tracking
- `exported_results` - Export tracking

## License

Proprietary - All rights reserved

## Support

For issues:
1. Check logs: `docker-compose logs`
2. Verify environment: `docker-compose config`
3. Check database: `docker-compose exec db psql -U postgres product_editor`
4. Review this documentation
