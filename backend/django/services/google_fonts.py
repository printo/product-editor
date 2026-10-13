"""
Print text overlays in the family the customer picked in the editor.

The editor's Font Family picker offers the ops-managed fonts list (`FontsView`,
`fonts.json`) and the preview loads each family from Google Fonts. The print
used to ignore `fontFamily` and set every overlay in the bundled Inter, so a
birthday script previewed as script and printed as Inter. This module gives the
print the same font file the preview drew with.

Resolution (`get_overlay_font(family, size_px, weight)`):

  1. No family, a CSS generic ('sans-serif', 'serif', …) or 'Inter' → the
     bundled Inter via services.fonts.get_font, as before. A generic renders
     in whatever the viewer's OS supplies, which a server can't reproduce.
  2. Process memory, then the durable cache in storage
     (`font-cache/<family-slug>/<weight>.ttf` — S3 on prod, STORAGE_ROOT
     locally), so a font is fetched from Google once, not once per container.
  3. Otherwise fetch it — only if the family is on the ops fonts list:
     `fonts.googleapis.com/css2?family=<family>:wght@<weight>` names a TTF on
     `fonts.gstatic.com` (Google hands a non-browser user agent truetype);
     both hosts are fixed, redirects are refused, every request has a timeout
     and the download a size cap. A family without that weight (Lobster has
     only 400) is asked for again with no weight, which returns its default
     face — the one a browser falls back to.

The weight axis of a variable font is set by tag (services.fonts.set_weight),
never by position: Inter's fvar order is [opsz, wght].

Failure policy: anything that stops us getting the font raises FontUnavailable.
Neither render_overlays nor the engine swallows it, so the render task retries
and, after its retries, fails the job — it never prints the overlay in Inter
behind the customer's back. That includes a family that is no longer on the
ops list and was never cached (ops removed it after the customer picked it, or
a crafted payload): retrying can't fix that, but neither can a silent Inter.
"""
from __future__ import annotations

import io
import logging
import math
import re
import threading
from typing import Callable, Iterable, Optional
from urllib.parse import quote, urlsplit

from PIL import ImageFont

from services.fonts import axis_records, get_font, set_weight

logger = logging.getLogger(__name__)

CSS_URL = "https://fonts.googleapis.com/css2"
FONT_HOST = "fonts.gstatic.com"
# (connect, read) seconds.
TIMEOUT = (5, 20)
MAX_CSS_BYTES = 64 * 1024
MAX_FONT_BYTES = 20 * 1024 * 1024

# Rendered by the browser from the OS, or by us from the bundled file.
_BUNDLED_FAMILIES = frozenset({
    "", "inter", "sans-serif", "serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
})
# Google family names are letters, digits and spaces ("M PLUS 1p", "IBM Plex Sans").
_FAMILY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$")
_SRC_RE = re.compile(r"src:\s*url\((https://[^)\s]+)\)\s*format\(['\"](truetype|opentype)['\"]\)")
_FONT_MAGIC = (b"\x00\x01\x00\x00", b"true", b"OTTO")


class FontUnavailable(Exception):
    """The overlay's font couldn't be obtained. The render must not go ahead
    in another font; the render task retries, then fails the job."""


def get_overlay_font(family: Optional[str], size_px: int, weight: int = 400) -> ImageFont.ImageFont:
    """The PIL font a text overlay prints in. Raises FontUnavailable."""
    name = " ".join((family or "").split())
    if name.lower() in _BUNDLED_FAMILIES:
        return get_font(size_px, weight=weight)

    if not _FAMILY_RE.match(name):
        raise FontUnavailable(f"Not a font family name: {family!r}")
    weight = _snap_weight(weight)
    size_px = max(1, int(size_px))

    key = (name.lower(), weight, size_px)
    font = _FONT_CACHE.get(key)
    if font is None:
        data = font_bytes(name, weight)
        try:
            font = ImageFont.truetype(io.BytesIO(data), size=size_px)
        except OSError as exc:
            raise FontUnavailable(f"{name} {weight}: unloadable font file: {exc}") from exc
        if not set_weight(font, axis_records(data), weight):
            logger.warning("Could not set weight %d on %s; using its default instance", weight, name)
        _FONT_CACHE[key] = font
    return font


def font_bytes(family: str, weight: int) -> bytes:
    """The TTF for family + weight: memory, then storage, then Google."""
    weight = _snap_weight(weight)
    name = cache_name(family, weight)
    data = _BYTES_CACHE.get(name)
    if data is not None:
        return data

    with _lock_for(name):
        data = _BYTES_CACHE.get(name)
        if data is not None:
            return data
        data = _read_cached(name)
        if data is None:
            if not _is_allowed(family):
                raise FontUnavailable(
                    f"{family!r} is not on the ops fonts list and isn't cached; not fetching it"
                )
            data = _fetch(family, weight)
            _write_cached(name, data)
        _BYTES_CACHE[name] = data
        return data


def cache_name(family: str, weight: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", family.lower()).strip("-")
    return f"{slug}/{_snap_weight(weight)}.ttf"


# ── Allowlist ───────────────────────────────────────────────────────────────


def _ops_fonts() -> Iterable[str]:
    """The ops fonts list. AssetNotFoundError means ops never saved one —
    nothing but the generics is allowed; an outage is FontUnavailable."""
    from services.asset_store import AssetNotFoundError, CalendarAssetUnavailable, read_asset_json

    try:
        data = read_asset_json("fonts", "fonts")
    except AssetNotFoundError:
        return ()
    except (CalendarAssetUnavailable, ValueError) as exc:
        raise FontUnavailable(f"Fonts list unreadable: {exc}") from exc
    return [f for f in data if isinstance(f, str)] if isinstance(data, list) else ()


# Swapped out by tests.
allowed_families: Callable[[], Iterable[str]] = _ops_fonts


def _is_allowed(family: str) -> bool:
    wanted = family.lower()
    return any(" ".join(f.split()).lower() == wanted for f in allowed_families())


# ── Durable cache ───────────────────────────────────────────────────────────


def _read_cached(name: str) -> Optional[bytes]:
    from services.storage import FontCacheUnavailable, get_storage

    try:
        data = get_storage().read_font_file(name)
    except FileNotFoundError:
        return None
    except FontCacheUnavailable as exc:
        raise FontUnavailable(str(exc)) from exc
    if not data.startswith(_FONT_MAGIC):
        logger.warning("Cached font %s is not a font file; fetching it again", name)
        return None
    return data


def _write_cached(name: str, data: bytes) -> None:
    """Best effort: we already hold the font, so a failed cache write costs a
    re-fetch later, not this print."""
    from services.storage import get_storage

    try:
        get_storage().write_font_file(name, data)
    except Exception:  # noqa: BLE001
        logger.warning("Could not cache font %s", name, exc_info=True)


# ── Google Fonts fetch ──────────────────────────────────────────────────────


def _http_get(url: str, max_bytes: int):
    """(status, body) for a GET. Swapped out by tests."""
    import requests

    with requests.get(url, timeout=TIMEOUT, allow_redirects=False, stream=True,
                      headers={"User-Agent": "product-editor-font-fetch/1"}) as resp:
        body = bytearray()
        for chunk in resp.iter_content(64 * 1024):
            body += chunk
            if len(body) > max_bytes:
                raise FontUnavailable(f"Response over {max_bytes} bytes from {urlsplit(url).netloc}")
        return resp.status_code, bytes(body)


http_get: Callable[[str, int], tuple] = _http_get


def _fetch(family: str, weight: int) -> bytes:
    family_q = quote(family, safe="")
    try:
        status, css = http_get(f"{CSS_URL}?family={family_q}:wght@{weight}", MAX_CSS_BYTES)
        if status == 400:
            # Google rejects a weight the family doesn't have; ask for its default face.
            status, css = http_get(f"{CSS_URL}?family={family_q}", MAX_CSS_BYTES)
    except FontUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — network errors, timeouts
        raise FontUnavailable(f"Google Fonts unreachable for {family!r}: {exc}") from exc
    if status != 200:
        raise FontUnavailable(f"Google Fonts answered {status} for {family!r}")

    url = _pick_src(css.decode("utf-8", "replace"))
    if url is None:
        raise FontUnavailable(f"No font file in Google's CSS for {family!r}")
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != FONT_HOST or parts.port not in (None, 443):
        raise FontUnavailable(f"Refusing font URL outside {FONT_HOST}: {url!r}")

    try:
        status, data = http_get(url, MAX_FONT_BYTES)
    except FontUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise FontUnavailable(f"Font download failed for {family!r}: {exc}") from exc
    if status != 200 or not data.startswith(_FONT_MAGIC):
        raise FontUnavailable(f"Font download for {family!r} returned {status}, not a font file")
    logger.info("Fetched %s %d from Google Fonts (%d bytes)", family, weight, len(data))
    return data


def _pick_src(css: str) -> Optional[str]:
    """The first upright face's font URL. Asked for one weight, Google returns
    one face for a non-browser user agent."""
    for block in css.split("@font-face")[1:]:
        if re.search(r"font-style:\s*italic", block):
            continue
        m = _SRC_RE.search(block)
        if m:
            return m.group(1)
    return None


# ── Caches ──────────────────────────────────────────────────────────────────


def _snap_weight(weight) -> int:
    try:
        w = int(math.floor(float(weight) / 100.0 + 0.5)) * 100
    except (TypeError, ValueError, OverflowError):
        return 400
    return min(900, max(100, w))


_BYTES_CACHE: dict[str, bytes] = {}
_FONT_CACHE: dict[tuple[str, int, int], ImageFont.ImageFont] = {}
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(name: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(name, threading.Lock())


def clear_caches() -> None:
    """For tests."""
    _BYTES_CACHE.clear()
    _FONT_CACHE.clear()
