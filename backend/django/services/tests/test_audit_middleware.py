"""
Tests for the API audit trail's selection and attribution logic.

APIRequest has existed since the initial commit with nothing ever writing to
it. That made `APIRequest.objects.count()` return 0 for every key, forever —
which reads exactly like "this credential was never used" and is really "we
never recorded anything". A leaked-credential investigation reached that
conclusion before someone checked whether the writer existed at all.

Now that the middleware populates it, two properties decide whether the trail
is worth trusting:

  * WHAT gets recorded. Poll and chunk traffic would swamp the table without
    telling an investigator anything, but every path that touches customer data
    must land in it. An over-eager exemption silently creates a blind spot.

  * WHO it attributes the action to. The client-controlled left-most
    X-Forwarded-For hop must never be believed, or an attacker can write
    whatever source address they like into the audit log — which is worse than
    no audit log, because it looks authoritative.

Both are pure functions, so this needs no database.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_audit_middleware
"""
from __future__ import annotations

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from api.middleware import APIRequestLoggingMiddleware, _get_client_ip  # noqa: E402


class _Req:
    """Minimal stand-in for an HttpRequest — only META is read."""

    def __init__(self, **meta):
        self.META = meta


def _mw():
    return APIRequestLoggingMiddleware(get_response=lambda r: None)


def test_records_paths_that_touch_customer_data():
    mw = _mw()
    must_record = [
        '/api/jobs/abc-123/download/',      # the ZIP — the DPDP question
        '/api/editor/render',
        '/api/layout/generate',
        '/api/embed/session',
        '/api/upload/abc-123/complete',     # finalises a stored file
        '/api/ops/orders/EXT-1/purge',      # irreversible erasure
        '/api/ops/layouts/classic_4x6',
        '/api/canvas-state/EXT-1/',
    ]
    for path in must_record:
        assert mw._should_audit(path), f"audit blind spot: {path}"


def test_skips_high_frequency_noise():
    mw = _mw()
    must_skip = [
        '/api/health',
        '/api/config',
        '/api/render-status/abc-123/',
        '/api/upload/abc-123/chunk?index=0',
        '/api/upload/abc-123/chunk',
    ]
    for path in must_skip:
        assert not mw._should_audit(path), f"noise recorded: {path}"


def test_ignores_non_api_paths():
    mw = _mw()
    for path in ('/', '/login', '/dashboard', '/static/x.js'):
        assert not mw._should_audit(path)


def test_chunk_exemption_does_not_swallow_complete():
    """`/chunk` and `/complete` share a prefix; only the former is noise."""
    mw = _mw()
    assert not mw._should_audit('/api/upload/abc/chunk')
    assert mw._should_audit('/api/upload/abc/complete')


def test_exemption_is_prefix_anchored():
    """A path merely CONTAINING an exempt segment must still be recorded."""
    mw = _mw()
    assert mw._should_audit('/api/ops/render-status/report')
    assert mw._should_audit('/api/jobs/health-check-order/download/')


def test_client_ip_prefers_nginx_resolved_header():
    ip = _get_client_ip(_Req(
        HTTP_X_REAL_IP='203.0.113.9',
        HTTP_X_FORWARDED_FOR='1.2.3.4, 203.0.113.9',
        REMOTE_ADDR='172.18.0.9',
    ))
    assert ip == '203.0.113.9', ip


def test_client_ip_never_trusts_the_spoofable_hop():
    """The left-most XFF entry is attacker-controlled; take the right-most."""
    ip = _get_client_ip(_Req(
        HTTP_X_FORWARDED_FOR='6.6.6.6, 203.0.113.9',
        REMOTE_ADDR='172.18.0.9',
    ))
    assert ip == '203.0.113.9', f"believed a forged source address: {ip}"


def test_client_ip_falls_back_to_remote_addr():
    assert _get_client_ip(_Req(REMOTE_ADDR='172.18.0.9')) == '172.18.0.9'


def test_client_ip_has_a_last_resort():
    assert _get_client_ip(_Req()) == '0.0.0.0'


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print(f"  ok  {name}")
    print(f"\n{passed} audit-middleware tests passed")
