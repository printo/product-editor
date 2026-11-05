"""
`restore.json`: what an embedding company needs to bring a design back later.

We keep nothing past retention. A company that wants a customer to reopen or
reorder a design keeps its own copy, taken from the uploads ZIP of each render.
That ZIP carries one `restore.json` beside the photos: the design as it was at
submit, and one entry per distinct photo saying which file in the ZIP it is and
which id the design refers to it by.

This module is pure: no Django, no disk. `api.views.render` normalises what the
editor sent, `api.tasks` reads the rows and pixel sizes and calls
`build_restore_manifest`, and `api.views.downloads` writes the result into the
archive. Anything not recorded here at render time is lost for that order for
good, which is why the layout version and each photo's pixel size are in it.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import unicodedata

from services.fs_utils import is_uuid

#: Bump on any change to this file's shape or to the editor's saved design that
#: an older editor build could not read. The editor must keep reading every
#: older version, or migrate it on load.
SCHEMA_VERSION = 1

#: The name of the manifest inside the uploads archive.
MANIFEST_NAME = 'restore.json'

#: Same ceiling the autosave endpoint puts on a saved design.
MAX_EDITOR_STATE_BYTES = 5 * 1024 * 1024
MAX_FILES = 2000

_FILE_ID_RE = re.compile(r'^[A-Za-z0-9_.:\-]{1,100}$')
_UNSAFE_NAME_RE = re.compile(r'[\x00-\x1f\x7f/\\:*?"<>|]+')

KIND_FRAME = 'frame'
KIND_OVERLAY = 'overlay'
KIND_CALENDAR = 'calendar'


def normalise_restore_payload(raw) -> dict | None:
    """What the editor sent with the submit, reduced to what we will store.

    Returns `{'editor_state': dict | None, 'file_ids': {upload_id: file_id}}`,
    or None when there is nothing usable. Never raises and never rejects the
    submit: a malformed block costs the customer a restore later, not a print now.
    """
    if not isinstance(raw, dict):
        return None

    editor_state = raw.get('editor_state')
    if not isinstance(editor_state, dict):
        editor_state = None
    else:
        try:
            if len(json.dumps(editor_state)) > MAX_EDITOR_STATE_BYTES:
                editor_state = None
        except (TypeError, ValueError):
            editor_state = None

    file_ids: dict[str, str] = {}
    files = raw.get('files')
    if isinstance(files, list):
        for entry in files[:MAX_FILES]:
            if not isinstance(entry, dict):
                continue
            upload_id = str(entry.get('upload_id') or '').strip()
            file_id = str(entry.get('file_id') or '').strip()
            if is_uuid(upload_id) and _FILE_ID_RE.match(file_id):
                file_ids.setdefault(upload_id, file_id)

    if editor_state is None and not file_ids:
        return None
    return {'editor_state': editor_state, 'file_ids': file_ids}


def referenced_uploads(canvases: list | None) -> list[tuple[str, str]]:
    """Every customer upload the render contract names, once each, as
    `(upload_id, kind)` in a stable order: frame photos in canvas and frame
    order, then the customer's own image overlays, then calendar date photos.

    An overlay that is not the customer's own file (an icon or a sticker drawn
    to a PNG for the print) is left out: the saved design refers to it by its
    address, not by a file.
    """
    seen: dict[str, str] = {}

    def add(upload_id, kind):
        uid = str(upload_id or '').strip()
        if uid and uid not in seen:
            seen[uid] = kind

    canvases = [c for c in (canvases or []) if isinstance(c, dict)]
    for canvas in canvases:
        for frame in canvas.get('frames') or []:
            if isinstance(frame, dict):
                add(frame.get('upload_id'), KIND_FRAME)
    for canvas in canvases:
        for overlay in canvas.get('overlays') or []:
            if (isinstance(overlay, dict) and overlay.get('type') == 'image'
                    and overlay.get('source') == 'local'):
                add(overlay.get('fileId'), KIND_OVERLAY)
    for canvas in canvases:
        cells = (canvas.get('calendar') or {}).get('cells') if isinstance(canvas.get('calendar'), dict) else None
        if not isinstance(cells, dict):
            continue
        for entries in cells.values():
            for entry in entries or []:
                if isinstance(entry, dict) and entry.get('type') == 'image':
                    add(entry.get('uploadId'), KIND_CALENDAR)
    return list(seen.items())


def safe_entry_name(original_name: str | None) -> str:
    """A file name that is safe inside a ZIP on any system, keeping what the
    customer called the photo."""
    name = unicodedata.normalize('NFC', str(original_name or ''))
    name = os.path.basename(name.replace('\\', '/'))
    name = _UNSAFE_NAME_RE.sub('_', name).strip(' .')
    if not name:
        return 'photo'
    stem, ext = os.path.splitext(name)
    return f'{stem[:120]}{ext[:12]}'


def zip_entry_name(position: int, original_name: str | None) -> str:
    """`001_IMG_1234.jpg`: the number makes two photos with one name distinct."""
    return f'{position:03d}_{safe_entry_name(original_name)}'


#: Spelled out because the system's type table differs between machines (the
#: backend image has no entry for .webp), and a manifest must not.
_IMAGE_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif',
}


def content_type_for(name: str | None) -> str:
    name = str(name or '')
    known = _IMAGE_TYPES.get(os.path.splitext(name)[1].lower())
    if known:
        return known
    guessed, _ = mimetypes.guess_type(name)
    return guessed or 'application/octet-stream'


def build_restore_manifest(*, order_id: str, render_job_id: str, layout_name: str,
                           layout_version: int | None, created_at: str,
                           render_state: dict | None, uploads: dict) -> dict | None:
    """The manifest for one render job, or None when the job has no customer
    photos to list.

    `uploads` maps upload_id to what we know of the stored file:
    `{'original_name', 'size_bytes', 'width', 'height'}`. An upload the render
    names but `uploads` does not hold (deleted, or another key's) is left out,
    so every entry in the manifest is a file the archive can carry.
    """
    render_state = render_state or {}
    restore = render_state.get('restore') if isinstance(render_state.get('restore'), dict) else {}
    file_ids = restore.get('file_ids') if isinstance(restore.get('file_ids'), dict) else {}

    photos = []
    for upload_id, kind in referenced_uploads(render_state.get('canvases')):
        info = uploads.get(upload_id)
        if not info:
            continue
        original_name = info.get('original_name') or ''
        photos.append({
            # A calendar date photo has no browser id: the design names it
            # by its upload id, so that is the id a restore looks it up by.
            'file_id': file_ids.get(upload_id) or (upload_id if kind == KIND_CALENDAR else None),
            'upload_id': upload_id,
            'kind': kind,
            'zip_entry': zip_entry_name(len(photos) + 1, original_name),
            'original_name': original_name,
            'size_bytes': info.get('size_bytes'),
            'content_type': content_type_for(original_name),
            'width': info.get('width'),
            'height': info.get('height'),
        })
    if not photos:
        return None

    editor_state = restore.get('editor_state')
    return {
        'schema_version': SCHEMA_VERSION,
        'order_id': order_id,
        'render_job_id': str(render_job_id),
        'layout_name': layout_name,
        'layout_version': layout_version,
        'created_at': created_at,
        'editor_state': editor_state if isinstance(editor_state, dict) else None,
        'photos': photos,
    }
