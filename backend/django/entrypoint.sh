#!/usr/bin/env sh
set -e

# ── Celery workers/beat skip DB setup — only Gunicorn (web) runs migrations ──
# Running migrate inside celery-beat would race with the backend container on
# startup; running it inside celery-worker is also unnecessary and slow.
if [ "$1" = "celery-worker" ]; then
    # If CELERY_CONCURRENCY is explicitly set (via .env or docker-compose
    # environment), respect it. Otherwise pass no --concurrency flag so Celery
    # auto-detects based on the number of available CPUs — which fully utilises
    # the server without an artificial cap.
    if [ -n "${CELERY_CONCURRENCY}" ]; then
        CONCURRENCY_ARG="--concurrency=${CELERY_CONCURRENCY}"
        echo "Starting Celery worker (concurrency=${CELERY_CONCURRENCY} [explicit], queue=${CELERY_QUEUE:-priority,standard})..."
    else
        CONCURRENCY_ARG=""
        echo "Starting Celery worker (concurrency=auto [CPU count], queue=${CELERY_QUEUE:-priority,standard})..."
    fi
    exec /opt/venv/bin/celery -A product_editor worker \
        --loglevel=info \
        ${CONCURRENCY_ARG} \
        --max-tasks-per-child=10 \
        -Q "${CELERY_QUEUE:-priority,standard}"
fi

if [ "$1" = "celery-beat" ]; then
    echo "Starting Celery beat scheduler..."
    exec /opt/venv/bin/celery -A product_editor beat --loglevel=info
fi

# ── Web (Gunicorn) path — runs migrations and seeds API keys ─────────────────

# Ensure EXPORTS_DIR has correct permissions
if [ -d "${STORAGE_ROOT}/exports" ]; then
    chmod 0775 "${STORAGE_ROOT}/exports" 2>/dev/null || echo "⚠️  Could not set EXPORTS_DIR permissions (may require root)"
    echo "✓ Verified EXPORTS_DIR permissions"
fi

# Run migrations — only the web container does this
/opt/venv/bin/python manage.py migrate --noinput

# Load API keys
/opt/venv/bin/python - <<'PY'
import os
import django
django.setup()

from api.models import APIKey

direct_key   = os.getenv("DIRECT_API_KEY")
external_key = os.getenv("EXTERNAL_API_KEY")
test_key     = os.getenv("TESTING_API_KEY")

# Use update_or_create keyed on *name* (not key) so that rotating the env-var
# value updates the existing DB record instead of raising IntegrityError
# (name has unique=True, so create() would fail if the record already exists).
if direct_key:
    _, created = APIKey.objects.update_or_create(
        name="DIRECT",
        defaults=dict(
            key=direct_key,
            description="Direct Ops Team API key",
            is_active=True, is_ops_team=True,
            can_generate_layouts=True, can_list_layouts=True, can_access_exports=True,
            max_requests_per_day=10000,
        ),
    )
    print(f"{'✓ Created' if created else '✓ Updated'} DIRECT API key from environment")

if external_key:
    _, created = APIKey.objects.update_or_create(
        name="EXTERNAL",
        defaults=dict(
            key=external_key,
            description="External Partner API key",
            is_active=True, is_ops_team=False,
            can_generate_layouts=True, can_list_layouts=True, can_access_exports=True,
            max_requests_per_day=1000,
        ),
    )
    print(f"{'✓ Created' if created else '✓ Updated'} EXTERNAL API key from environment")

if test_key:
    _, created = APIKey.objects.update_or_create(
        name="TESTING",
        defaults=dict(
            key=test_key,
            description="Testing API key",
            is_active=True, is_ops_team=False,
            can_generate_layouts=True, can_list_layouts=True, can_access_exports=True,
            max_requests_per_day=5000,
        ),
    )
    print(f"{'✓ Created' if created else '✓ Updated'} TESTING API key from environment")

# Print key names only — never log full key values to stdout since container
# logs are typically forwarded to centralised log aggregators (Datadog, etc.).
print("\n🔑 Active API Keys:")
for k in APIKey.objects.filter(is_active=True):
    print(f"   {k.name}: {k.key[:12]}…")
PY

# ── Launch Gunicorn ───────────────────────────────────────────────────────────
# workers = nproc * 2 + 1  (gthread: sync + OS thread pool)
WORKERS=$(( $(nproc) * 2 + 1 ))
echo "Starting gunicorn: ${WORKERS} workers × ${GUNICORN_THREADS:-4} threads on port ${PORT:-8000}"
exec gunicorn product_editor.wsgi:application \
    --bind "0.0.0.0:${PORT:-8000}" \
    --worker-class gthread \
    --workers "${WORKERS}" \
    --threads "${GUNICORN_THREADS:-4}" \
    --timeout "${GUNICORN_TIMEOUT:-300}" \
    --graceful-timeout 60 \
    --keep-alive 5 \
    --max-requests "${GUNICORN_MAX_REQUESTS:-500}" \
    --max-requests-jitter 50 \
    --access-logfile - \
    --error-logfile - \
    --log-level "${GUNICORN_LOG_LEVEL:-info}" \
    --name product_editor
