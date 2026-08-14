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
# notify_caller_webhook_task always uses 'standard' (not time-critical;
# only fires when canvas.callback_url is set, i.e. embed flow).
app.conf.task_routes = {
    'api.tasks.render_canvas_task': {'queue': 'standard'},
    'api.tasks.notify_caller_webhook_task': {'queue': 'standard'},
    'api.tasks.garbage_collector_task': {'queue': 'standard'},
}

# ── Worker behaviour ─────────────────────────────────────────────────────────
app.conf.worker_prefetch_multiplier = 1   # fetch one task at a time per worker slot
app.conf.worker_max_tasks_per_child = 50  # recycle workers to amortise startup; engine.py closes Pillow images + gc.collect per canvas
app.conf.task_acks_late = True            # ack only after task completes
# Visibility timeout for the Redis broker — how long an in-flight task stays
# "invisible" to other workers before being re-delivered. Default is 1 hour;
# tighten to 20 min so a worker crash mid-render gets retried within ~20 min
# instead of stalling for an hour. 20 min > render_canvas_task hard limit
# (10 min) so a healthy long-running task is never re-queued behind itself.
app.conf.broker_transport_options = {'visibility_timeout': 1200}
app.conf.task_reject_on_worker_lost = True  # requeue if worker process dies

# ── Result expiry ────────────────────────────────────────────────────────────
app.conf.result_expires = 86400  # keep results in Redis for 24 hours

# ── Monitoring ───────────────────────────────────────────────────────────────
app.conf.worker_send_task_events = True
app.conf.task_send_sent_event = True

# ── Beat schedule ────────────────────────────────────────────────────────────
from celery.schedules import crontab

# Every 6 hours (00:00 / 06:00 / 12:00 / 18:00 UTC), not once daily at 02:00.
#
# Retention is 3 days and Printo's orders arrive in Indian business hours, so
# exports expire at roughly the clock time they were created. Measured
# 2026-08-14, expiries by hour of the 7,647 rows then pending:
#
#   01:00  15   02:00  136   03:00  943   04:00  794   05:00  910   06:00 1019
#   07:00 610   08:00  841   09:00  490   10:00  887   11:00  484   12:00  486
#   13:00  29   (essentially nothing outside 03:00-12:00)
#
# A 02:00 sweep sat in the trough immediately BEFORE that wave: it collected the
# 151 rows expiring at 01:00-02:00 — 2% — and the other 98% then waited up to 23
# hours for the next run. Effective retention was therefore ~4 days rather than
# 3, carrying a permanent extra day of exports and uploads, and disk sawtoothed
# (82% -> 93% overnight on 2026-08-14) while the sweep itself was perfectly
# healthy. Diagnosing that as a broken GC produced two wrong root causes before
# anyone plotted the histogram above.
#
# Four sweeps a day caps the lag at ~6h. Cost is negligible: a no-op sweep takes
# 0.19s and a full one 2.3s, both far inside soft_time_limit=3300.
app.conf.beat_schedule = {
    'garbage-collector': {
        'task': 'api.tasks.garbage_collector_task',
        'schedule': crontab(minute=0, hour='*/6'),  # 00/06/12/18 UTC
    },
}

# ── Database connections across task boundaries ──────────────────────────────
# Recycle stale/dead DB connections before and after every task, the way Django
# does around an HTTP request.
#
# Without this, CONN_MAX_AGE does nothing in a worker. Django enforces that
# setting from its request_started/request_finished signals, and Celery has no
# requests — so a connection opened by the first task in a process stays checked
# out for the life of that process, no matter how long it goes unused. Postgres
# (or Docker's NAT) eventually drops the idle socket, and the next query on it
# raises InterfaceError: connection already closed.
#
# HARDENING, not a fix for a known incident. This has not been observed biting
# in production, and it is worth being precise because a confident story about
# it breaking the nightly GC on 2026-08-14 turned out to be wrong — that sweep
# ran and succeeded in 0.19s. `worker_max_tasks_per_child = 50` recycles the
# process periodically, which is probably why the risk has stayed latent.
#
# The risk is nonetheless real and was unguarded: kill connection.connection and
# the next query raises without these hooks, and succeeds with them.
#
# task_postrun matters as much as task_prerun: releasing the connection after a
# task means an idle worker is not sitting on one waiting to go stale.
from celery.signals import task_postrun, task_prerun  # noqa: E402


@task_prerun.connect
def _close_stale_db_connections_before_task(**_kwargs):
    from django.db import close_old_connections
    close_old_connections()


@task_postrun.connect
def _close_stale_db_connections_after_task(**_kwargs):
    from django.db import close_old_connections
    close_old_connections()
