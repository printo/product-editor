"""
Tests for the durable GC last-run record (services/gc_status.py).

The point of that module is to answer "has the garbage collector actually run?"
— a question that cost a week of unswept files and 89% disk on production
because nothing recorded it. So these tests pin the properties an operator
depends on, not just the happy path:

  * a missing record reads as STALE, never as healthy
  * an unreadable / malformed record reads as STALE, never as healthy
  * the staleness threshold is honoured on both sides of the boundary
  * a failed write cannot raise into the sweep that called it
  * no *.tmp litter is left behind by either a success or a failure

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_gc_status
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timedelta, timezone

import django
from django.conf import settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
if not settings.configured or not django.apps.apps.ready:
    django.setup()

from services import gc_status  # noqa: E402

NOW = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)
SAMPLE_STATS = {"deleted_count": 1776, "deleted_bytes": 4276493447, "disk_usage_percent": 89.2}


class _TempStorage:
    """Point STORAGE_ROOT at a throwaway dir — these tests must never touch real storage."""

    def __enter__(self):
        self._dir = tempfile.TemporaryDirectory()
        self._prev = settings.STORAGE_ROOT
        settings.STORAGE_ROOT = self._dir.name
        return self._dir.name

    def __exit__(self, *exc):
        settings.STORAGE_ROOT = self._prev
        self._dir.cleanup()
        return False


def _tmp_litter(root: str) -> list[str]:
    return [n for n in os.listdir(root) if n.endswith(".tmp")]


def test_record_then_read_round_trips_stats_and_timestamp():
    with _TempStorage():
        assert gc_status.record_gc_run(SAMPLE_STATS, now=NOW) is True
        status = gc_status.read_gc_status(now=NOW)
        assert status["last_run_at"] == NOW.isoformat()
        assert status["age_hours"] == 0.0
        assert status["stale"] is False
        assert status["stats"]["deleted_count"] == 1776


def test_missing_record_reads_as_stale_not_healthy():
    # The pre-fix state. Absence of evidence must not present as health.
    with _TempStorage():
        status = gc_status.read_gc_status(now=NOW)
        assert status["stale"] is True
        assert status["last_run_at"] is None
        assert status["age_hours"] is None
        assert "detail" in status


def test_unreadable_record_reads_as_stale():
    with _TempStorage():
        with open(gc_status.status_path(), "w") as fh:
            fh.write("{ this is not json")
        status = gc_status.read_gc_status(now=NOW)
        assert status["stale"] is True
        assert status["last_run_at"] is None


def test_record_without_valid_timestamp_reads_as_stale():
    with _TempStorage():
        with open(gc_status.status_path(), "w") as fh:
            json.dump({"stats": SAMPLE_STATS}, fh)          # last_run_at absent
        assert gc_status.read_gc_status(now=NOW)["stale"] is True

        with open(gc_status.status_path(), "w") as fh:
            json.dump({"last_run_at": "not-a-date"}, fh)     # unparseable
        assert gc_status.read_gc_status(now=NOW)["stale"] is True


def test_threshold_boundary_is_honoured_on_both_sides():
    threshold = gc_status._stale_after_hours()
    with _TempStorage():
        # Just inside the window: a run that is merely late is not an alert.
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW - timedelta(hours=threshold - 1))
        assert gc_status.read_gc_status(now=NOW)["stale"] is False

        # Past the window: one fully missed night trips it.
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW - timedelta(hours=threshold + 1))
        status = gc_status.read_gc_status(now=NOW)
        assert status["stale"] is True
        assert status["age_hours"] == float(threshold + 1)


def test_a_second_run_overwrites_the_first():
    with _TempStorage():
        gc_status.record_gc_run({"deleted_count": 1}, now=NOW - timedelta(days=3))
        gc_status.record_gc_run({"deleted_count": 2}, now=NOW)
        status = gc_status.read_gc_status(now=NOW)
        assert status["stats"]["deleted_count"] == 2
        assert status["stale"] is False


def test_future_timestamp_clamps_age_instead_of_going_negative():
    # Clock skew between the worker that writes and the web process that reads
    # should not surface as a negative age that reads like corruption.
    with _TempStorage():
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW + timedelta(hours=2))
        status = gc_status.read_gc_status(now=NOW)
        assert status["age_hours"] == 0.0
        assert status["stale"] is False


def test_naive_timestamp_is_treated_as_utc_not_crashed_on():
    with _TempStorage():
        with open(gc_status.status_path(), "w") as fh:
            json.dump({"last_run_at": "2026-08-13T11:00:00", "stats": {}}, fh)
        status = gc_status.read_gc_status(now=NOW)
        assert status["age_hours"] == 1.0
        assert status["stale"] is False


def test_write_failure_returns_false_and_never_raises():
    # An audit record that can break the sweep it describes is worse than none.
    with _TempStorage():
        settings.STORAGE_ROOT = "/proc/cannot-create-here"
        assert gc_status.record_gc_run(SAMPLE_STATS, now=NOW) is False


def test_no_tmp_files_are_left_behind():
    with _TempStorage() as root:
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW)
        assert _tmp_litter(root) == []
        assert os.path.basename(gc_status.status_path()) in os.listdir(root)


def test_stats_with_non_json_types_still_serialise():
    # The task hands over whatever it computed; a stray Decimal/datetime must not
    # cost us the whole record.
    with _TempStorage():
        assert gc_status.record_gc_run({"ran_at": NOW, "count": 3}, now=NOW) is True
        assert gc_status.read_gc_status(now=NOW)["stats"]["count"] == 3


# ── Failure recording ────────────────────────────────────────────────────────
# These are the tests whose absence cost a week: a sweep that raised left no
# trace, so a broken task and an unscheduled one looked identical.

def test_failure_is_recorded_with_type_and_message():
    with _TempStorage():
        err = RuntimeError("server closed the connection unexpectedly")
        assert gc_status.record_gc_failure(err, now=NOW) is True
        status = gc_status.read_gc_status(now=NOW)
        assert status["failing"] is True
        assert status["last_failure_at"] == NOW.isoformat()
        assert "RuntimeError" in status["last_error"]
        assert "server closed the connection" in status["last_error"]


def test_failure_with_no_prior_success_is_stale_and_failing():
    with _TempStorage():
        gc_status.record_gc_failure(ValueError("boom"), now=NOW)
        status = gc_status.read_gc_status(now=NOW)
        assert status["stale"] is True, "never-succeeded must still read stale"
        assert status["failing"] is True
        assert status["last_run_at"] is None
        assert "has ever completed" in status["detail"]


def test_success_after_failure_keeps_the_error_but_clears_failing():
    # The operator needs to see "it succeeded now, but it broke at 02:00 with
    # this" — overwriting the error would hide the nightly pattern.
    with _TempStorage():
        gc_status.record_gc_failure(RuntimeError("nightly breakage"), now=NOW - timedelta(hours=6))
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW)
        status = gc_status.read_gc_status(now=NOW)
        assert status["failing"] is False, "latest event was a success"
        assert status["stale"] is False
        assert "nightly breakage" in status["last_error"], "error history must survive"
        assert status["last_failure_at"] is not None


def test_failure_after_success_sets_failing_even_while_not_yet_stale():
    # The exact production shape: succeeded manually this morning, then tonight's
    # scheduled run breaks. Still inside the staleness window, so `stale` alone
    # would say everything is fine.
    with _TempStorage():
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW - timedelta(hours=2))
        gc_status.record_gc_failure(RuntimeError("OperationalError"), now=NOW)
        status = gc_status.read_gc_status(now=NOW)
        assert status["stale"] is False
        assert status["failing"] is True, "alerting on stale alone would miss this"


def test_a_string_error_is_accepted():
    with _TempStorage():
        assert gc_status.record_gc_failure("plain message", now=NOW) is True
        assert gc_status.read_gc_status(now=NOW)["last_error"] == "plain message"


def test_long_error_is_truncated():
    with _TempStorage():
        gc_status.record_gc_failure(RuntimeError("x" * 5000), now=NOW)
        assert len(gc_status.read_gc_status(now=NOW)["last_error"]) <= gc_status.MAX_ERROR_CHARS


def test_failure_write_failure_returns_false_and_never_raises():
    with _TempStorage():
        settings.STORAGE_ROOT = "/proc/cannot-create-here"
        assert gc_status.record_gc_failure(RuntimeError("boom"), now=NOW) is False


def test_healthy_record_reports_not_failing_and_no_error():
    with _TempStorage():
        gc_status.record_gc_run(SAMPLE_STATS, now=NOW)
        status = gc_status.read_gc_status(now=NOW)
        assert status["failing"] is False
        assert status["last_error"] is None
        assert status["last_failure_at"] is None


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} gc-status tests passed.")
