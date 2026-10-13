"""
Append-only record of order erasures, so a database restore cannot bring an
erased order back.

`pg_dump` sets on the prod host outlive an order purge. Restoring one resurrects
rows the customer had erased. This ledger lives OUTSIDE Postgres, in the
bind-mounted STORAGE_ROOT, so a restore cannot roll it back. `reapply_purges`
replays the entries newer than the dump over the restored database.

A line holds only an HMAC of the order id (scoped to an API key, or "*" for an
all-tenant purge) and a timestamp: the ledger is not a second copy of what was
erased. The HMAC key derives from SECRET_KEY, so rotating SECRET_KEY orphans
existing entries (a restore would then not re-erase them). Pure of the ORM so it
is testable without a database.
"""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Iterable, List, Optional, Set, Tuple

from django.conf import settings

logger = logging.getLogger(__name__)

LEDGER_FILENAME = "purge_ledger.jsonl"
ALL_TENANTS = "*"


def ledger_path() -> str:
    return os.path.join(settings.STORAGE_ROOT, LEDGER_FILENAME)


def _hmac_key() -> bytes:
    return hmac.new(settings.SECRET_KEY.encode(), b"purge-ledger/v1", hashlib.sha256).digest()


def order_digest(order_id: str, key_name: Optional[str]) -> str:
    """Stable, non-reversible id for an erasure scope. key_name None = every key."""
    msg = f"{key_name or ALL_TENANTS}\n{order_id}".encode()
    return hmac.new(_hmac_key(), msg, hashlib.sha256).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(dt_timezone.utc)


def record_purge(order_id: str, key_name: Optional[str] = None, now: Optional[datetime] = None) -> bool:
    """Append one entry. Returns False (and logs) on failure: an erasure must
    not fail because its ledger line could not be written."""
    stamp = (now or _utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = json.dumps({"h": order_digest(order_id, key_name), "at": stamp}) + "\n"
    try:
        os.makedirs(os.path.dirname(ledger_path()), exist_ok=True)
        with open(ledger_path(), "a", encoding="utf-8") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
        return True
    except OSError as exc:
        logger.error("Purge ledger write failed for an erased order: %s", exc)
        return False


def parse_stamp(value: str) -> datetime:
    """ISO-8601 (with Z) or the backup set's 20261013T031500Z form."""
    value = value.strip()
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=dt_timezone.utc)
        except ValueError:
            continue
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt_timezone.utc)


def read_entries(since: Optional[datetime] = None) -> List[dict]:
    """Entries at or after `since`; malformed lines are skipped, not fatal."""
    path = ledger_path()
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            try:
                entry = json.loads(raw)
                at = parse_stamp(entry["at"])
                entry["_at"] = at
                entry["h"]
            except (ValueError, KeyError, TypeError):
                continue
            if since is None or at >= since:
                out.append(entry)
    return out


def plan_replay(entries: Iterable[dict], rows: Iterable[Tuple[str, Optional[str]]]) -> Set[Tuple[str, Optional[str]]]:
    """Which (order_id, scope) the restored database must erase again.

    `rows` are the (order_id, api_key name) pairs found in the restored tables.
    An all-tenant entry wins (scope None); otherwise a key-scoped one matches
    only its own key, so another key's order with the same id is left alone.
    """
    hashes = {e["h"] for e in entries}
    plan: Set[Tuple[str, Optional[str]]] = set()
    for order_id, key_name in rows:
        if not order_id:
            continue
        if order_digest(order_id, None) in hashes:
            plan.add((order_id, None))
        elif order_digest(order_id, key_name) in hashes:
            plan.add((order_id, key_name))
    return plan


def trim(retention_days: int, now: Optional[datetime] = None) -> int:
    """Drop entries older than the retention; returns how many were removed.
    Must outlast the longest backup that still holds customer data (7 days)."""
    path = ledger_path()
    if not os.path.exists(path):
        return 0
    cutoff = (now or _utcnow()) - timedelta(days=retention_days)
    removed = 0
    with open(path, "r+", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        keep = []
        for raw in fh:
            try:
                at = parse_stamp(json.loads(raw)["at"])
            except (ValueError, KeyError, TypeError):
                removed += 1
                continue
            if at >= cutoff:
                keep.append(raw if raw.endswith("\n") else raw + "\n")
            else:
                removed += 1
        if removed:
            fh.seek(0)
            fh.truncate()
            fh.writelines(keep)
            fh.flush()
            os.fsync(fh.fileno())
    return removed
