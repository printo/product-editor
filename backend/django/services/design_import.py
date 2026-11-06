"""
Fetching the artwork of a design exported from the older online-canvas tool.

The ops Templates page's Import dialog reads such an export in the browser
(frontend `lib/online-canvas-import.ts`). The export names its artwork by
address on the old tool's file host, which sends no CORS header, so the
browser cannot read the files itself: it asks this server for each one.

The address comes out of pasted text, so on its own it is not to be trusted.
The same three limits as a customer photo fetched by link, by going through
that very fetch (`services.photo_fetch.fetch_photo`):

1. **The host is on the calling API key's own list**, the very list that
   gates a photo fetch (`APIKey.allowed_photo_hosts`, Django admin, exact host
   names). Blank, the default, keeps this off for that key. Not a setting: a
   host list that every key shares is what the photo fetch was built to avoid.
2. **The address is public and the connection is pinned to it**, with no
   redirects (`services.url_safety.open_public_get`).
3. **The size is counted while reading**, and the whole fetch has a deadline.

Then the bytes must be what an artwork can be: a PNG, a JPEG or an SVG. An
SVG is NOT checked for scripts here; it is only handed back to the dialog as
bytes, and what the dialog builds from it passes the sticker upload's own
check (`services.svg_mask`) before anything is stored.

No Django models; `api.views.design_import.DesignImportArtworkView` is the caller.
"""
from __future__ import annotations

import os
import tempfile

from services.photo_fetch import PhotoFetchError, fetch_photo
from services.template_decoration import MAX_STICKER_BYTES

#: One artwork file, the same ceiling as the sticker it becomes.
MAX_ARTWORK_BYTES = MAX_STICKER_BYTES

CONTENT_TYPES = {'png': 'image/png', 'jpeg': 'image/jpeg', 'svg': 'image/svg+xml'}


class ArtworkFetchError(Exception):
    """A fetch that was refused or failed: `status` to answer with, `detail`
    safe to show the ops user."""

    def __init__(self, detail: str, status: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def sniff_artwork(data: bytes) -> str | None:
    """`'png'`, `'jpeg'` or `'svg'` from the first bytes; None for anything else."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[:3] == b'\xff\xd8\xff':
        return 'jpeg'
    head = data[:4096].lstrip(b'\xef\xbb\xbf').lstrip()
    if head.startswith(b'<svg') or ((head.startswith(b'<?xml') or head.startswith(b'<!')) and b'<svg' in head):
        return 'svg'
    return None


def _reword(exc: PhotoFetchError, hosts: list[str]) -> str:
    """A photo fetch's refusal, said about artwork."""
    if exc.status == 403 and 'may not be fetched' in exc.detail:
        return f"Artwork can only be fetched from: {', '.join(hosts)}."
    if exc.status == 413:
        return f"The artwork file is larger than {MAX_ARTWORK_BYTES // (1024 * 1024)} MB."
    return exc.detail.replace('Photos', 'Artwork').replace('photo', 'artwork')


def fetch_artwork(url, *, allowed_hosts, max_bytes: int = MAX_ARTWORK_BYTES) -> tuple[bytes, str]:
    """`(bytes, 'png' | 'jpeg' | 'svg')` of the artwork at `url`.

    Raises ArtworkFetchError for anything refused or failed.
    """
    hosts = list(allowed_hosts or [])
    if not hosts:
        raise ArtworkFetchError(
            "Fetching artwork is off for this API key. An administrator can switch it on by listing the old tool's "
            "file host under the key's allowed photo hosts.", status=403)
    fd, path = tempfile.mkstemp(prefix='pe-design-import-')
    os.close(fd)
    try:
        try:
            fetch_photo(url, allowed_hosts=hosts, dest_path=path, max_bytes=max_bytes)
        except PhotoFetchError as exc:
            raise ArtworkFetchError(_reword(exc, hosts), status=exc.status)
        with open(path, 'rb') as fetched:
            data = fetched.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    kind = sniff_artwork(data)
    if kind is None:
        raise ArtworkFetchError('That address does not hold a PNG, JPEG or SVG image.', status=415)
    return data, kind
