"""
Tests for the queue/worker resilience guards (Phase 4): disk-free helper and
the chunked-upload bound arithmetic.

The poison-pill delivery guard and disk-full render pre-flight are exercised
end-to-end against a live worker (documented in the manual test plan); here we
pin the pure pieces that are cheaply unit-testable.

Run stand-alone:
    cd backend/django && python -m services.tests.test_queue_guards
"""
from __future__ import annotations

import os
import sys

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from api.tasks import _free_space_mb  # noqa: E402


CHUNK_SIZE = 2 * 1024 * 1024  # must match ChunkedUploadInitView.CHUNK_SIZE


def _chunk_bounds_ok(file_size: int, total_chunks: int) -> bool:
    """Mirror of the ChunkedUploadInitView bound check (Phase 4)."""
    if file_size <= 0:
        return False
    expected = -(-file_size // CHUNK_SIZE)
    max_chunks = expected + 1
    return 1 <= total_chunks <= max_chunks


def test_free_space_positive_for_real_path():
    mb = _free_space_mb(os.path.dirname(__file__))
    assert mb > 0 and mb != float('inf')


def test_free_space_inf_for_bad_path():
    assert _free_space_mb('/definitely/not/a/real/path/xyz') == float('inf')


def test_chunk_bounds_accept_exact_count():
    # A 50 MB file at 2 MB chunks → 25 chunks, exactly what the client sends.
    fifty_mb = 50 * 1024 * 1024
    assert _chunk_bounds_ok(fifty_mb, 25) is True
    assert _chunk_bounds_ok(fifty_mb, 26) is True   # +1 slack allowed
    assert _chunk_bounds_ok(fifty_mb, 27) is False  # beyond slack → reject


def test_chunk_bounds_reject_hostile_and_degenerate():
    ten_mb = 10 * 1024 * 1024
    assert _chunk_bounds_ok(ten_mb, 10**9) is False  # the OOM vector
    assert _chunk_bounds_ok(ten_mb, 0) is False
    assert _chunk_bounds_ok(ten_mb, -1) is False
    assert _chunk_bounds_ok(0, 1) is False
    assert _chunk_bounds_ok(-5, 1) is False


def test_chunk_bounds_small_file_single_chunk():
    assert _chunk_bounds_ok(500, 1) is True
    assert _chunk_bounds_ok(500, 2) is True   # slack
    assert _chunk_bounds_ok(500, 3) is False


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
    print(f"All {len(funcs)} queue-guard tests passed.")


if __name__ == "__main__":
    _run_all()
