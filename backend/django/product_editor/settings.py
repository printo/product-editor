import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-secret-key")
DEBUG = os.getenv("DEBUG", "0") == "1"  # default off so production-safe by absence
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS", "*").split(",")
if "backend" not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append("backend")

# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/5.0/howto/static-files/

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "drf_spectacular",
    "corsheaders",
    "csp",
    "django_celery_beat",
    "django_celery_results",
    "api",
    "layout_engine",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "csp.middleware.CSPMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "product_editor.middleware.ProxyAuthenticationMiddleware",
    "api.middleware.APIRequestLoggingMiddleware",  # API request logging
    "api.middleware.RateLimitMiddleware",  # Rate limiting
]

ROOT_URLCONF = "product_editor.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "api" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "product_editor.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("POSTGRES_DB"),
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST", "localhost"),
        "PORT": os.getenv("POSTGRES_PORT", "5432"),
        "CONN_MAX_AGE": int(os.getenv("DB_CONN_MAX_AGE", "600")),  # 10-min persistent connections — keep low only if PgBouncer is in front
        "OPTIONS": {
            "connect_timeout": 10,
        },
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "api.authentication.BearerTokenAuthentication",  # Static keys
        "api.authentication.PIAAuthentication",         # PIA tokens
    ),
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 100,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Product Editor API",
    "DESCRIPTION": (
        "REST API for the Printo Product Editor.\n\n"
        "## Authentication\n\n"
        "All endpoints (except `/api/health`) require one of:\n\n"
        "- **Bearer API Key** — `Authorization: Bearer <api-key>` — for server-to-server and embed flows\n"
        "- **PIA Session Token** — `Authorization: Bearer <pia-token>` — for internal dashboard users\n\n"
        "## Embed Flow\n\n"
        "The embed system lets external sites display the full canvas editor inside an iframe "
        "without exposing a real API key in the URL.\n\n"
        "```\n"
        "1. Your server  → POST /api/embed/session  (with real API key)\n"
        "                ← { token: '<uuid>', expires_at: '...' }\n\n"
        "2. Your frontend → open iframe:\n"
        "   https://product-editor.printo.in/layout/<name>?token=<uuid>\n\n"
        "3. Customer edits in canvas, clicks Submit Design\n\n"
        "4. Your page receives:\n"
        "   window.postMessage({ type: 'PRODUCT_EDITOR_COMPLETE', canvases: [...] })\n"
        "```\n\n"
        "Token TTL is **2 hours**. Generate a fresh token per customer session."
    ),
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "TAGS": [
        {"name": "health", "description": "Service liveness check"},
        {"name": "layouts", "description": "Layout discovery and JSON retrieval"},
        {"name": "generate", "description": "Canvas generation from uploaded images"},
        {"name": "embed", "description": "Short-lived iframe embed tokens — external site integration"},
        {"name": "exports", "description": "Secure download of exported files"},
        {"name": "ops", "description": "Ops team layout management (internal only)"},
    ],
    "SWAGGER_UI_SETTINGS": {
        "deepLinking": True,
        "persistAuthorization": True,
        "displayOperationId": False,
    },
    "SECURITY": [{"BearerAuth": []}],
    "SECURITY_DEFINITIONS": {
        "BearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "API key or PIA token",
        }
    },
}

# CORS Configuration - Restrict to specific origins
CORS_ALLOWED_ORIGINS = os.getenv(
    "CORS_ALLOWED_ORIGINS",
    "http://localhost:3000,http://localhost:5004,http://127.0.0.1:3000,http://127.0.0.1:5004"
).split(",")

# Only in development, allow all origins
if DEBUG:
    CORS_ALLOW_ALL_ORIGINS = os.getenv("CORS_ALLOW_ALL_DEVELOPMENT", "true").lower() == "true"
else:
    CORS_ALLOW_ALL_ORIGINS = False

CORS_ALLOW_CREDENTIALS = True
CORS_EXPOSE_HEADERS = ["Content-Type", "X-Request-ID"]

STORAGE_ROOT = os.getenv("STORAGE_ROOT", str(BASE_DIR.parent.parent / "storage"))
UPLOADS_DIR = os.path.join(STORAGE_ROOT, "uploads")
LAYOUTS_DIR = os.path.join(STORAGE_ROOT, "layouts")
EXPORTS_DIR = os.path.join(STORAGE_ROOT, "exports")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(LAYOUTS_DIR, exist_ok=True)
os.makedirs(EXPORTS_DIR, exist_ok=True)



# File Upload Configuration — single source of truth, driven by env var
MAX_UPLOAD_FILE_SIZE_MB = int(os.getenv("MAX_UPLOAD_FILE_SIZE_MB", "50"))
MAX_UPLOAD_FILE_SIZE = MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024
# Django spools files to disk when they exceed FILE_UPLOAD_MAX_MEMORY_SIZE;
# it does NOT reject uploads at this size (files just move from memory to disk).
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024  # 10 MB — non-file request body limit
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024  # 10 MB — spool-to-disk threshold

# Security Headers
SECURE_BROWSER_XSS_FILTER = True

# Content Security Policy via django-csp.
# Starts in report-only mode — headers are emitted but nothing is blocked, so we
# can monitor violations before enforcing. Flip CSP_REPORT_ONLY=False in env once
# the policy has been validated against the editor (Fabric.js, embed iframes).
CSP_DEFAULT_SRC = ("'self'",)
CSP_SCRIPT_SRC = ("'self'", "'unsafe-inline'", "'unsafe-eval'")  # 'unsafe-eval' for Fabric.js
CSP_STYLE_SRC = ("'self'", "'unsafe-inline'")
CSP_IMG_SRC = ("'self'", "data:", "blob:", "https:")
CSP_FONT_SRC = ("'self'", "data:")
CSP_CONNECT_SRC = ("'self'", "https:")
CSP_FRAME_ANCESTORS = ("'self'", "https://printo.in", "https://*.printo.in")
CSP_REPORT_ONLY = os.getenv("CSP_REPORT_ONLY", "True").lower() not in ("false", "0", "no")

# X-Frame-Options
X_FRAME_OPTIONS = "SAMEORIGIN"

# HTTPS Security
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = os.getenv("SECURE_SSL_REDIRECT", "True").lower() not in ("false", "0", "no")
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

# Cache Configuration — django-redis (shared across all Gunicorn workers)
# REDIS_URL defaults to the Docker service name; override via env in any environment.
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": os.getenv("REDIS_URL", "redis://redis:6379/0"),
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
            # Fail open: if Redis is unreachable, log the error rather than raising.
            # Rate limiting and other cache consumers already handle unavailability gracefully.
            "IGNORE_EXCEPTIONS": True,
        },
        "TIMEOUT": 300,
        "KEY_PREFIX": "pe",  # product-editor — avoids key collisions if Redis is shared
    }
}

# Logging Configuration
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "{levelname} {asctime} {module} {process:d} {thread:d} {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
    },
    "root": {
        "handlers": ["console"],
        "level": "INFO",
    },
    "loggers": {
        "django": {
            "handlers": ["console"],
            "level": os.getenv("DJANGO_LOG_LEVEL", "INFO"),
            "propagate": False,
        },
        "api": {
            "handlers": ["console"],
            "level": "INFO",
        },
    },
}

# Celery Configuration
CELERY_BROKER_URL = os.getenv('REDIS_URL', 'redis://redis:6379/0')
CELERY_RESULT_BACKEND = os.getenv('REDIS_URL', 'redis://redis:6379/0')
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'
CELERY_TIMEZONE = 'UTC'

# OMS Integration
OMS_PRODUCTION_ESTIMATOR_URL = os.getenv(
    'OMS_PRODUCTION_ESTIMATOR_URL',
    'http://oms-service:8080/api/production/estimate'
)

# Cache TTL Configuration (seconds)
# Dynamic TTL based on job status for optimal caching performance
RENDER_JOB_STATUS_CACHE_TTL = {
    'queued': int(os.getenv('CACHE_TTL_QUEUED', '3')),        # Jobs transition quickly
    'processing': int(os.getenv('CACHE_TTL_PROCESSING', '10')),  # Longer render times
    'completed': int(os.getenv('CACHE_TTL_COMPLETED', '300')),   # Terminal state
    'failed': int(os.getenv('CACHE_TTL_FAILED', '300')),         # Terminal state
    'default': int(os.getenv('CACHE_TTL_DEFAULT', '5')),         # Fallback
}
