"""
Tests for the jobs-per-day monitor block (services/jobs_per_day.py).

The query itself needs Postgres, so what is pinned here is the part that can be
wrong without any error: which day a job lands on, and which flow it counts to.

  * days are cut at IST midnight, not UTC — 20:00 UTC on the 29th is already
    01:30 on the 30th for the customer who placed the order
  * every day in the window is present, zero-filled, so "embed went quiet" reads
    as zeros rather than as missing rows
  * DIRECT and INTERNAL are the dashboard; any other key name is an embed partner
  * rows outside the window are ignored rather than raising or extending it

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \\
        python -m services.tests.test_jobs_per_day
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from services.jobs_per_day import bucket_counts, window_days

D = date


def test_window_ends_on_the_ist_date_not_the_utc_date():
    # 20:00 UTC on Sep 29 is 01:30 IST on Sep 30.
    now = datetime(2026, 9, 29, 20, 0, tzinfo=timezone.utc)
    days = window_days(now, 3)
    assert days == [D(2026, 9, 28), D(2026, 9, 29), D(2026, 9, 30)], days


def test_window_is_oldest_first_and_the_requested_length():
    now = datetime(2026, 9, 30, 6, 0, tzinfo=timezone.utc)
    days = window_days(now, 14)
    assert len(days) == 14
    assert days == sorted(days)
    assert days[-1] == D(2026, 9, 30)


def test_every_day_is_present_and_zero_filled():
    days = [D(2026, 9, 28), D(2026, 9, 29), D(2026, 9, 30)]
    out = bucket_counts([(D(2026, 9, 29), "DIRECT", 5)], days)
    assert [d["date"] for d in out["days"]] == ["2026-09-28", "2026-09-29", "2026-09-30"]
    assert out["days"][0] == {"date": "2026-09-28", "dashboard": 0, "embed": 0, "total": 0}
    assert out["days"][1] == {"date": "2026-09-29", "dashboard": 5, "embed": 0, "total": 5}


def test_direct_and_internal_are_dashboard_and_partner_keys_are_embed():
    days = [D(2026, 9, 30)]
    rows = [
        (D(2026, 9, 30), "DIRECT", 19),
        (D(2026, 9, 30), "INTERNAL", 2),
        (D(2026, 9, 30), "Printo.in Storefront", 1),
        (D(2026, 9, 30), "TESTING", 3),
    ]
    day = bucket_counts(rows, days)["days"][0]
    assert day["dashboard"] == 21, day
    assert day["embed"] == 4, day
    assert day["total"] == 25, day


def test_rows_from_several_sources_on_one_day_accumulate():
    days = [D(2026, 9, 30)]
    rows = [(D(2026, 9, 30), "DIRECT", 10), (D(2026, 9, 30), "DIRECT", 4)]
    assert bucket_counts(rows, days)["days"][0]["dashboard"] == 14


def test_rows_outside_the_window_are_ignored():
    days = [D(2026, 9, 29), D(2026, 9, 30)]
    rows = [(D(2026, 9, 1), "DIRECT", 99), (D(2026, 10, 5), "DIRECT", 99)]
    out = bucket_counts(rows, days)
    assert [d["total"] for d in out["days"]] == [0, 0]
    assert out["by_source"] == {}


def test_by_source_totals_the_window_largest_first():
    days = [D(2026, 9, 29), D(2026, 9, 30)]
    rows = [
        (D(2026, 9, 29), "Printo.in Storefront", 2),
        (D(2026, 9, 29), "DIRECT", 30),
        (D(2026, 9, 30), "DIRECT", 20),
    ]
    by_source = bucket_counts(rows, days)["by_source"]
    assert by_source == {"DIRECT": 50, "Printo.in Storefront": 2}
    assert list(by_source) == ["DIRECT", "Printo.in Storefront"]


def test_a_blank_source_is_reported_as_anonymous_and_counts_as_embed():
    days = [D(2026, 9, 30)]
    out = bucket_counts([(D(2026, 9, 30), "", 1)], days)
    assert out["by_source"] == {"anonymous": 1}
    assert out["days"][0]["embed"] == 1


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} jobs-per-day tests passed.")
