#!/usr/bin/env sh
set -e

# ── Celery workers/beat skip DB setup — only Gunicorn (web) runs migrations ──
# Running migrate inside celery-beat would race with the backend container on
# startup; running it inside celery-worker is also unnecessary and slow.
if [ "$1" = "celery-worker" ]; then
    CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-2}"
    echo "Starting Celery worker (concurrency=${CELERY_CONCURRENCY}, queue=${CELERY_QUEUE:-priority,standard})..."
    exec /opt/venv/bin/celery -A product_editor worker \
        --loglevel=info \
        --concurrency="${CELERY_CONCURRENCY}" \
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

direct_key  = os.getenv("DIRECT_API_KEY")
external_key = os.getenv("EXTERNAL_API_KEY")
test_key    = os.getenv("TESTING_API_KEY")

if direct_key and not APIKey.objects.filter(key=direct_key).exists():
    APIKey.objects.create(
        name="DIRECT", key=direct_key,
        description="Direct Ops Team API key",
        is_active=True, is_ops_team=True,
        can_generate_layouts=True, can_list_layouts=True, can_access_exports=True,
        max_requests_per_day=10000,
    )
    print("✓ DIRECT API key loaded from environment")

if external_key and not APIKey.objects.filter(key=external_key).exists():
    APIKey.objects.create(
        name="EXTERNAL", key=external_key,
        description="External Partner API key",
        is_active=True, is_ops_team=False,
        can_generate_layouts=True, can_list_layouts=True, can_access_exports=True,
        max_requests_per_day=1000,
    )
    print("✓ EXTERNAL API key loaded from environment")

if test_key and not APIKey.objects.filter(key=test_key).exists():
    APIKey.objects.create(
        name="TESTING", key=test_key,
        description="Testing API key",
        is_active=True, is_ops_team=False,
        can_generate_layouts=True, can_list_layouts=True, can_access_exports=True,
        max_requests_per_day=5000,
    )
    print("✓ TESTING API key loaded from environment")

print("\n🔑 Available API Keys:")
for key in APIKey.objects.filter(is_active=True):
    print(f"   {key.name}: {key.key}")
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
