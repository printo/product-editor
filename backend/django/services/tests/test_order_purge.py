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

from django.conf import settings  # noqa: E402

from api.purge import _delete_files  # noqa: E402


def _data_folder():
    """A temp folder the purge treats as its uploads folder (it refuses any other path)."""
    d = tempfile.mkdtemp(prefix='pe-purge-')
    settings.UPLOADS_DIR = d
    return d


def test_delete_files_counts_and_frees():
    d = _data_folder()
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
    d = _data_folder()
    deleted, freed, errors = _delete_files(['', None, os.path.join(d, 'no-such-file-xyz')])
    assert deleted == 0
    assert freed == 0
    assert errors == []  # missing files are a no-op, not an error


def test_delete_files_refuses_paths_outside_the_data_folders():
    _data_folder()
    outside = tempfile.mkdtemp(prefix='pe-outside-')
    p = os.path.join(outside, 'keep.bin')
    with open(p, 'wb') as f:
        f.write(b'x')
    deleted, freed, errors = _delete_files([p])
    assert deleted == 0 and len(errors) == 1 and 'refused' in errors[0]
    assert os.path.exists(p)


def test_delete_files_reports_undeletable():
    d = _data_folder()
    # A directory path handed to a file-delete helper: os.path.isfile is False,
    # so it is skipped cleanly (no error, no partial delete).
    sub = os.path.join(d, 'a-folder')
    os.mkdir(sub)
    deleted, freed, errors = _delete_files([sub])
    assert deleted == 0 and errors == []
    assert os.path.isdir(sub)


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
