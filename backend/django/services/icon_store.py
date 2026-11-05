"""
Icons for the editor's Icons tab, served from our own cache.

The editor used to load every icon tile straight from api.iconify.design, in
the customer's browser: sixty requests a search. Iconify (behind Cloudflare)
limits each internet address to roughly 180 requests in a few minutes and then
answers 429 for about five, so tiles turned into broken images, for a whole
office at once since it shares one address, and a design with icons could not
be submitted while the block lasted (found 2026-11-05).

Now the browser asks us:

  * `icon_svg(prefix, name)` — process memory, then the durable cache in
    storage (`icon-cache/<prefix>/<name>.svg`; S3 on prod), then Iconify, once.
    An icon never changes, so it is kept for good.
  * `search(query)` — the names Iconify finds, kept a week in the Django
    cache. A search also warms the icons it found, one request per icon SET
    (Iconify's `<prefix>.json?icons=a,b,c`), not one per icon, so the tiles
    that follow are cache hits.

Everything we fetch goes through one spending cap (`ICON_UPSTREAM_BUDGET`
requests per five minutes, for the whole server): past it we answer
`IconUnavailable` (503) instead of risking Iconify blocking the server's own
address, which would break uncached icons for every customer. Only
api.iconify.design is ever contacted, redirects are refused, names are checked
against a strict pattern, and each SVG passes the same safety check as an
uploaded mask before it is stored or served.
"""
from __future__ import annotations

import json
import logging
import math
import re
import threading
import time
from collections import OrderedDict
from typing import Callable, Iterable, Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)

API = "https://api.iconify.design"
# (connect, read) seconds.
TIMEOUT = (4, 10)
MAX_SVG_BYTES = 512 * 1024
MAX_JSON_BYTES = 4 * 1024 * 1024
SEARCH_LIMIT = 60
SEARCH_TTL = 7 * 24 * 3600
MISSING_TTL = 24 * 3600
BUDGET_WINDOW = 300
DEFAULT_BUDGET = 100
WARM_WORKERS = 8

_PREFIX_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,49}$")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")
_QUERY_RE = re.compile(r"^[\w .+&'-]{2,50}$", re.UNICODE)


class IconNotFound(Exception):
    """No such icon (or not one we are willing to serve)."""


class IconUnavailable(Exception):
    """The icon could not be fetched just now: Iconify is unreachable, we are
    at the spending cap, or the cache could not answer. Try again later."""


def valid_icon(prefix: str, name: str) -> bool:
    return bool(_PREFIX_RE.match(prefix or "") and _NAME_RE.match(name or ""))


def _cache_name(prefix: str, name: str) -> str:
    return f"{prefix}/{name}.svg"


# ── Seams for tests ─────────────────────────────────────────────────────────


def _http_get(url: str, max_bytes: int):
    """(status, body) for a GET of an Iconify URL."""
    import requests

    with requests.get(url, timeout=TIMEOUT, allow_redirects=False, stream=True,
                      headers={"User-Agent": "product-editor-icon-cache/1"}) as resp:
        body = bytearray()
        for chunk in resp.iter_content(64 * 1024):
            body += chunk
            if len(body) > max_bytes:
                raise IconUnavailable(f"Response over {max_bytes} bytes from Iconify")
        return resp.status_code, bytes(body)


http_get: Callable[[str, int], tuple] = _http_get


def _default_cache():
    from django.core.cache import cache
    return cache


get_cache: Callable[[], object] = _default_cache


def _budget() -> int:
    from django.conf import settings
    return int(getattr(settings, "ICON_UPSTREAM_BUDGET", DEFAULT_BUDGET))


# ── Spending cap ────────────────────────────────────────────────────────────


def _spend() -> None:
    """Count one request to Iconify against the server-wide cap. Raises
    IconUnavailable when the window is spent. A cache that can't count lets
    the request through: an outage of ours must not look like one of theirs."""
    key = f"icon-upstream:{int(time.time()) // BUDGET_WINDOW}"
    try:
        cache = get_cache()
        if cache.add(key, 1, BUDGET_WINDOW * 2):
            return
        if cache.incr(key) > _budget():
            raise IconUnavailable("Icon fetch budget spent for this window")
    except IconUnavailable:
        raise
    except Exception:  # noqa: BLE001
        logger.warning("Icon budget counter unavailable; fetching anyway", exc_info=True)


def _fetch(url: str, max_bytes: int) -> tuple[int, bytes]:
    _spend()
    try:
        status, body = http_get(url, max_bytes)
    except IconUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — network errors, timeouts
        raise IconUnavailable(f"Iconify unreachable: {exc}") from exc
    if status == 429 or status >= 500:
        raise IconUnavailable(f"Iconify answered {status}")
    return status, body


# ── One icon ────────────────────────────────────────────────────────────────

_MEMORY: "OrderedDict[str, bytes]" = OrderedDict()
_MEMORY_MAX = 2000
_MEMORY_LOCK = threading.Lock()


def _remember(cache_name: str, data: bytes) -> None:
    with _MEMORY_LOCK:
        _MEMORY[cache_name] = data
        _MEMORY.move_to_end(cache_name)
        while len(_MEMORY) > _MEMORY_MAX:
            _MEMORY.popitem(last=False)


def _stored(cache_name: str) -> Optional[bytes]:
    """The icon from memory or storage; None when it isn't cached."""
    from services.storage import IconCacheUnavailable, get_storage

    with _MEMORY_LOCK:
        data = _MEMORY.get(cache_name)
    if data is not None:
        return data
    try:
        data = get_storage().read_icon_file(cache_name)
    except FileNotFoundError:
        return None
    except IconCacheUnavailable as exc:
        raise IconUnavailable(str(exc)) from exc
    _remember(cache_name, data)
    return data


def _store(cache_name: str, data: bytes) -> None:
    """Best effort: we hold the icon, so a failed write costs a re-fetch
    later, not this request."""
    from services.storage import get_storage

    _remember(cache_name, data)
    try:
        get_storage().write_icon_file(cache_name, data)
    except Exception:  # noqa: BLE001
        logger.warning("Could not cache icon %s", cache_name, exc_info=True)


def _safe(data: bytes) -> bool:
    from services.svg_mask import validate_svg_mask

    try:
        validate_svg_mask(data, "Icons")
    except ValueError as exc:
        logger.warning("Refusing an icon that failed the SVG check: %s", exc)
        return False
    return True


def _missing_key(cache_name: str) -> str:
    return f"icon-missing:{cache_name}"


def icon_svg(prefix: str, name: str) -> bytes:
    """The icon's SVG. Raises IconNotFound or IconUnavailable."""
    if not valid_icon(prefix, name):
        raise IconNotFound(f"{prefix}:{name}")
    cache_name = _cache_name(prefix, name)
    data = _stored(cache_name)
    if data is not None:
        return data

    cache = get_cache()
    try:
        if cache.get(_missing_key(cache_name)):
            raise IconNotFound(f"{prefix}:{name}")
    except IconNotFound:
        raise
    except Exception:  # noqa: BLE001
        pass

    status, body = _fetch(f"{API}/{quote(prefix)}/{quote(name)}.svg", MAX_SVG_BYTES)
    if status != 200 or not _safe(body):
        try:
            cache.set(_missing_key(cache_name), 1, MISSING_TTL)
        except Exception:  # noqa: BLE001
            pass
        raise IconNotFound(f"{prefix}:{name}")
    _store(cache_name, body)
    return body


# ── Search ──────────────────────────────────────────────────────────────────


def search(query: str) -> list[str]:
    """Up to SEARCH_LIMIT icon names ("prefix:name") for `query`, and the
    icons themselves warmed into the cache. Raises ValueError for a query we
    won't send, IconUnavailable when Iconify can't be asked."""
    q = " ".join((query or "").lower().split())
    if not _QUERY_RE.match(q):
        raise ValueError("Search for two to fifty letters or numbers.")
    key = f"icon-search:{q}"
    cache = get_cache()
    try:
        cached = cache.get(key)
    except Exception:  # noqa: BLE001
        cached = None
    if cached is not None:
        return list(cached)

    status, body = _fetch(f"{API}/search?query={quote(q)}&limit={SEARCH_LIMIT}", MAX_JSON_BYTES)
    if status != 200:
        raise IconUnavailable(f"Iconify search answered {status}")
    try:
        found = json.loads(body).get("icons") or []
    except (ValueError, AttributeError) as exc:
        raise IconUnavailable(f"Iconify search was not JSON: {exc}") from exc
    names = [n for n in found if isinstance(n, str) and valid_icon(*_split(n))][:SEARCH_LIMIT]
    try:
        cache.set(key, names, SEARCH_TTL)
    except Exception:  # noqa: BLE001
        pass
    warm(names)
    return names


def _split(full_name: str) -> tuple[str, str]:
    prefix, _, name = full_name.partition(":")
    return prefix, name


def warm(names: Iterable[str]) -> int:
    """Fetch the icons that aren't cached yet, one request per icon set, and
    return how many were stored. Never raises: whatever is left is fetched one
    by one when its tile asks for it."""
    by_prefix: dict[str, list[str]] = {}
    for full in names:
        prefix, name = _split(full)
        if not valid_icon(prefix, name):
            continue
        try:
            if _stored(_cache_name(prefix, name)) is None:
                by_prefix.setdefault(prefix, []).append(name)
        except IconUnavailable:
            return 0
    if not by_prefix:
        return 0

    def one_set(item: tuple[str, list[str]]) -> int:
        prefix, wanted = item
        try:
            status, body = _fetch(f"{API}/{quote(prefix)}.json?icons={quote(','.join(wanted))}", MAX_JSON_BYTES)
        except IconUnavailable as exc:
            logger.info("Icon warm-up skipped %s: %s", prefix, exc)
            return 0
        if status != 200:
            return 0
        try:
            data = json.loads(body)
        except ValueError:
            return 0
        count = 0
        for name in wanted:
            svg = svg_from_set(data, name)
            if svg is not None and _safe(svg):
                _store(_cache_name(prefix, name), svg)
                count += 1
        return count

    # A search of sixty icons spans some forty sets; one after another that
    # took over five seconds, side by side about one.
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=WARM_WORKERS) as pool:
        return sum(pool.map(one_set, by_prefix.items()))


def svg_from_set(data: dict, name: str) -> Optional[bytes]:
    """The SVG Iconify itself serves for `name`, built from an icon-set
    answer; None for anything but a plain icon (an alias, or one that is
    flipped or rotated), which is left to the single-icon fetch."""
    icons = data.get("icons") if isinstance(data, dict) else None
    icon = icons.get(name) if isinstance(icons, dict) else None
    if not isinstance(icon, dict) or not isinstance(icon.get("body"), str):
        return None
    if icon.get("rotate") or icon.get("hFlip") or icon.get("vFlip"):
        return None

    def number(key: str, default: float) -> float:
        for source in (icon, data):
            value = source.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
        return default

    left, top = number("left", 0), number("top", 0)
    width, height = number("width", 16), number("height", 16)
    if width <= 0 or height <= 0:
        return None
    body = icon["body"]
    # Height is 1em and the width follows the shape, rounded up to a hundredth, as Iconify does.
    em = math.ceil(width / height * 100) / 100
    xlink = ' xmlns:xlink="http://www.w3.org/1999/xlink"' if "xlink:" in body else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg"{xlink} width="{em:g}em" height="1em" '
        f'viewBox="{left:g} {top:g} {width:g} {height:g}">{body}</svg>'
    ).encode()


def clear_memory() -> None:
    """For tests."""
    with _MEMORY_LOCK:
        _MEMORY.clear()
