"""Per-key daily request cap — the enforcement behind APIKey.max_requests_per_day.

The number ops type into that admin field is how many audited API calls the
key may make per IST calendar day; blank means no cap. The counter lives in
the Django cache (Redis), one entry per key per day, and is advanced by
APIRequestLoggingMiddleware for exactly the requests the audit trail records,
so the cap and the trail count the same thing. BearerTokenAuthentication
reads it and answers 429 once the cap is reached.

Everything here fails open: a cache that cannot be read or written never
blocks a request. Losing the counter (Redis restart, eviction) resets the
day's count, which under-enforces rather than locking a partner out.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

DAY_TZ = ZoneInfo("Asia/Kolkata")
COUNTER_TTL_SECONDS = 48 * 3600


def _default_cache():
    from django.core.cache import cache
    return cache


def day_key(api_key_id, now: datetime) -> str:
    return f"apikey_rpd:{api_key_id}:{now.astimezone(DAY_TZ).date().isoformat()}"


def seconds_until_next_day(now: datetime) -> int:
    local = now.astimezone(DAY_TZ)
    next_midnight = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, int((next_midnight - local).total_seconds()))


def requests_today(api_key_id, now: datetime, cache=None) -> int:
    cache = cache if cache is not None else _default_cache()
    try:
        value = cache.get(day_key(api_key_id, now))
    except Exception as exc:  # noqa: BLE001 — fail open
        logger.warning("request quota read failed for key %s: %s", api_key_id, exc)
        return 0
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def is_over_quota(api_key, now: datetime, cache=None) -> bool:
    """True when the key has a cap and today's count has reached it."""
    cap = getattr(api_key, "max_requests_per_day", None)
    if cap is None:
        return False
    return requests_today(api_key.id, now, cache) >= cap


def record_request(api_key_id, now: datetime, cache=None) -> int | None:
    """Advance today's counter; returns the new count, or None if the cache failed."""
    cache = cache if cache is not None else _default_cache()
    key = day_key(api_key_id, now)
    try:
        cache.add(key, 0, timeout=COUNTER_TTL_SECONDS)
        return cache.incr(key)
    except Exception as exc:  # noqa: BLE001 — fail open
        logger.warning("request quota counter failed for %s: %s", key, exc)
        return None
