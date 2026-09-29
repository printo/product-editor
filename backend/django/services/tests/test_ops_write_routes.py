"""
Writes to ops-owned calendar config must land only on the ops/ routes.

CalendarStylesView and HolidaysView are mounted on the public read paths
(`calendar-styles/...`, `holidays/...`) AND on their `ops/` twins, and their
put()/delete() handlers gate on the caller being ops without looking at which
route they arrived on. Through the internal proxy every request carries the
ops-flagged INTERNAL_API_KEY service account, so that gate passes for any
signed-in human — and the proxy's per-user tier check (lib/ops-guard.ts) keyed
on the `ops/` prefix, so it missed the aliases entirely.

These pin the Django half of the fix: the aliases refuse writes outright, even
from an ops caller, while the ops/ routes keep accepting them and the aliases
keep serving the reads the editor depends on.

DB-free and cache-free: authentication is stubbed to an ops user, storage
reads/writes and the cache are mocked, and requests go through the real
URLconf via resolve() so the route-level method restriction is what's tested.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_ops_write_routes
"""
from __future__ import annotations

import json
import os
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.test import RequestFactory  # noqa: E402
from django.urls import resolve  # noqa: E402

factory = RequestFactory()

# Stands in for the INTERNAL_API_KEY service account: ops-flagged, whoever the
# human behind the proxy is.
OPS_USER = SimpleNamespace(is_ops_team=True, is_staff=False, is_authenticated=True)

WRITE_METHODS = ('post', 'put', 'patch', 'delete')

STYLE_BODY = {'label': 'Modern Gen-Z', 'palettes': []}
HOLIDAY_BODY = {'events': [{'date': '2026-01-26', 'name': 'Republic Day'}]}


def _dispatch(method, path, body=None):
    if method in ('get', 'head'):
        request = getattr(factory, method)(path)
    else:
        data = json.dumps(body) if body is not None else ''
        request = getattr(factory, method)(path, data=data, content_type='application/json')
    match = resolve(path)
    with ExitStack() as stack:
        for auth in ('BearerTokenAuthentication', 'PIAAuthentication'):
            stack.enter_context(patch(
                f'api.authentication.{auth}.authenticate', return_value=(OPS_USER, None),
            ))
        return match.func(request, **match.kwargs)


def _storage_mocks():
    stack = ExitStack()
    mocks = {
        'write_style': stack.enter_context(patch('api.views._write_calendar_style')),
        'write_holidays': stack.enter_context(patch('api.views._write_holidays')),
        'get_storage': stack.enter_context(patch('services.storage.get_storage')),
        'cache': stack.enter_context(patch('django.core.cache.cache', MagicMock())),
    }
    return stack, mocks


def test_public_calendar_style_alias_refuses_writes_even_from_ops():
    stack, mocks = _storage_mocks()
    with stack:
        for method in WRITE_METHODS:
            response = _dispatch(method, '/api/calendar-styles/modern-genz', STYLE_BODY)
            assert response.status_code == 405, (
                f'{method.upper()} /api/calendar-styles/<name> returned '
                f'{response.status_code}; must be 405 — writes belong on ops/ only'
            )
        assert not mocks['write_style'].called, 'a style preset was written via the public alias'


def test_public_calendar_style_list_refuses_writes():
    stack, mocks = _storage_mocks()
    with stack:
        for method in WRITE_METHODS:
            response = _dispatch(method, '/api/calendar-styles/', STYLE_BODY)
            assert response.status_code == 405, (
                f'{method.upper()} /api/calendar-styles/ returned {response.status_code}'
            )
        assert not mocks['write_style'].called


def test_public_holiday_alias_refuses_writes_even_from_ops():
    stack, mocks = _storage_mocks()
    with stack:
        for method in WRITE_METHODS:
            response = _dispatch(method, '/api/holidays/en-IN/2026', HOLIDAY_BODY)
            assert response.status_code == 405, (
                f'{method.upper()} /api/holidays/<locale>/<year> returned '
                f'{response.status_code}; must be 405 — writes belong on ops/ only'
            )
        assert not mocks['write_holidays'].called, 'holidays were written via the public alias'
        assert not mocks['get_storage'].called, 'holidays were deleted via the public alias'


def test_ops_calendar_style_route_still_accepts_writes():
    stack, mocks = _storage_mocks()
    with stack:
        response = _dispatch('put', '/api/ops/calendar-styles/modern-genz', STYLE_BODY)
        assert response.status_code == 200, response.status_code
        mocks['write_style'].assert_called_once()
        name, payload = mocks['write_style'].call_args[0]
        assert name == 'modern-genz'
        assert payload['name'] == 'modern-genz'


def test_ops_holiday_route_still_accepts_writes():
    stack, mocks = _storage_mocks()
    with stack:
        response = _dispatch('put', '/api/ops/holidays/en-IN/2026', HOLIDAY_BODY)
        assert response.status_code == 200, response.status_code
        mocks['write_holidays'].assert_called_once()

        response = _dispatch('delete', '/api/ops/holidays/en-IN/2026')
        assert response.status_code == 204, response.status_code
        mocks['get_storage'].return_value.delete_calendar_asset.assert_called_once_with(
            'holidays', 'en-IN/2026',
        )


def test_public_aliases_still_serve_reads():
    # The customer editor and the ops calendar page fetch these on mount —
    # restricting methods must not cost the reads.
    with patch('api.views._list_calendar_styles', return_value=[]), \
         patch('api.views._read_calendar_style', return_value={'name': 'modern-genz'}), \
         patch('api.views._read_holidays', return_value={'events': []}):
        assert _dispatch('get', '/api/calendar-styles/').status_code == 200
        assert _dispatch('get', '/api/calendar-styles/modern-genz').status_code == 200
        assert _dispatch('get', '/api/holidays/en-IN/2026').status_code == 200
        assert _dispatch('head', '/api/holidays/en-IN/2026').status_code == 200


if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn()
        print(f'  ✓ {fn.__name__}')
    print(f'\n{len(fns)} ops write-route tests passed.')
