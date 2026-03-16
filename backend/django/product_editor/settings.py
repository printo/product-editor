import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-secret-key")
DEBUG = os.getenv("DEBUG", "1") == "1"  # ⚠️  MUST be False in production
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
    "corsheaders",
    "api",
    "ai_engine",  # AI processing engine
    "layout_engine",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "product_editor.middleware.ProxyAuthenticationMiddleware",
    "api.middleware.ImageProcessingGatewayMiddleware",  # AI processing gateway
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
        "NAME": os.getenv("POSTGRES_DB", "product_editor"),
        "USER": os.getenv("POSTGRES_USER", "postgres"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD", "postgres"),
        "HOST": os.getenv("POSTGRES_HOST", "localhost"),
        "PORT": os.getenv("POSTGRES_PORT", "5432"),
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



# File Upload Configuration
MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024  # 10MB
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024  # 10MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024  # 10MB

# AI Processing Configuration (Auto-configured based on system resources)
AI_PROCESSING_ENABLED = os.getenv("AI_PROCESSING_ENABLED", "true").lower() == "true"
AI_CACHE_TTL = int(os.getenv("AI_CACHE_TTL", "3600"))  # 1 hour cache
AI_MAINTENANCE_INTERVAL = int(os.getenv("AI_MAINTENANCE_INTERVAL", "1800"))  # 30 minutes
AI_PROCESSING_TIMEOUT = int(os.getenv("AI_PROCESSING_TIMEOUT", "60"))  # 1 minute timeout
AI_BACKGROUND_PROCESSING = os.getenv("AI_BACKGROUND_PROCESSING", "true").lower() == "true"

# Force CPU-only mode (can be overridden by environment variable)
AI_FORCE_CPU_ONLY = os.getenv("AI_FORCE_CPU_ONLY", "false").lower() == "true"

# Security Headers
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_SECURITY_POLICY = {
    "default-src": ("'self'",),
    "script-src": ("'self'", "'unsafe-inline'"),
    "style-src": ("'self'", "'unsafe-inline'"),
    "img-src": ("'self'", "data:", "https:"),
}

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

# Cache Configuration
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "product-editor-cache",
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
