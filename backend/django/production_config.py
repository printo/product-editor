"""
Production Configuration
Optimized settings for Linux server deployment.

⚠️ DEAD CODE WARNING ⚠️
Nothing in the project imports this module.  The active production
configuration lives in `product_editor/settings.py` (driven by env vars).
Before re-wiring any helper here, audit it for drift:
  - get_production_middleware() is missing
    `product_editor.middleware.ProxyAuthenticationMiddleware` which is in
    settings.py MIDDLEWARE — admin proxy enforcement would be lost.
  - get_production_security()['MAX_UPLOAD_FILE_SIZE'] (100 MB) conflicts
    with settings.py (10 MB) and api/validators.py MAX_FILE_SIZE_MB (50 MB).
  - X_FRAME_OPTIONS = 'DENY' here vs 'SAMEORIGIN' in settings.py — the
    embed-iframe flow needs SAMEORIGIN, so 'DENY' would break embedding.
Either delete this file or wire it in and reconcile the drift.
"""
import os
from pathlib import Path

def get_production_middleware():
    """Get production-optimized middleware configuration"""
    return [
        'django.middleware.security.SecurityMiddleware',
        'django.contrib.sessions.middleware.SessionMiddleware',
        'corsheaders.middleware.CorsMiddleware',
        'django.middleware.common.CommonMiddleware',
        'django.middleware.csrf.CsrfViewMiddleware',
        'django.contrib.auth.middleware.AuthenticationMiddleware',
        'django.contrib.messages.middleware.MessageMiddleware',
        'django.middleware.clickjacking.XFrameOptionsMiddleware',
        'api.middleware.APIRequestLoggingMiddleware',       # Request logging
        'api.middleware.RateLimitMiddleware',               # Rate limiting
    ]

def get_production_logging():
    """Get production-optimized logging configuration"""
    return {
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {
            'verbose': {
                'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
                'style': '{',
            },
            'simple': {
                'format': '{levelname} {message}',
                'style': '{',
            },
        },
        'handlers': {
            'file': {
                'level': 'INFO',
                'class': 'logging.FileHandler',
                'filename': '/var/log/product-editor/django.log',
                'formatter': 'verbose',
            },
            'console': {
                'level': 'INFO',
                'class': 'logging.StreamHandler',
                'formatter': 'simple',
            },
        },
        'root': {
            'handlers': ['file', 'console'],
            'level': 'INFO',
        },
        'loggers': {
            'django': {
                'handlers': ['file'],
                'level': 'INFO',
                'propagate': False,
            },
            'api': {
                'handlers': ['file'],
                'level': 'INFO',
                'propagate': False,
            },
        },
    }

def get_production_cache():
    """Get production-optimized cache configuration"""
    return {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': 'redis://127.0.0.1:6379/1',
            'OPTIONS': {
                'CLIENT_CLASS': 'django_redis.client.DefaultClient',
            },
            'TIMEOUT': 3600,  # 1 hour default
            'KEY_PREFIX': 'product_editor',
        }
    }

def get_production_security():
    """Get production security settings"""
    return {
        # HTTPS settings
        'SECURE_SSL_REDIRECT': True,
        'SESSION_COOKIE_SECURE': True,
        'CSRF_COOKIE_SECURE': True,
        'SECURE_HSTS_SECONDS': 31536000,
        'SECURE_HSTS_INCLUDE_SUBDOMAINS': True,
        'SECURE_HSTS_PRELOAD': True,
        
        # Security headers
        'SECURE_BROWSER_XSS_FILTER': True,
        'SECURE_CONTENT_TYPE_NOSNIFF': True,
        'X_FRAME_OPTIONS': 'DENY',
        
        # File upload security
        'FILE_UPLOAD_MAX_MEMORY_SIZE': 100 * 1024 * 1024,  # 100MB
        'DATA_UPLOAD_MAX_MEMORY_SIZE': 100 * 1024 * 1024,  # 100MB
        'MAX_UPLOAD_FILE_SIZE': 100 * 1024 * 1024,         # 100MB
    }
