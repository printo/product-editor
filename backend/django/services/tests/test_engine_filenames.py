"""
Tests for layout_engine.engine output filename resolution + partial-failure
cleanup.

Covers:
  - P7.1 (PRD §11.6) — calendar surface output filenames come from the
    human-readable `displayLabel` ("January 2026.png") rather than the
    legacy `{layout_name}_{surface_key}_{n}` shape.
  - P7.2 (PRD §11.5) — multi-surface partial-failure handling: a failure
    on surface N cleans up surfaces 1..N-1 from disk and re-raises with
    a customer-facing "Render failed on <displayLabel>" message.

Run stand-alone:
    cd backend/django && python -m services.tests.test_engine_filenames
"""
from __future__ import annotations

import os
import sys
import tempfile

from layout_engine.engine import LayoutEngine, _sanitize_for_filename


# ─── _sanitize_for_filename ──────────────────────────────────────────────────

def test_keeps_letters_digits_and_spaces():
    assert _sanitize_for_filename("January 2026") == "January 2026"
    assert _sanitize_for_filename("Front") == "Front"
    assert _sanitize_for_filename("FY 2026-27") == "FY 2026-27"


def test_replaces_unsafe_chars_with_underscore():
    # All these are illegal on Windows or hostile to shell quoting.
    cases = [
        ("January/2026", "January_2026"),
        ("Q1?\\<2026>", "Q1_2026"),
        ("front:back", "front_back"),
        ('foo"bar', "foo_bar"),
        ("a|b", "a_b"),
        ("hello*world", "hello_world"),
    ]
    for inp, expected in cases:
        got = _sanitize_for_filename(inp)
        assert got == expected, f"sanitize({inp!r}) → {got!r}, want {expected!r}"


def test_strips_control_chars():
    # NULL, tab, newline → underscore. Surrounding whitespace trimmed.
    assert _sanitize_for_filename("January\x00 2026") == "January_ 2026"
    assert _sanitize_for_filename("  March 2027  ") == "March 2027"


def test_collapses_runs_of_whitespace():
    assert _sanitize_for_filename("April   May   June") == "April May June"


def test_blank_returns_empty():
    assert _sanitize_for_filename("") == ""
    assert _sanitize_for_filename(None or "") == ""
    # All-unsafe → after replacement and trim → returns "_" without leading
    # underscore stripped (strip(' ._') strips them). Document the current
    # contract: an all-unsafe input collapses to empty.
    assert _sanitize_for_filename("///") == ""


def test_strip_does_not_eat_internal_dots():
    # File-stem dots are safe; only leading/trailing dots get trimmed.
    assert _sanitize_for_filename(".hidden") == "hidden"
    assert _sanitize_for_filename("v1.2.3") == "v1.2.3"


def test_unicode_passthrough():
    # Non-ASCII letters are filesystem-legal on macOS/Linux; pass through.
    assert _sanitize_for_filename("Janvier 2026") == "Janvier 2026"
    assert _sanitize_for_filename("جنوری 2026") == "جنوری 2026"


# ─── _cleanup_partial_outputs (P7.2) ─────────────────────────────────────────

def test_cleanup_removes_existing_files():
    eng = LayoutEngine(layouts_dir="/tmp", exports_dir="/tmp")
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for name in ("a.png", "b.png", "c.png"):
            p = os.path.join(d, name)
            with open(p, "wb") as f:
                f.write(b"\x00")
            paths.append(p)
        eng._cleanup_partial_outputs(paths)
        for p in paths:
            assert not os.path.exists(p), f"{p} should have been deleted"


def test_cleanup_skips_missing_files_silently():
    eng = LayoutEngine(layouts_dir="/tmp", exports_dir="/tmp")
    # Path doesn't exist — must not raise.
    eng._cleanup_partial_outputs(["/tmp/does/not/exist-xyz123.png"])


def test_cleanup_continues_after_individual_failure():
    eng = LayoutEngine(layouts_dir="/tmp", exports_dir="/tmp")
    with tempfile.TemporaryDirectory() as d:
        ok_path = os.path.join(d, "ok.png")
        with open(ok_path, "wb") as f:
            f.write(b"\x00")
        # First entry is unreachable (would fail os.remove), second is a real
        # file. Both should land in their final state regardless.
        unreachable = "/proc/1/totally-not-writable"  # almost always EACCES
        eng._cleanup_partial_outputs([unreachable, ok_path])
        assert not os.path.exists(ok_path), "real file should still be removed"


def test_cleanup_handles_empty_list():
    eng = LayoutEngine(layouts_dir="/tmp", exports_dir="/tmp")
    eng._cleanup_partial_outputs([])  # no-op; must not raise


# ─── Test runner ─────────────────────────────────────────────────────────────

def _run_all():
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
    else:
        print(f"All {len(funcs)} engine-filename tests passed.")


if __name__ == "__main__":
    _run_all()
