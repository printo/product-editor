"""
Tests for which customer uploads a render looks up besides frame photos
(api/tasks.py `_referenced_upload_ids`).

Photos a customer places on calendar dates live in `calendar.cells` as
`{"type": "image", "uploadId": ...}` entries. The lookup used to read image
overlays only, so the renderer never found those files and printed every
such date as an empty cell ("upload ... not on disk") while the editor showed
the photo.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_render_upload_ids
"""
from __future__ import annotations

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from api.tasks import _extract_calendar_state, _referenced_upload_ids


def test_calendar_date_photos_are_looked_up():
    state = {"cells": {
        "2026-12-25": [{"type": "image", "uploadId": "a1"}],
        "2026-02-14": [{"type": "text", "text": "Anniversary"}],
    }}
    assert _referenced_upload_ids(None, state) == {"a1"}


def test_image_overlays_are_still_looked_up():
    overlays = [[{"type": "image", "fileId": "o1"}, {"type": "text", "text": "Hi"}], None, []]
    assert _referenced_upload_ids(overlays) == {"o1"}


def test_both_sources_together():
    overlays = [[{"type": "image", "fileId": "o1"}]]
    state = {"cells": {"2026-01-01": [{"type": "image", "uploadId": "c1"}]}}
    assert _referenced_upload_ids(overlays, state) == {"o1", "c1"}


def test_nothing_referenced():
    assert _referenced_upload_ids(None, None) == set()
    assert _referenced_upload_ids([[{"type": "shape"}]], {"cells": {}}) == set()


def test_hidden_dates_and_image_entries_without_an_id_are_ignored():
    state = {"cells": {
        "2026-03-01": [{"type": "hide"}],
        "2026-03-02": [{"type": "image"}],
        "2026-03-03": None,
    }}
    assert _referenced_upload_ids(None, state) == set()


def test_from_a_real_render_payload():
    """The shape EditorRenderView snapshots: the product-wide cells map sent on every canvas."""
    cells = {"2026-12-25": [{"type": "image", "uploadId": "29c2fda3-df2c-43bb-8192-cab000423a93"}]}
    render_state = {"canvases": [
        {"calendar": {"themePreset": "weekday-highlight", "calendarType": "english", "cells": cells}},
        {"calendar": {"themePreset": "weekday-highlight", "calendarType": "english", "cells": cells}},
    ]}
    state = _extract_calendar_state(render_state)
    assert _referenced_upload_ids(None, state) == {"29c2fda3-df2c-43bb-8192-cab000423a93"}


if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL {t.__name__}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
