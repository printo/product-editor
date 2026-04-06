import os
from celery import Celery

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'product_editor.settings')

app = Celery('product_editor')

# All Celery settings come from Django settings (CELERY_* namespace).
# Do NOT set result_backend or broker_url here — they are read from
# CELERY_RESULT_BACKEND / CELERY_BROKER_URL in settings.py, which pull
# from the REDIS_URL env var.  Hardcoding them here would shadow the env var.
app.config_from_object('django.conf:settings', namespace='CELERY')

# Discover tasks from the api app
app.autodiscover_tasks(['api'])

# Import explicitly so tasks are registered even without autodiscover in tests
from api import tasks  # noqa

# ── Queue routing ────────────────────────────────────────────────────────────
# render_canvas_task default route is 'standard'; callers that need priority
# override via apply_async(queue='priority').
# push_to_production_estimator_task always uses 'standard' (not time-critical).
app.conf.task_routes = {
    'api.tasks.render_canvas_task': {'queue': 'standard'},
    'api.tasks.push_to_production_estimator_task': {'queue': 'standard'},
    'api.tasks.garbage_collector_task': {'queue': 'standard'},
}

# ── Worker behaviour ─────────────────────────────────────────────────────────
app.conf.worker_prefetch_multiplier = 1   # fetch one task at a time per worker slot
app.conf.worker_max_tasks_per_child = 10  # recycle workers to prevent memory leaks
app.conf.task_acks_late = True            # ack only after task completes
app.conf.task_reject_on_worker_lost = True  # requeue if worker process dies

# ── Result expiry ────────────────────────────────────────────────────────────
app.conf.result_expires = 86400  # keep results in Redis for 24 hours

# ── Monitoring ───────────────────────────────────────────────────────────────
app.conf.worker_send_task_events = True
app.conf.task_send_sent_event = True

# ── Beat schedule ────────────────────────────────────────────────────────────
from celery.schedules import crontab

app.conf.beat_schedule = {
    'garbage-collector': {
        'task': 'api.tasks.garbage_collector_task',
        'schedule': crontab(hour=2, minute=0),  # daily at 02:00 UTC
    },
}
