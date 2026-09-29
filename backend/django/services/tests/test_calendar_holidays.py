"""
Tests that services.calendar_holidays re-reads holiday files on every call.

The loader used to sit behind a per-process `lru_cache` keyed on path. The
files are rewritten by `HolidaysView` PUT/DELETE, which runs in gunicorn, and
by `scripts/refresh-holidays.py` — neither can clear a Celery worker's memory.
So after an ops edit, every worker kept printing the old holidays until it
recycled, while the preview (via the view's Redis cache) showed the new ones.

Any in-process cache reintroduces that, so these pin the property directly:
a rewrite is visible on the very next call. The rewrites go through
`LocalStorage.write_calendar_asset`, the same atomic temp + rename the PUT
uses, and one keeps size and mtime identical so a cache keyed on
(path, mtime, size) would fail too — mtime granularity on some filesystems
and bind mounts is coarse enough for two quick edits to share a stamp.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_calendar_holidays
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile

import django
from django.conf import settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from services import calendar_holidays  # noqa: E402
from services.storage import LocalStorage  # noqa: E402

LOCALE = "en-IN"
YEAR = 2031


class _TempHolidays:
    """Point both the writer and the loader at a throwaway storage root."""

    def __enter__(self):
        self.root = tempfile.mkdtemp(prefix="pe-holidays-")
        self._storage_root = settings.STORAGE_ROOT
        settings.STORAGE_ROOT = self.root
        self.storage = LocalStorage()
        return self

    def __exit__(self, *exc):
        settings.STORAGE_ROOT = self._storage_root
        shutil.rmtree(self.root, ignore_errors=True)

    @property
    def path(self) -> str:
        return os.path.join(self.root, "holidays", LOCALE, f"{YEAR}.json")

    def put(self, names: list[str]) -> None:
        payload = {"events": [{"date": f"{YEAR}-01-{i + 1:02d}", "name": n}
                              for i, n in enumerate(names)]}
        self.storage.write_calendar_asset(
            "holidays", f"{LOCALE}/{YEAR}", json.dumps(payload).encode("utf-8"),
        )

    def delete(self) -> None:
        self.storage.delete_calendar_asset("holidays", f"{LOCALE}/{YEAR}")


def _names() -> list[str]:
    return [ev["name"] for ev in calendar_holidays.load_holidays_for_year(LOCALE, YEAR)]


def test_rewritten_file_is_reread():
    with _TempHolidays() as t:
        t.put(["Old Holiday"])
        assert _names() == ["Old Holiday"]
        t.put(["New Holiday", "Another One"])
        assert _names() == ["New Holiday", "Another One"]


def test_rewrite_with_identical_size_and_mtime_is_reread():
    with _TempHolidays() as t:
        t.put(["Holiday AAAA"])
        before = os.stat(t.path)
        assert _names() == ["Holiday AAAA"]

        t.put(["Holiday BBBB"])
        os.utime(t.path, ns=(before.st_atime_ns, before.st_mtime_ns))
        after = os.stat(t.path)
        assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)

        assert _names() == ["Holiday BBBB"]


def test_deleted_then_recreated_file_is_reread():
    with _TempHolidays() as t:
        t.put(["Before Delete"])
        assert _names() == ["Before Delete"]
        t.delete()
        assert _names() == []
        t.put(["After Recreate"])
        assert _names() == ["After Recreate"]


def test_returned_events_are_not_shared_between_calls():
    with _TempHolidays() as t:
        t.put(["Holiday"])
        first = calendar_holidays.load_holidays_for_year(LOCALE, YEAR)
        first[0]["name"] = "mutated by a caller"
        first.append({"date": f"{YEAR}-12-31", "name": "appended"})
        assert _names() == ["Holiday"]


def test_malformed_files_fall_back_to_empty():
    with _TempHolidays() as t:
        os.makedirs(os.path.dirname(t.path), exist_ok=True)
        for body in ("{not json", "[]", '{"events": "nope"}',
                     '{"events": [{"date": "2031-01-01"}, "x", {"name": "no date"}]}'):
            with open(t.path, "w") as f:
                f.write(body)
            assert calendar_holidays.load_holidays_for_year(LOCALE, YEAR) == [], body


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} calendar-holidays tests passed.")
