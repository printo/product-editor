"""
Jobs submitted per day, split dashboard vs embed, for `CeleryMonitoringView`.

The source is the `APIRequest` audit trail (accepted `POST /api/editor/render`),
not `RenderJob`. A RenderJob is deleted by cascade when its CanvasData expires,
so it only remembers about EXPORT_RETENTION_DAYS; the audit rows live for
API_AUDIT_RETENTION_DAYS (default 90). Days before audit logging began, or older
than that retention, read 0 — an absence of records, not a quiet day.

The dashboard/embed split rides on `auth_source`, the name of the API key that
submitted: the internal proxy presents the shared internal key, while the embed
proxy injects the partner's own key from the session.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo

# Customers order in Indian business hours; a UTC day would cut the busy period in two.
DAY_TZ = ZoneInfo("Asia/Kolkata")

DEFAULT_WINDOW_DAYS = 14

# Prod has no separate INTERNAL key row: while INTERNAL_API_KEY still equals
# DIRECT_API_KEY the entrypoint skips seeding it, and dashboard traffic resolves
# to DIRECT. So DIRECT is where dashboard jobs land today, but it also carries QA
# embed sessions minted with the DIRECT key — treat the dashboard figure as an
# upper bound. Anything else is a partner key, i.e. an embed session.
DASHBOARD_AUTH_SOURCES = frozenset({"DIRECT", "INTERNAL"})

RENDER_ENDPOINT = "/api/editor/render"


def window_days(now: datetime, days: int = DEFAULT_WINDOW_DAYS) -> list[date]:
    """The last `days` calendar days ending on `now`'s IST date, oldest first."""
    today = now.astimezone(DAY_TZ).date()
    return [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def bucket_counts(
    rows: Iterable[tuple[date, str, int]], days: list[date],
) -> dict[str, Any]:
    """Fold (day, auth_source, count) rows into one entry per day of the window.

    Every day appears, zero-filled, so a gap in embed traffic is visible as a
    gap rather than as a missing row. Rows outside the window are ignored.
    """
    per_day = {d: {"dashboard": 0, "embed": 0} for d in days}
    by_source: dict[str, int] = {}
    for day, source, n in rows:
        if day not in per_day:
            continue
        label = source or "anonymous"
        flow = "dashboard" if label in DASHBOARD_AUTH_SOURCES else "embed"
        per_day[day][flow] += n
        by_source[label] = by_source.get(label, 0) + n
    return {
        "timezone": "Asia/Kolkata",
        "days": [
            {
                "date": d.isoformat(),
                "dashboard": per_day[d]["dashboard"],
                "embed": per_day[d]["embed"],
                "total": per_day[d]["dashboard"] + per_day[d]["embed"],
            }
            for d in days
        ],
        "by_source": dict(sorted(by_source.items(), key=lambda kv: -kv[1])),
    }


def jobs_per_day(now: datetime | None = None, days: int = DEFAULT_WINDOW_DAYS) -> dict[str, Any]:
    """Query the audit trail and return the monitor block."""
    from django.db.models import Count
    from django.db.models.functions import TruncDate
    from django.utils import timezone

    from api.models import APIRequest

    now = now or timezone.now()
    window = window_days(now, days)
    start = datetime.combine(window[0], datetime.min.time(), tzinfo=DAY_TZ)
    rows = (
        APIRequest.objects.filter(
            created_at__gte=start,
            method="POST",
            endpoint=RENDER_ENDPOINT,
            status_code=202,
        )
        .annotate(day=TruncDate("created_at", tzinfo=DAY_TZ))
        .values_list("day", "auth_source")
        .annotate(n=Count("id"))
    )
    return bucket_counts(rows, window)
