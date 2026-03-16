"""
Production Configuration for AI Image Processing
Optimized settings for Linux server deployment
"""
import os
from pathlib import Path

# Production-optimized settings
PRODUCTION_AI_CONFIG = {
    # Processing limits (will be auto-detected but these are fallbacks)
    'MAX_CONCURRENT_REQUESTS': 2,  # Conservative for most servers
    'MAX_REQUESTS_PER_USER': 1,    # Prevent user overload
    'MAX_IMAGE_SIZE_MB': 100,      # As requested - 100MB limit
    'TARGET_IMAGE_SIZE_MB': None,  # As requested - no target size
    
    # Timeouts and processing
    'PROCESSING_TIMEOUT': 60,      # 1 minute timeout
    'CACHE_TTL': 3600,            # 1 hour cache
    'BACKGROUND_PROCESSING': True, # Enable background jobs
    
    # Resource thresholds (conservative for production)
    'MEMORY_THRESHOLD': 75,        # 75% memory threshold
    'CPU_THRESHOLD': 80,           # 80% CPU threshold
    
    # File handling
    'SUPPORTED_FORMATS': ['JPEG', 'PNG', 'WEBP', 'TIFF'],
    'TEMP_FILE_CLEANUP': True,
    'AUTO_OPTIMIZATION': True,
    
    # Security
    'VALIDATE_UPLOADS': True,
    'SANITIZE_FILENAMES': True,
    'PATH_TRAVERSAL_PROTECTION': True,
}

def apply_production_config():
    """Apply production configuration to environment"""
    for key, value in PRODUCTION_AI_CONFIG.items():
        env_key = f'AI_{key}'
        if env_key not in os.environ:
            os.environ[env_key] = str(value)

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
        'api.middleware.ImageProcessingGatewayMiddleware',  # AI processing gateway
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
            'ai_engine': {
                'handlers': ['file', 'console'],
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

# Auto-apply configuration when imported
if os.getenv('DJANGO_SETTINGS_MODULE') and 'production' in os.getenv('DJANGO_SETTINGS_MODULE', ''):
    apply_production_config()