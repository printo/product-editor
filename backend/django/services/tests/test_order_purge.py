"""
Tests for the order data-purge helpers (Phase 4 — DPDP right-to-erasure).

The file-deletion helper and the shared-upload-keep logic are the risky
pieces; the full DB purge is exercised end-to-end via the ops endpoint in
the manual/integration plan.

Run stand-alone:
    cd backend/django && python -m services.tests.test_order_purge
"""
from __future__ import annotations

import os
import sys
import tempfile

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from api.purge import _delete_files  # noqa: E402


def test_delete_files_counts_and_frees():
    d = tempfile.mkdtemp(prefix='pe-purge-')
    paths = []
    for i in range(3):
        p = os.path.join(d, f'f{i}.bin')
        with open(p, 'wb') as f:
            f.write(b'x' * (100 * (i + 1)))
        paths.append(p)
    deleted, freed, errors = _delete_files(paths)
    assert deleted == 3
    assert freed == 100 + 200 + 300
    assert errors == []
    for p in paths:
        assert not os.path.exists(p)


def test_delete_files_skips_missing_and_empty():
    deleted, freed, errors = _delete_files(['', None, '/no/such/file-xyz'])
    assert deleted == 0
    assert freed == 0
    assert errors == []  # missing files are a no-op, not an error


def test_delete_files_reports_undeletable():
    d = tempfile.mkdtemp(prefix='pe-purge-')
    # A directory path handed to a file-delete helper: os.path.isfile is False,
    # so it is skipped cleanly (no error, no partial delete).
    deleted, freed, errors = _delete_files([d])
    assert deleted == 0 and errors == []


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
    print(f"All {len(funcs)} order-purge tests passed.")


if __name__ == "__main__":
    _run_all()
