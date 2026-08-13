"""
Tests for the path-based orphan export sweep (services/orphan_exports.py).

This is the one sweep that deletes on the ABSENCE of a database row, so a wrong
answer destroys live print files rather than merely missing some. These tests
therefore concentrate on the guards — every reason a directory must be KEPT —
rather than on the reclaim path:

  * a live RenderJob id, an ExportedResult reference, or a live CanvasData
    order_id all protect a directory
  * a non-UUID name is never touched (order_id trees, operator scratch dirs)
  * the age floor protects in-flight and recently-finished renders
  * dry_run reports without deleting; 'off' does nothing at all
  * a database failure keeps everything, rather than treating an empty result
    set as "all of these are orphans"

Kept DB-free (CI installs no database) by injecting the three name sets that
`reconcile_orphan_exports` would otherwise query, via monkeypatching
`_known_export_dir_names`.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_orphan_exports
"""
from __future__ import annotations

import os
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone

import django
from django.conf import settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
if not settings.configured or not django.apps.apps.ready:
    django.setup()

from services import orphan_exports  # noqa: E402

NOW = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)
OLD_MTIME = (NOW - timedelta(days=30)).timestamp()      # comfortably past the floor
NEW_MTIME = (NOW - timedelta(hours=2)).timestamp()      # comfortably inside it


class _Tree:
    """A throwaway EXPORTS_DIR with injected DB state."""

    def __init__(self, job_ids=(), exported_dirs=(), order_ids=()):
        self._sets = (set(job_ids), set(exported_dirs), set(order_ids))

    def __enter__(self):
        self._dir = tempfile.TemporaryDirectory()
        self._prev_exports = settings.EXPORTS_DIR
        self._prev_retention = settings.EXPORT_RETENTION_DAYS
        settings.EXPORTS_DIR = self._dir.name
        settings.EXPORT_RETENTION_DAYS = 3
        self._prev_fn = orphan_exports._known_export_dir_names
        orphan_exports._known_export_dir_names = lambda: self._sets
        return self

    def __exit__(self, *exc):
        settings.EXPORTS_DIR = self._prev_exports
        settings.EXPORT_RETENTION_DAYS = self._prev_retention
        orphan_exports._known_export_dir_names = self._prev_fn
        self._dir.cleanup()
        return False

    def add(self, name, *, mtime=OLD_MTIME, contents=b"print-file-bytes"):
        d = os.path.join(self._dir.name, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "out_1.png"), "wb") as fh:
            fh.write(contents)
        os.utime(d, (mtime, mtime))
        return d

    def exists(self, name):
        return os.path.isdir(os.path.join(self._dir.name, name))


def _sweep(mode):
    return orphan_exports.reconcile_orphan_exports(mode=mode, now=NOW)


def test_orphan_is_found_in_dry_run_but_not_deleted():
    orphan = str(uuid.uuid4())
    with _Tree() as t:
        t.add(orphan)
        r = _sweep("dry_run")
        assert r["orphan_dirs"] == 1
        assert r["orphan_bytes"] > 0
        assert r["deleted_dirs"] == 0
        assert t.exists(orphan), "dry_run must not delete"
        assert r["samples"][0]["dir"] == orphan


def test_delete_mode_reclaims_the_orphan():
    orphan = str(uuid.uuid4())
    with _Tree() as t:
        t.add(orphan)
        r = _sweep("delete")
        assert r["deleted_dirs"] == 1
        assert r["deleted_bytes"] > 0
        assert not t.exists(orphan)


def test_off_mode_does_nothing_at_all():
    orphan = str(uuid.uuid4())
    with _Tree() as t:
        t.add(orphan)
        r = _sweep("off")
        assert r["scanned"] == 0
        assert r["orphan_dirs"] == 0
        assert t.exists(orphan)


def test_live_renderjob_id_is_kept():
    live = str(uuid.uuid4())
    with _Tree(job_ids=[live]) as t:
        t.add(live)
        r = _sweep("delete")
        assert r["deleted_dirs"] == 0
        assert t.exists(live)
        assert r["kept"]["live-renderjob"] == 1


def test_dir_referenced_by_exportedresult_is_kept():
    ref = str(uuid.uuid4())
    with _Tree(exported_dirs=[ref]) as t:
        t.add(ref)
        r = _sweep("delete")
        assert r["deleted_dirs"] == 0
        assert t.exists(ref)
        assert r["kept"]["referenced-by-exportedresult"] == 1


def test_uuid_shaped_order_id_is_kept():
    # A partner order_id can legitimately look like a UUID. Treating it as a job
    # directory would delete a live order's output.
    oid = str(uuid.uuid4())
    with _Tree(order_ids=[oid]) as t:
        t.add(oid)
        r = _sweep("delete")
        assert r["deleted_dirs"] == 0
        assert t.exists(oid)
        assert r["kept"]["live-canvasdata-order"] == 1


def test_non_uuid_directory_is_never_touched():
    # order_id-named trees (EXPORTS_DIR/<order_id>/) and anything an operator
    # dropped here by hand.
    with _Tree() as t:
        for name in ("576214", "SMOKE-1786620270", "scratch", "_no_order"):
            t.add(name)
        r = _sweep("delete")
        assert r["deleted_dirs"] == 0
        assert r["kept"]["not-a-uuid"] == 4
        assert t.exists("576214") and t.exists("scratch")


def test_recent_directory_is_kept_even_with_no_db_row():
    # The age floor is what makes this safe next to live traffic: a render that
    # has just written its output has no ExportedResult row yet either.
    fresh = str(uuid.uuid4())
    with _Tree() as t:
        t.add(fresh, mtime=NEW_MTIME)
        r = _sweep("delete")
        assert r["deleted_dirs"] == 0
        assert t.exists(fresh)
        assert r["kept"]["too-recent"] == 1


def test_age_floor_is_retention_plus_one_day():
    with _Tree() as t:
        # retention is 3 in the harness, so the floor is 4 days.
        just_inside = str(uuid.uuid4())   # 3.5 days old → kept
        just_outside = str(uuid.uuid4())  # 4.5 days old → orphan
        t.add(just_inside, mtime=(NOW - timedelta(days=3, hours=12)).timestamp())
        t.add(just_outside, mtime=(NOW - timedelta(days=4, hours=12)).timestamp())
        r = _sweep("dry_run")
        assert r["orphan_dirs"] == 1
        assert r["samples"][0]["dir"] == just_outside
        assert r["kept"]["too-recent"] == 1


def test_db_failure_keeps_everything():
    # Without the DB sets every directory looks like an orphan. Proceeding on a
    # partial picture would delete the whole export tree.
    orphan = str(uuid.uuid4())
    with _Tree() as t:
        t.add(orphan)

        def boom():
            raise RuntimeError("database is down")

        orphan_exports._known_export_dir_names = boom
        r = _sweep("delete")
        assert r["deleted_dirs"] == 0
        assert r["orphan_dirs"] == 0
        assert "error" in r
        assert t.exists(orphan)


def test_files_at_the_top_level_are_ignored():
    with _Tree() as t:
        with open(os.path.join(settings.EXPORTS_DIR, "stray.png"), "wb") as fh:
            fh.write(b"x")
        r = _sweep("delete")
        assert r["scanned"] == 0
        assert os.path.exists(os.path.join(settings.EXPORTS_DIR, "stray.png"))


def test_mixed_tree_reports_each_keep_reason():
    live, ref, oid, orphan = (str(uuid.uuid4()) for _ in range(4))
    fresh = str(uuid.uuid4())
    with _Tree(job_ids=[live], exported_dirs=[ref], order_ids=[oid]) as t:
        for n in (live, ref, oid, orphan):
            t.add(n)
        t.add(fresh, mtime=NEW_MTIME)
        t.add("576214")
        r = _sweep("dry_run")
        assert r["scanned"] == 6
        assert r["orphan_dirs"] == 1
        assert r["kept"] == {
            "live-renderjob": 1,
            "referenced-by-exportedresult": 1,
            "live-canvasdata-order": 1,
            "too-recent": 1,
            "not-a-uuid": 1,
        }


def test_sample_list_is_capped():
    with _Tree() as t:
        for _ in range(orphan_exports.SAMPLE_LIMIT + 5):
            t.add(str(uuid.uuid4()))
        r = _sweep("dry_run")
        assert r["orphan_dirs"] == orphan_exports.SAMPLE_LIMIT + 5
        assert len(r["samples"]) == orphan_exports.SAMPLE_LIMIT


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} orphan-export sweep tests passed.")
