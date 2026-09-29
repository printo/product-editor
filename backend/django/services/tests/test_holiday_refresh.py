"""
Tests that the annual holiday refresh (`manage.py refresh_holidays`) merges
into and writes the data the preview and print actually read.

It used to be `scripts/refresh-holidays.py`, reading and writing
`storage/holidays/` on local disk only. Under STORAGE_BACKEND=s3 (prod) that
file is only the git-seeded default: once ops had PUT a year, the refresh
merged into the stale seed, wrote the result back to disk, and every read
kept serving the S3 object — the refresh was silently ignored.

Its source used to be the Nager.Date API, which has no data for India (HTTP
204), so the en-IN refresh never fetched a single event and the 2027-2030
seeds kept fixed-date holidays only. It now reads the offline `holidays`
package; the India cases below run against it for real (pinned in
requirements.txt, so these dates only move on a deliberate bump).

Storage cases stub the source; S3 is the in-memory fake from fake_s3.py.

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

STUB = [
    {"date": "2031-01-26", "name": "Republic Day", "type": "national", "color": "#DC2626"},
    {"date": "2031-08-15", "name": "Independence Day", "type": "national", "color": "#DC2626"},
]
SEED = {"year": 2031, "locale": "en-IN", "events": [
    {"date": "2031-01-26", "name": "Republic Day", "type": "national"},
    {"date": "2031-10-24", "name": "Diwali", "type": "festival"},
]}


def _run(dry_run=False, fetch=lambda year, country, locale: STUB, locale="en-IN", year=2031):
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


def test_refresh_of_a_deleted_year_recreates_it_from_the_source_only():
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
        assert _run(fetch=lambda year, country, locale: [])[0] == holiday_refresh.NOTHING_TO_DO
        assert b.client.objects == {}, b.client.objects


def test_bogus_locale_or_year_never_reaches_storage():
    with S3Backend() as b:
        for locale, year in (("../etc", 2031), ("en-IN/../x", 2031), ("en-IN", 3000)):
            code, lines = _run(locale=locale, year=year)
            assert code == holiday_refresh.NOTHING_TO_DO, (locale, year, lines)
        assert b.client.reads == [] and b.client.objects == {}


def _india(year):
    return holiday_refresh.fetch_public_holidays(year, "IN", "en-IN")


def _on(events, day):
    return [ev["name"] for ev in events if ev["date"] == day]


def test_india_has_its_moving_festivals():
    events = _india(2027)
    assert _on(events, "2027-03-22") == ["Holi"], events
    assert _on(events, "2027-03-26") == ["Good Friday"]
    assert _on(events, "2027-10-09") == ["Dussehra"]
    assert _on(events, "2027-10-29") == ["Diwali"]
    # Two holidays on one day are two events, not one "A; B" name.
    assert _on(events, "2027-08-15") == ["Independence Day", "Milad-un-Nabi"]
    # And the years the seeds stop at, and past them.
    assert _on(_india(2030), "2030-10-26") == ["Diwali"]
    assert _on(_india(2031), "2031-11-14") == ["Diwali"]


def test_india_names_match_the_seeds_and_types_are_set():
    events = _india(2027)
    by_name = {ev["name"]: ev for ev in events}
    # Seed names, so a refresh doesn't put a second pill on the same day.
    assert "Gandhi Jayanti" in by_name and "Mahatma Gandhi's Jayanti" not in by_name
    assert "Diwali (Deepavali)" not in by_name
    assert not [n for n in by_name if "estimated" in n or ";" in n], sorted(by_name)
    assert by_name["Republic Day"]["type"] == "national"
    assert by_name["Holi"]["type"] == "festival"
    assert by_name["Christmas"]["type"] == "religious"
    assert all(ev["color"] == holiday_refresh.TYPE_COLOR_DEFAULTS[ev["type"]] for ev in events)
    # Moon-sighting dates are flagged, not hidden.
    assert by_name["Id-ul-Fitr"].get("estimated") is True
    assert "estimated" not in by_name["Holi"]


def test_refreshing_a_fixed_date_seed_adds_festivals_without_duplicates():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2027.json", {"year": 2027, "locale": "en-IN", "events": [
            {"date": "2027-01-01", "name": "New Year", "type": "observance"},
            {"date": "2027-10-02", "name": "Gandhi Jayanti", "type": "national"},
            {"date": "2027-12-25", "name": "Christmas", "type": "religious"},
        ]})
        code = holiday_refresh.refresh("en-IN", 2027, out=lambda _: None, err=lambda _: None)
        assert code == 0
        stored = b.stored_json("holidays", "en-IN/2027")
        assert _on(stored["events"], "2027-10-02") == ["Gandhi Jayanti"], stored
        assert _on(stored["events"], "2027-12-25") == ["Christmas"]
        assert _on(stored["events"], "2027-01-01") == ["New Year"]  # custom entry kept
        assert "Diwali" in _names(stored)
        assert stored["_meta"]["source"].startswith("holidays ")


def test_a_stored_holiday_on_the_wrong_day_is_flagged_and_kept():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2026.json", {"events": [
            {"date": "2026-11-04", "name": "Diwali", "type": "festival"},
        ]})
        lines = []
        code = holiday_refresh.refresh("en-IN", 2026, fetch=lambda y, c, l: _india(2026),
                                       out=lines.append, err=lines.append)
        assert code == 0, lines
        assert _on(b.stored_json("holidays", "en-IN/2026")["events"], "2026-11-04") == ["Diwali"]
        assert any("Diwali: stored on 2026-11-04, source says 2026-11-08" in ln for ln in lines), lines


def test_uncovered_country_writes_nothing():
    with S3Backend() as b:
        assert holiday_refresh.fetch_public_holidays(2031, "ZZ", "en-ZZ") == []
        code = holiday_refresh.refresh("en-ZZ", 2031, "ZZ", out=lambda _: None, err=lambda _: None)
        assert code == holiday_refresh.NOTHING_TO_DO
        assert b.client.objects == {}


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} holiday-refresh tests passed.")
