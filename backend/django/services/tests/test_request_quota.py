"""
Pins the per-key daily request cap (services/request_quota.py), the
enforcement behind APIKey.max_requests_per_day.

DB-free: the cache is a dict-backed stand-in. The DB-backed half — a real key
answering 429 on the third request — is api/tests/test_apikey_quota.py.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from services.request_quota import (  # noqa: E402
    day_key,
    is_over_quota,
    record_request,
    requests_today,
    seconds_until_next_day,
)


class FakeCache:
    def __init__(self):
        self.store = {}

    def get(self, key):
        return self.store.get(key)

    def add(self, key, value, timeout=None):
        if key in self.store:
            return False
        self.store[key] = value
        return True

    def incr(self, key):
        if key not in self.store:
            raise ValueError(key)
        self.store[key] += 1
        return self.store[key]


class BrokenCache:
    def get(self, key):
        raise ConnectionError("redis down")

    def add(self, key, value, timeout=None):
        raise ConnectionError("redis down")

    def incr(self, key):
        raise ConnectionError("redis down")


NOON_UTC = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)


def _key(cap):
    return SimpleNamespace(id=7, max_requests_per_day=cap)


def test_no_cap_is_never_over_quota():
    cache = FakeCache()
    for _ in range(50):
        record_request(7, NOON_UTC, cache)
    assert not is_over_quota(_key(None), NOON_UTC, cache)


def test_cap_is_reached_at_exactly_the_number_set():
    cache = FakeCache()
    key = _key(2)
    assert not is_over_quota(key, NOON_UTC, cache)
    record_request(7, NOON_UTC, cache)
    assert not is_over_quota(key, NOON_UTC, cache), "one call made, one left"
    record_request(7, NOON_UTC, cache)
    assert is_over_quota(key, NOON_UTC, cache), "cap of 2 reached after 2 calls"


def test_zero_cap_blocks_the_first_call():
    assert is_over_quota(_key(0), NOON_UTC, FakeCache())


def test_counter_is_per_key_and_per_ist_day():
    cache = FakeCache()
    record_request(7, NOON_UTC, cache)
    record_request(8, NOON_UTC, cache)
    assert requests_today(7, NOON_UTC, cache) == 1
    assert requests_today(8, NOON_UTC, cache) == 1
    # 18:29 UTC is still Oct 13 in IST; 18:30 UTC is Oct 14.
    before = datetime(2026, 10, 13, 18, 29, 59, tzinfo=timezone.utc)
    after = datetime(2026, 10, 13, 18, 30, 0, tzinfo=timezone.utc)
    assert day_key(7, before).endswith("2026-10-13")
    assert day_key(7, after).endswith("2026-10-14")
    assert requests_today(7, after, cache) == 0, "a new IST day starts from zero"


def test_retry_after_counts_down_to_ist_midnight():
    # 18:00 UTC = 23:30 IST → 30 minutes to go.
    assert seconds_until_next_day(datetime(2026, 10, 13, 18, 0, tzinfo=timezone.utc)) == 1800
    # Never zero, even one second before midnight.
    assert seconds_until_next_day(datetime(2026, 10, 13, 18, 29, 59, tzinfo=timezone.utc)) == 1


def test_a_broken_cache_fails_open():
    cache = BrokenCache()
    assert requests_today(7, NOON_UTC, cache) == 0
    assert record_request(7, NOON_UTC, cache) is None
    assert not is_over_quota(_key(1), NOON_UTC, cache)


def test_garbage_counter_value_reads_as_zero():
    cache = FakeCache()
    cache.store[day_key(7, NOON_UTC)] = "not-a-number"
    assert requests_today(7, NOON_UTC, cache) == 0


def test_middleware_counts_only_audited_non_429_requests():
    from api.middleware import APIRequestLoggingMiddleware

    mw = APIRequestLoggingMiddleware(lambda r: None)
    key = SimpleNamespace(id=7)
    calls = []
    with patch("services.request_quota.record_request", side_effect=lambda kid, now: calls.append(kid)):
        req = SimpleNamespace(path="/api/layouts", _api_auth_key=key)
        mw._count_toward_quota(req, SimpleNamespace(status_code=200))
        mw._count_toward_quota(req, SimpleNamespace(status_code=429))  # the cap answering
        mw._count_toward_quota(SimpleNamespace(path="/api/health", _api_auth_key=key), SimpleNamespace(status_code=200))
        mw._count_toward_quota(SimpleNamespace(path="/api/upload/abc/chunk", _api_auth_key=key), SimpleNamespace(status_code=200))
        mw._count_toward_quota(SimpleNamespace(path="/api/layouts"), SimpleNamespace(status_code=200))  # anonymous
    assert calls == [7], f"only the audited, authenticated, non-429 call counts: {calls}"


def test_middleware_counter_failure_never_raises():
    from api.middleware import APIRequestLoggingMiddleware

    mw = APIRequestLoggingMiddleware(lambda r: None)
    with patch("services.request_quota.record_request", side_effect=RuntimeError("boom")):
        mw._count_toward_quota(SimpleNamespace(path="/api/layouts", _api_auth_key=SimpleNamespace(id=7)), SimpleNamespace(status_code=200))


if __name__ == "__main__":
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"  OK  {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {fn.__name__}: {exc!r}")
    print(f"\n{len(funcs) - failed}/{len(funcs)} request-quota tests passed")
    sys.exit(1 if failed else 0)
