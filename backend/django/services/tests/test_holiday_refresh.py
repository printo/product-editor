"""
Tests that the annual holiday refresh (`manage.py refresh_holidays`) merges
into and writes the data the preview and print actually read.

It used to be `scripts/refresh-holidays.py`, reading and writing
`storage/holidays/` on local disk only. Under STORAGE_BACKEND=s3 (prod) that
file is only the git-seeded default: once ops had PUT a year, the refresh
merged into the stale seed, wrote the result back to disk, and every read
kept serving the S3 object — the refresh was silently ignored.

Nager.Date is stubbed; S3 is the in-memory fake from fake_s3.py.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_holiday_refresh
"""
from __future__ import annotations

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from services import holiday_refresh  # noqa: E402
from services.calendar_holidays import load_holidays_for_year  # noqa: E402
from services.tests.fake_s3 import FakeClientError, S3Backend  # noqa: E402

NAGER = [
    {"date": "2031-01-26", "localName": "Republic Day", "types": ["Public"]},
    {"date": "2031-08-15", "localName": "Independence Day", "types": ["Public"]},
]
SEED = {"year": 2031, "locale": "en-IN", "events": [
    {"date": "2031-01-26", "name": "Republic Day", "type": "national"},
    {"date": "2031-10-24", "name": "Diwali", "type": "festival"},
]}


def _run(dry_run=False, fetch=lambda year, country: NAGER, locale="en-IN", year=2031):
    lines = []
    code = holiday_refresh.refresh(locale, year, None, dry_run,
                                   fetch=fetch, out=lines.append, err=lines.append)
    return code, lines


def _names(payload):
    return [ev["name"] for ev in payload["events"]]


def test_refresh_merges_into_the_s3_copy_not_the_seed():
    with S3Backend() as b:
        seed_path = b.seed_local("holidays/en-IN/2031.json", SEED)
        with open(seed_path, "rb") as f:
            seed_bytes = f.read()
        b.put("holidays", "en-IN/2031", {"events": [
            {"date": "2031-03-01", "name": "Company Day", "type": "observance"},
        ]})

        code, lines = _run()
        assert code == 0, lines
        stored = b.stored_json("holidays", "en-IN/2031")
        # The ops edit survives; the seed's Diwali was never part of the S3 year.
        assert _names(stored) == ["Republic Day", "Company Day", "Independence Day"], stored
        assert [ev["name"] for ev in load_holidays_for_year("en-IN", 2031)] == _names(stored)
        # The git-tracked seed is untouched.
        with open(seed_path, "rb") as f:
            assert f.read() == seed_bytes


def test_refresh_of_a_never_edited_year_keeps_the_seeds_custom_entries():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", SEED)
        code, lines = _run()
        assert code == 0, lines
        stored = b.stored_json("holidays", "en-IN/2031")
        assert _names(stored) == ["Republic Day", "Independence Day", "Diwali"], stored
        assert stored["year"] == 2031 and stored["locale"] == "en-IN"
        assert stored["_meta"]["lastRefreshed"].endswith("Z")


def test_refresh_of_a_deleted_year_recreates_it_from_nager_only():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", SEED)
        b.storage.delete_calendar_asset("holidays", "en-IN/2031")
        code, lines = _run()
        assert code == 0, lines
        assert _names(b.stored_json("holidays", "en-IN/2031")) == ["Republic Day", "Independence Day"]


def test_unreadable_existing_data_is_never_overwritten():
    # Merging into "nothing" would replace the year with the national holidays
    # alone and lose every custom entry.
    for setup in (
        lambda b: setattr(b.client, "get_error", FakeClientError("InternalError", 500)),
        lambda b: b.put("holidays", "en-IN/2031", b"{not json"),
        lambda b: b.put("holidays", "en-IN/2031", b"[1, 2]"),
        lambda b: b.put("holidays", "en-IN/2031", b'{"events": {"not": "a list"}}'),
    ):
        with S3Backend() as b:
            b.seed_local("holidays/en-IN/2031.json", SEED)
            setup(b)
            before = dict(b.client.objects)
            code, lines = _run()
            assert code == holiday_refresh.EXISTING_UNREADABLE, (code, lines)
            assert b.client.objects == before, b.client.objects


def test_dry_run_and_failed_fetch_write_nothing():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", SEED)
        assert _run(dry_run=True)[0] == 0
        assert _run(fetch=lambda year, country: [])[0] == holiday_refresh.NOTHING_TO_DO
        assert b.client.objects == {}, b.client.objects


def test_bogus_locale_or_year_never_reaches_storage():
    with S3Backend() as b:
        for locale, year in (("../etc", 2031), ("en-IN/../x", 2031), ("en-IN", 3000)):
            code, lines = _run(locale=locale, year=year)
            assert code == holiday_refresh.NOTHING_TO_DO, (locale, year, lines)
        assert b.client.reads == [] and b.client.objects == {}


def test_nager_type_mapping_is_unchanged():
    # Carried over verbatim from scripts/refresh-holidays.py — order matters.
    def evtype(types):
        return holiday_refresh.normalize_nager_event(
            {"date": "2031-01-01", "localName": "X", "types": types})["type"]

    assert evtype(["Public"]) == "national"
    assert evtype(["Bank", "Religious"]) == "observance"
    assert evtype(["School"]) == "observance"
    assert evtype(["Religious"]) == "religious"
    assert evtype([]) == "observance"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} holiday-refresh tests passed.")
