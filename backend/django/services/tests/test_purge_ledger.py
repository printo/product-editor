"""
The purge ledger (services/purge_ledger.py) — DB-free.

It exists so a database restore cannot resurrect an erased order. What decides
whether it can be trusted:

  * it records no raw order id (it is not a second copy of what was erased);
  * a key-scoped erasure never matches another key's order with the same id;
  * only entries newer than the dump are replayed (an order re-created after
    its erasure and captured in the dump must survive);
  * a failed ledger write never fails the erasure itself.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_purge_ledger
"""
from __future__ import annotations

import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.conf import settings  # noqa: E402

from services import purge_ledger as pl  # noqa: E402

T0 = datetime(2026, 10, 13, 3, 15, 0, tzinfo=timezone.utc)


class _Root:
    def __enter__(self):
        self.prev = settings.STORAGE_ROOT
        self.dir = tempfile.mkdtemp(prefix="pe-ledger-")
        settings.STORAGE_ROOT = self.dir
        return self

    def __exit__(self, *exc):
        settings.STORAGE_ROOT = self.prev
        shutil.rmtree(self.dir, ignore_errors=True)


def test_ledger_never_holds_the_order_id():
    with _Root():
        assert pl.record_purge("EXT-JOB-123", "Printo.in Storefront", now=T0)
        raw = open(pl.ledger_path()).read()
        assert "EXT-JOB-123" not in raw and "Storefront" not in raw, raw


def test_digest_is_scoped_and_stable():
    a = pl.order_digest("ORD-1", "keyA")
    assert a == pl.order_digest("ORD-1", "keyA")
    assert a != pl.order_digest("ORD-1", "keyB")
    assert a != pl.order_digest("ORD-1", None)
    assert pl.order_digest("ORD-1", None) == pl.order_digest("ORD-1", pl.ALL_TENANTS)


def test_key_scoped_entry_does_not_match_another_keys_order():
    with _Root():
        pl.record_purge("ORD-1", "keyA", now=T0 + timedelta(hours=1))
        entries = pl.read_entries(T0)
        plan = pl.plan_replay(entries, [("ORD-1", "keyA"), ("ORD-1", "keyB"), ("ORD-2", "keyA")])
        assert plan == {("ORD-1", "keyA")}, plan


def test_all_tenant_entry_matches_every_key():
    with _Root():
        pl.record_purge("ORD-1", None, now=T0 + timedelta(hours=1))
        plan = pl.plan_replay(pl.read_entries(T0), [("ORD-1", "keyA"), ("ORD-1", "keyB")])
        assert plan == {("ORD-1", None)}, plan


def test_only_entries_after_the_dump_are_replayed():
    with _Root():
        pl.record_purge("OLD", None, now=T0 - timedelta(days=2))   # already absent from the dump
        pl.record_purge("NEW", None, now=T0 + timedelta(hours=5))
        plan = pl.plan_replay(pl.read_entries(T0), [("OLD", "k"), ("NEW", "k")])
        assert plan == {("NEW", None)}, plan


def test_parse_stamp_accepts_backup_and_iso_forms():
    assert pl.parse_stamp("20261013T031500Z") == T0
    assert pl.parse_stamp("2026-10-13T03:15:00Z") == T0
    assert pl.parse_stamp("2026-10-13T03:15:00+00:00") == T0


def test_malformed_lines_are_skipped():
    with _Root():
        pl.record_purge("A", None, now=T0)
        with open(pl.ledger_path(), "a") as fh:
            fh.write("not json\n{\"h\": 1}\n\n")
        assert len(pl.read_entries()) == 1


def test_trim_drops_only_old_entries():
    with _Root():
        pl.record_purge("OLD", None, now=T0 - timedelta(days=60))
        pl.record_purge("NEW", None, now=T0 - timedelta(days=1))
        assert pl.trim(45, now=T0) == 1
        left = pl.read_entries()
        assert len(left) == 1 and left[0]["h"] == pl.order_digest("NEW", None)
        assert pl.trim(45, now=T0) == 0


def test_a_failed_write_returns_false_instead_of_raising():
    with _Root() as root:
        os.chmod(root.dir, 0o500)
        try:
            if os.geteuid() == 0:   # root ignores the mode; nothing to prove
                return
            assert pl.record_purge("A", None) is False
        finally:
            os.chmod(root.dir, 0o700)


def test_missing_ledger_reads_as_empty():
    with _Root():
        assert pl.read_entries() == [] and pl.trim(45) == 0


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print(f"  ok  {name}")
    print(f"\n{passed} purge-ledger tests passed")
