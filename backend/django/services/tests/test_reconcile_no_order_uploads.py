"""
Tests for the pure helpers behind the reconcile_no_order_uploads management
command (api/management/commands/reconcile_no_order_uploads.py).

_replace_exact is the highest-risk piece of that command's --apply path — it
rewrites CanvasData.editor_state/render_state/image_paths in place before the
underlying file is moved. These tests pin its one hard safety property: it
only ever replaces a string LEAF that is EQUAL to the old path, never a
substring occurrence inside a longer string, so a field that happens to
mention the old path as part of unrelated text can never be corrupted.

DB-free — CanvasData() below is constructed without .save(), so nothing here
touches Postgres. Run stand-alone:

    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_reconcile_no_order_uploads
"""
from __future__ import annotations

import os

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from api.management.commands.reconcile_no_order_uploads import (  # noqa: E402
    _haystack, _human, _replace_exact,
)
from api.models import CanvasData  # noqa: E402

OLD = "/app/storage/uploads/_no_order/abc12345_photo.jpg"
NEW = "/app/storage/uploads/PE-REAL123/abc12345_photo.jpg"


# ── _replace_exact ────────────────────────────────────────────────────────

def test_replaces_an_exact_string_leaf():
    value, changed = _replace_exact(OLD, OLD, NEW)
    assert changed is True
    assert value == NEW


def test_leaves_a_non_matching_string_untouched():
    value, changed = _replace_exact("something else", OLD, NEW)
    assert changed is False
    assert value == "something else"


def test_never_touches_a_string_that_merely_contains_the_old_value():
    # The hard safety property: substring occurrence is not a match. A caption
    # or filename that happens to mention the old path as text must survive
    # byte-for-byte.
    haystack = f"see {OLD} for details"
    value, changed = _replace_exact(haystack, OLD, NEW)
    assert changed is False
    assert value == haystack


def test_replaces_inside_a_list():
    value, changed = _replace_exact(["a", OLD, "b"], OLD, NEW)
    assert changed is True
    assert value == ["a", NEW, "b"]


def test_list_with_no_match_is_unchanged():
    original = ["a", "b", "c"]
    value, changed = _replace_exact(original, OLD, NEW)
    assert changed is False
    assert value == original


def test_replaces_inside_a_nested_dict():
    original = {
        "image_paths": [OLD],
        "canvases": [{"frames": [{"upload_id": "keep-me", "path": OLD}]}],
        "unrelated": "leave me alone",
    }
    value, changed = _replace_exact(original, OLD, NEW)
    assert changed is True
    assert value["image_paths"] == [NEW]
    assert value["canvases"][0]["frames"][0]["path"] == NEW
    assert value["canvases"][0]["frames"][0]["upload_id"] == "keep-me"
    assert value["unrelated"] == "leave me alone"


def test_dict_with_no_match_is_unchanged():
    original = {"a": 1, "b": [1, 2, "x"], "c": {"d": None}}
    value, changed = _replace_exact(original, OLD, NEW)
    assert changed is False
    assert value == original


def test_non_string_leaves_pass_through_untouched():
    original = {"count": 3, "ok": True, "missing": None, "ratio": 1.5}
    value, changed = _replace_exact(original, OLD, NEW)
    assert changed is False
    assert value == original


def test_replaces_every_occurrence_not_just_the_first():
    value, changed = _replace_exact([OLD, "mid", OLD], OLD, NEW)
    assert changed is True
    assert value == [NEW, "mid", NEW]


# ── _haystack ─────────────────────────────────────────────────────────────

def test_haystack_finds_a_path_inside_image_paths():
    canvas = CanvasData(order_id="PE-1", image_paths=[OLD])
    assert OLD in _haystack(canvas)


def test_haystack_finds_an_upload_id_nested_in_render_state():
    canvas = CanvasData(
        order_id="PE-1",
        render_state={"canvases": [{"calendar": {"cells": [{"uploadId": "abc-123"}]}}]},
    )
    assert "abc-123" in _haystack(canvas)


def test_haystack_finds_an_upload_id_nested_in_editor_state():
    # Pre-migration-0008 rows kept everything in editor_state — the search
    # must still find a reference there, not only in render_state.
    canvas = CanvasData(
        order_id="PE-1",
        editor_state={"calendarState": {"cells": {"2026-01-01": [{"uploadId": "legacy-id"}]}}},
    )
    assert "legacy-id" in _haystack(canvas)


def test_haystack_is_empty_for_a_blank_canvas():
    canvas = CanvasData(order_id="PE-1")
    assert _haystack(canvas) == ""


# ── _human ────────────────────────────────────────────────────────────────

def test_human_formats_bytes_and_larger_units():
    assert _human(0) == "0.0 B"
    assert _human(1024) == "1.0 KB"
    assert _human(1024 * 1024) == "1.0 MB"


# ─── Test runner ─────────────────────────────────────────────────────────────

def _run_all():
    import sys
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"  OK  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print()
    if failed:
        print(f"{failed} test(s) failed.")
        sys.exit(1)
    print(f"All {len(funcs)} reconcile-no-order-uploads tests passed.")


if __name__ == "__main__":
    _run_all()
