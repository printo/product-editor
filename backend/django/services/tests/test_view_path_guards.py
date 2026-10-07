"""
Path guards in the api.views package.

is_safe_layout_name used to exist as three identical methods on three views
(GetLayoutView, LayoutManagementView, GenerateLayoutView); it is now one
function in api/views/_common.py.

SecureExportDownloadView's backstop check (_is_full_path_safe) compared resolved
paths with startswith(), which also accepted a sibling directory sharing the
exports dir's prefix (`exports_old/`). The view's first check already rejects
`..` and absolute paths, so only a symlink placed on the server could reach that
case — but the backstop exists to catch whatever the first check misses.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_view_path_guards
"""
from __future__ import annotations

import os
import tempfile

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.test import override_settings  # noqa: E402

from api.views._common import is_safe_layout_name  # noqa: E402
from api.views.downloads import SecureExportDownloadView  # noqa: E402


def test_layout_names_with_path_parts_are_refused():
    for ok in ('classic_A4', 'retro_polaroid_-_4.2x3.5_in', 'test_book'):
        assert is_safe_layout_name(ok), ok
    for bad in ('', None, 'a/b', 'a\\b', '..', 'x..y', '../etc', '.hidden'):
        assert not is_safe_layout_name(bad), bad


def test_export_downloads_stay_inside_the_exports_dir():
    with tempfile.TemporaryDirectory() as root:
        exports = os.path.join(root, 'exports')
        sibling = os.path.join(root, 'exports_old')
        os.makedirs(exports)
        os.makedirs(sibling)
        open(os.path.join(exports, 'ok.png'), 'wb').close()
        open(os.path.join(sibling, 'other.png'), 'wb').close()
        os.symlink(sibling, os.path.join(exports, 'link'))

        check = SecureExportDownloadView._is_full_path_safe
        with override_settings(EXPORTS_DIR=exports):
            assert check(os.path.join(exports, 'ok.png'))
            assert not check(os.path.join(exports, 'missing.png'))
            # A sibling that merely shares the prefix, reached directly or through a symlink.
            assert not check(os.path.join(sibling, 'other.png'))
            assert not check(os.path.join(exports, 'link', 'other.png'))
            assert not check(os.path.join(exports, '..', 'exports_old', 'other.png'))


if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn()
        print(f'  ✓ {fn.__name__}')
    print(f'\n{len(fns)} view path-guard tests passed.')
