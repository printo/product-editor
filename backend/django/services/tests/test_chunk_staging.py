"""
Tests for the abandoned chunked-upload staging sweep (services/chunk_staging.py).

The sweep deletes by default, so what matters is not that it removes things but
that it removes ONLY the right things. Production held 93 abandoned
`.chunks/<uuid>/` directories at discovery, invisible to every other GC sweep
because a half-finished upload has no UploadedFile row to start from.

These pin the properties an operator depends on:

  * an upload IN PROGRESS is never touched, however long it has been running
  * the age floor is honoured on both sides of the boundary
  * a non-UUID directory name is left alone — the same guard the chunk
    endpoints apply before touching a request-derived path
  * a stray FILE directly under .chunks/ is not mistaken for a staging dir
  * dry_run reports without deleting
  * an unreadable tree cannot raise into the GC sweep that called it

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_chunk_staging
"""
from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from datetime import datetime, timedelta, timezone

import django
from django.conf import settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from services import chunk_staging  # noqa: E402

NOW = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)


class _TempUploads:
    """Point UPLOADS_DIR at a throwaway tree for the duration of a test."""

    def __enter__(self):
        self._prev = settings.UPLOADS_DIR
        self.root = tempfile.mkdtemp(prefix="chunkstaging-test-")
        settings.UPLOADS_DIR = self.root
        os.makedirs(os.path.join(self.root, ".chunks"), exist_ok=True)
        return self

    def __exit__(self, *exc):
        settings.UPLOADS_DIR = self._prev
        shutil.rmtree(self.root, ignore_errors=True)
        return False

    def stage(self, *, age_hours: float, name: str | None = None, parts: int = 2) -> str:
        """Create a staging dir whose contents last changed `age_hours` ago."""
        name = name or str(uuid.uuid4())
        path = os.path.join(self.root, ".chunks", name)
        os.makedirs(path, exist_ok=True)
        for i in range(parts):
            with open(os.path.join(path, f"{i}.part"), "wb") as fh:
                fh.write(b"x" * 100)
        stamp = (NOW - timedelta(hours=age_hours)).timestamp()
        for entry in os.listdir(path):
            os.utime(os.path.join(path, entry), (stamp, stamp))
        os.utime(path, (stamp, stamp))
        return name


def test_abandoned_directory_is_removed():
    with _TempUploads() as t:
        name = t.stage(age_hours=48)
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == 1, res
        assert res["deleted_bytes"] == 200, res
        assert not os.path.exists(os.path.join(t.root, ".chunks", name))


def test_upload_in_progress_is_never_touched():
    """The property that makes this safe to run beside live traffic."""
    with _TempUploads() as t:
        name = t.stage(age_hours=0.5)
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == 0, res
        assert res["kept"].get("still_recent") == 1, res
        assert os.path.isdir(os.path.join(t.root, ".chunks", name))


def test_slow_upload_protected_by_newest_file_not_dir_mtime():
    """A long-running upload whose directory mtime is old but whose parts are fresh."""
    with _TempUploads() as t:
        name = t.stage(age_hours=48)
        path = os.path.join(t.root, ".chunks", name)
        fresh = (NOW - timedelta(minutes=5)).timestamp()
        os.utime(os.path.join(path, "0.part"), (fresh, fresh))
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == 0, res
        assert os.path.isdir(path)


def test_age_floor_boundary_is_honoured():
    with _TempUploads() as t:
        t.stage(age_hours=23)   # inside the window — keep
        t.stage(age_hours=25)   # outside — remove
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == 1, res
        assert res["kept"].get("still_recent") == 1, res


def test_non_uuid_directory_is_left_alone():
    with _TempUploads() as t:
        t.stage(age_hours=99, name="not-a-upload-id")
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == 0, res
        assert res["kept"].get("name_not_uuid") == 1, res
        assert os.path.isdir(os.path.join(t.root, ".chunks", "not-a-upload-id"))


def test_stray_file_under_chunks_is_not_treated_as_a_staging_dir():
    with _TempUploads() as t:
        stray = os.path.join(t.root, ".chunks", "README")
        with open(stray, "w") as fh:
            fh.write("not a staging dir")
        old = (NOW - timedelta(days=30)).timestamp()
        os.utime(stray, (old, old))
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == 0, res
        assert res["kept"].get("not_a_directory") == 1, res
        assert os.path.isfile(stray)


def test_dry_run_reports_without_deleting():
    with _TempUploads() as t:
        name = t.stage(age_hours=48)
        res = chunk_staging.sweep_stale_chunk_staging(
            max_age_hours=24, dry_run=True, now=NOW
        )
        assert res["stale_dirs"] == 1, res
        assert res["deleted_dirs"] == 0, res
        assert os.path.isdir(os.path.join(t.root, ".chunks", name))


def test_missing_chunks_root_is_a_no_op():
    with _TempUploads() as t:
        shutil.rmtree(os.path.join(t.root, ".chunks"))
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["scanned"] == 0 and res["deleted_dirs"] == 0, res


def test_unreadable_root_does_not_raise_into_the_gc():
    """A reclamation pass must never be able to fail the sweep it runs inside."""
    with _TempUploads() as t:
        settings.UPLOADS_DIR = os.path.join(t.root, "nope")
        os.makedirs(os.path.join(settings.UPLOADS_DIR, ".chunks"))
        os.chmod(os.path.join(settings.UPLOADS_DIR, ".chunks"), 0o000)
        try:
            res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
            assert res["deleted_dirs"] == 0, res
        finally:
            os.chmod(os.path.join(settings.UPLOADS_DIR, ".chunks"), 0o755)


def test_samples_are_capped():
    with _TempUploads() as t:
        for _ in range(chunk_staging.SAMPLE_LIMIT + 5):
            t.stage(age_hours=48, parts=1)
        res = chunk_staging.sweep_stale_chunk_staging(max_age_hours=24, now=NOW)
        assert res["deleted_dirs"] == chunk_staging.SAMPLE_LIMIT + 5, res
        assert len(res["samples"]) == chunk_staging.SAMPLE_LIMIT, res


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} chunk-staging tests passed.")
