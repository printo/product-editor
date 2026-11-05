"""
Fetching a customer photo from an embedding company's own storage.

When a customer reopens or reorders a design after our retention has passed,
the photos come back from the company that kept them, as links. At submit our
server fetches each unchanged photo from its link so the customer's phone does
not have to download and re-upload it.

The link reaches us from the customer's browser, so on its own it is not to be
trusted: without a limit, anyone holding an embed token could make this server
download anything from anywhere. Three limits, all of which must hold:

1. **The host is on the API key's own list** (`APIKey.allowed_photo_hosts`, set
   in the Django admin). An exact host name, no wildcards. A blank list means
   the fetch is off for that key, which is the default.
2. **The address is public and the connection is pinned to it**
   (`services.url_safety.open_public_get`): no private or metadata address, no
   DNS rebinding between the check and the connect, no redirects.
3. **The size is capped while reading**, whatever the server claims, and the
   whole fetch has a deadline.

No Django models here; `api.views.uploads.UploadFromUrlView` is the caller.
"""
from __future__ import annotations

import ipaddress
import os
import re
import time
from urllib.parse import urlparse

from django.core.exceptions import ValidationError

from services.url_safety import MAX_CALLBACK_URL_LEN, open_public_get

#: A host name as it may be listed: dotted labels, no wildcard, no port, no path.
_HOST_RE = re.compile(
    r'^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
)

CONNECT_TIMEOUT_S = 5
READ_TIMEOUT_S = 20
#: The whole fetch, start to finish. A slow trickle must not hold a web worker.
DEADLINE_S = 60
_CHUNK = 64 * 1024
#: Names the client honestly; some storage hosts refuse a request with no agent.
USER_AGENT = 'ProductEditor-PhotoFetch/1.0'


class PhotoFetchError(Exception):
    """A fetch that was refused or failed. `status` is the HTTP status to
    answer with; `detail` is safe to show the caller (it never repeats the
    link's query string, which may carry a signature)."""

    def __init__(self, detail: str, status: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def _split_hosts(text) -> list[str]:
    return [h.strip().lower().rstrip('.') for h in re.split(r'[\s,]+', str(text or '')) if h.strip()]


def _is_host_name(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return False  # an address is not a host name: list the name
    except ValueError:
        return bool(_HOST_RE.match(host))


def parse_photo_hosts(text) -> list[str]:
    """The host names in an API key's `allowed_photo_hosts`, lower-cased, once
    each, in the order written. An entry that is not a plain host name is left
    out, so a typo can only ever narrow the list."""
    seen: list[str] = []
    for host in _split_hosts(text):
        if _is_host_name(host) and host not in seen:
            seen.append(host)
    return seen


def invalid_photo_hosts(text) -> list[str]:
    """Entries that are not plain host names, for the admin form to name."""
    return [h for h in _split_hosts(text) if not _is_host_name(h)]


def check_photo_url(url, allowed_hosts) -> str:
    """Return the link's host when the link may be fetched; raise
    PhotoFetchError otherwise. Does not touch the network."""
    url = str(url or '').strip()
    if not url:
        raise PhotoFetchError('url is required.')
    if len(url) > MAX_CALLBACK_URL_LEN:
        raise PhotoFetchError('url is too long.')
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        raise PhotoFetchError('url is not a valid address.')
    if parsed.scheme != 'https':
        raise PhotoFetchError('url must be an https:// address.')
    if parsed.username or parsed.password:
        raise PhotoFetchError('url must not carry a user name or password.')
    if port not in (None, 443):
        raise PhotoFetchError('url must use the standard https port.')
    host = (parsed.hostname or '').lower().rstrip('.')
    if not host:
        raise PhotoFetchError('url has no host.')
    if host not in set(allowed_hosts or []):
        raise PhotoFetchError(f"Photos may not be fetched from '{host}' with this API key.", status=403)
    return host


def name_from_url(url) -> str:
    """The file name a link ends in, or '' when it has none."""
    try:
        return os.path.basename(urlparse(str(url or '')).path)
    except ValueError:
        return ''


def fetch_photo(url, *, allowed_hosts, dest_path: str, max_bytes: int,
                connect_timeout: float = CONNECT_TIMEOUT_S, read_timeout: float = READ_TIMEOUT_S,
                deadline_s: float = DEADLINE_S) -> int:
    """Download `url` into `dest_path` and return the number of bytes written.

    Raises PhotoFetchError for anything refused or failed, and leaves no file
    behind when it does.
    """
    host = check_photo_url(url, allowed_hosts)
    started = time.monotonic()
    response = None
    try:
        try:
            response = open_public_get(
                str(url).strip(), headers={'User-Agent': USER_AGENT, 'Accept': 'image/*'},
                timeout=(connect_timeout, read_timeout),
            )
        except ValidationError:
            raise PhotoFetchError(f"'{host}' is not a public address.", status=403)
        except Exception:
            raise PhotoFetchError(f"Could not reach '{host}'.", status=502)

        if 300 <= response.status_code < 400:
            raise PhotoFetchError('The photo link redirects, and redirects are not followed.', status=502)
        if response.status_code != 200:
            raise PhotoFetchError(f"'{host}' answered {response.status_code} for this photo.", status=502)

        declared = response.headers.get('Content-Length')
        if declared and declared.isdigit() and int(declared) > max_bytes:
            raise PhotoFetchError('The photo is larger than the upload limit.', status=413)

        written = 0
        try:
            with open(dest_path, 'wb') as out:
                for chunk in response.iter_content(chunk_size=_CHUNK):
                    if not chunk:
                        continue
                    written += len(chunk)
                    # The header can lie or be missing; this count cannot.
                    if written > max_bytes:
                        raise PhotoFetchError('The photo is larger than the upload limit.', status=413)
                    if time.monotonic() - started > deadline_s:
                        raise PhotoFetchError(f"'{host}' took too long to send this photo.", status=504)
                    out.write(chunk)
        except PhotoFetchError:
            raise
        except Exception:
            raise PhotoFetchError(f"The download from '{host}' was interrupted.", status=502)
        if written == 0:
            raise PhotoFetchError(f"'{host}' sent an empty file for this photo.", status=502)
        return written
    except PhotoFetchError:
        try:
            if os.path.exists(dest_path):
                os.remove(dest_path)
        except OSError:
            pass
        raise
    finally:
        if response is not None:
            response.close()
