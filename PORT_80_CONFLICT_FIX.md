# Port 80 Conflict - Quick Fix Guide

## Problem
Port 80 is already in use on your server, preventing Traefik from starting.

## Find What's Using Port 80

Run this on your server:
```bash
sudo lsof -i :80
# OR
sudo netstat -tulpn | grep :80
```

Common culprits: Nginx, Apache, or another web server.

---

## Solution 1: Run Without Traefik (Quickest)

If you don't need SSL/reverse proxy right now:

### Step 1: Update .env
```bash
nano .env
```

Change this line:
```bash
COMPOSE_PROFILES=prod
```

To:
```bash
COMPOSE_PROFILES=
```

### Step 2: Restart services
```bash
docker compose down
docker compose up -d
```

### Step 3: Access your app
- Frontend: http://your-server-ip:5004
- Backend: http://your-server-ip:8000/api

---

## Solution 2: Stop Existing Web Server (For Production with SSL)

If you want Traefik to handle SSL certificates:

### If it's Nginx:
```bash
sudo systemctl stop nginx
sudo systemctl disable nginx  # Prevent auto-start on reboot
```

### If it's Apache:
```bash
sudo systemctl stop apache2
sudo systemctl disable apache2
```

### Then start your services:
```bash
docker compose down
docker compose up -d
```

---

## Solution 3: Change Traefik Ports (Alternative)

If you want to keep the existing web server AND use Traefik:

### Step 1: Edit docker-compose.yml

Find the proxy service and change ports:
```yaml
proxy:
  image: traefik:v3.0
  ports:
    - "8080:80"      # Changed from 80:80
    - "8443:443"     # Changed from 443:443
```

### Step 2: Update Traefik commands
```yaml
  command:
    - --entrypoints.web.address=:80
    - --entrypoints.websecure.address=:443
```

### Step 3: Restart
```bash
docker compose down
docker compose up -d
```

### Step 4: Configure existing web server as reverse proxy

Add to your Nginx config:
```nginx
server {
    listen 80;
    server_name product-editor.printo.in;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Solution 4: Direct Access (No Proxy at All)

Simplest for testing:

### Step 1: Disable Traefik
```bash
# In .env
COMPOSE_PROFILES=
```

### Step 2: Expose services directly
Services are already exposed:
- Frontend: Port 5004
- Backend: Port 8000
- Database: Port 5432 (localhost only)

### Step 3: Configure your existing web server

Nginx config:
```nginx
server {
    listen 80;
    server_name product-editor.printo.in;
    
    location / {
        proxy_pass http://localhost:5004;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    location /api {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Recommended Approach

For **immediate testing**: Use Solution 1 (disable Traefik)
For **production**: Use Solution 2 (stop existing web server, let Traefik handle everything)

---

## Verify Services Are Running

```bash
# Check all containers
docker compose ps

# Check logs
docker compose logs -f

# Test backend
curl http://localhost:8000/api/health

# Test frontend
curl http://localhost:5004
```

---

## Quick Commands Reference

```bash
# Stop everything
docker compose down

# Start without Traefik
COMPOSE_PROFILES= docker compose up -d

# Start with Traefik
COMPOSE_PROFILES=prod docker compose up -d

# View logs
docker compose logs -f backend
docker compose logs -f frontend

# Restart a service
docker compose restart backend
```
