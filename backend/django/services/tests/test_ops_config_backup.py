"""
ops-config backup/restore round-trip over the in-memory S3.

The property that matters: a deleted asset (tombstone) comes back as a
tombstone. Restoring it as an absent key would resurrect the git seed.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_ops_config_backup
"""
from __future__ import annotations

import io
import os
import tarfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from services.ops_config_backup import export_ops_config, restore_ops_config  # noqa: E402
from services.storage import LocalStorage  # noqa: E402
from services.tests.fake_s3 import S3Backend  # noqa: E402


def _seed(s3):
    s3.put("holidays/en-IN", "2026", {"events": [{"date": "2026-11-08", "name": "Diwali"}]})
    s3.put("calendar_styles", "modern", {"bg": "#fff"})
    s3.put("fonts", "fonts", {"fonts": ["Inter"]})
    s3.storage.delete_calendar_asset("holidays/en-IN", "2027")


def _archive(s3):
    buf = io.BytesIO()
    stats = export_ops_config(s3.storage, buf)
    buf.seek(0)
    return stats, buf


def test_round_trip_restores_content_and_tombstones():
    with S3Backend() as s3:
        _seed(s3)
        before = dict(s3.client.objects)
        stats, archive = _archive(s3)
        assert stats == {"objects": 4, "tombstones": 1}, stats
        s3.client.objects.clear()
        s3.client.metadata.clear()
        out = restore_ops_config(s3.storage, archive)
        assert out == {"restored": 4, "tombstones": 1, "skipped": 0}, out
        assert s3.client.objects == before
        gone = s3.key("holidays/en-IN", "2027")
        assert s3.client.metadata[gone] == {"pe-tombstone": "1"}
        try:
            s3.storage.read_calendar_asset("holidays/en-IN", "2027")
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("tombstone was restored as a live asset")


def test_only_the_ops_config_prefix_is_archived():
    with S3Backend() as s3:
        _seed(s3)
        s3.client.objects["product-editor/uploads/x/photo.jpg"] = b"photo"
        s3.client.metadata["product-editor/uploads/x/photo.jpg"] = {}
        _, archive = _archive(s3)
        with tarfile.open(fileobj=archive, mode="r:gz") as tar:
            names = tar.getnames()
        assert all("uploads" not in n for n in names), names
        assert "calendar_styles/modern.json" in names, names


def test_pagination_does_not_drop_objects():
    with S3Backend() as s3:
        for i in range(7):
            s3.put("holidays/en-IN", str(2030 + i), {"i": i})
        s3.client.page_size = 2
        stats, _ = _archive(s3)
        assert stats["objects"] == 7, stats


def test_s3_failure_raises_instead_of_writing_a_partial_archive():
    with S3Backend() as s3:
        _seed(s3)
        from services.tests.fake_s3 import FakeClientError
        s3.client.get_error = FakeClientError("InternalError", 500)
        try:
            _archive(s3)
        except FakeClientError:
            return
        raise AssertionError("a failed read must fail the backup")


def test_non_s3_backend_is_a_noop():
    assert export_ops_config(LocalStorage(), io.BytesIO()) is None


def test_restore_ignores_unsafe_members_and_stays_under_prefix():
    with S3Backend() as s3:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for name in ("../../uploads/evil.json", "/abs.json", "a/../../b.json", "ok/one.json"):
                info = tarfile.TarInfo(name)
                info.size = 2
                tar.addfile(info, io.BytesIO(b"{}"))
            link = tarfile.TarInfo("link.json")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            tar.addfile(link)
        buf.seek(0)
        out = restore_ops_config(s3.storage, buf)
        assert out == {"restored": 1, "tombstones": 0, "skipped": 4}, out
        assert list(s3.client.objects) == ["product-editor/ops-config/ok/one.json"], s3.client.objects


def test_dry_run_writes_nothing():
    with S3Backend() as s3:
        _seed(s3)
        _, archive = _archive(s3)
        s3.client.objects.clear()
        out = restore_ops_config(s3.storage, archive, dry_run=True)
        assert out["restored"] == 4 and not s3.client.objects


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print(f"  ok  {name}")
    print(f"\n{passed} ops-config-backup tests passed")
