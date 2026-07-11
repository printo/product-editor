"""
Tests for the SSRF guard on customer webhook URLs (Phase 4).

Run stand-alone:
    cd backend/django && python -m services.tests.test_url_safety
"""
from __future__ import annotations

import os
import sys
from unittest import mock

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.core.exceptions import ValidationError  # noqa: E402

from services.url_safety import validate_public_https_url  # noqa: E402


def _addrinfo(ip: str):
    family = 10 if ':' in ip else 2  # AF_INET6 / AF_INET
    return [(family, 1, 6, '', (ip, 443))]


def test_rejects_non_https():
    for url in ('http://example.com/x', 'ftp://example.com', 'file:///etc/passwd'):
        try:
            validate_public_https_url(url)
            assert False, f"should reject {url}"
        except ValidationError:
            pass


def test_rejects_internal_ip_literals():
    for url in (
        'https://127.0.0.1/x',
        'https://10.0.0.5/x',
        'https://192.168.1.1/x',
        'https://169.254.169.254/latest/meta-data',   # cloud metadata
        'https://[::1]/x',
        'https://[fc00::1]/x',                         # unique-local IPv6
        'https://0.0.0.0/x',
    ):
        try:
            validate_public_https_url(url)
            assert False, f"should reject {url}"
        except ValidationError:
            pass


def test_rejects_internal_hostname():
    # A Docker-internal hostname that resolves to a private IP.
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('172.18.0.3')):
        try:
            validate_public_https_url('https://backend:8000/x')
            assert False, "should reject internal hostname"
        except ValidationError:
            pass


def test_rejects_dns_rebinding():
    # A public-looking hostname that resolves to a private IP (rebinding).
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('10.1.2.3')):
        try:
            validate_public_https_url('https://evil.example.com/hook')
            assert False, "should reject a host that resolves to a private IP"
        except ValidationError:
            pass


def test_rejects_mixed_public_and_private_records():
    # If ANY resolved address is private, reject (can't trust which is used).
    infos = _addrinfo('93.184.216.34') + _addrinfo('10.0.0.9')
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=infos):
        try:
            validate_public_https_url('https://mixed.example.com/x')
            assert False, "should reject when any record is private"
        except ValidationError:
            pass


def test_accepts_public_hostname():
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('93.184.216.34')):
        ips = validate_public_https_url('https://printo.in/api/internal/pe-callback')
        assert ips == ['93.184.216.34'], ips


def test_accepts_public_ipv6():
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('2606:2800:220:1:248:1893:25c8:1946')):
        ips = validate_public_https_url('https://ipv6.example.com/x')
        assert ips and not ips[0].startswith('fc'), ips


def test_pin_forces_connection_to_validated_ip():
    """The pin must route the target host's resolution to the validated IP
    (closing DNS-rebinding) and restore socket.getaddrinfo afterwards."""
    import socket as _socket
    from services import url_safety

    original = _socket.getaddrinfo
    captured = {}

    class _FakeResp:
        status_code = 200

    def _fake_post(self, url, **kw):
        # While the request is 'in flight', the target host must resolve ONLY
        # to the validated public IP, regardless of what real DNS would say.
        infos = _socket.getaddrinfo('printo.in', 443)
        captured['ips'] = {info[4][0] for info in infos}
        captured['allow_redirects'] = kw.get('allow_redirects')
        return _FakeResp()

    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('93.184.216.34')):
        with mock.patch('requests.Session.post', _fake_post):
            resp = url_safety.post_webhook_safely(
                'https://printo.in/hook', data=b'{}', headers={}, timeout=5,
            )
    assert resp.status_code == 200
    assert captured['ips'] == {'93.184.216.34'}, captured
    assert captured['allow_redirects'] is False
    # getaddrinfo restored after the call.
    assert _socket.getaddrinfo is original


def test_pin_preserves_all_validated_ips_for_fallback():
    """When a host publishes several public records (e.g. Cloudflare-fronted
    printo.in), the pin must expose ALL of them to urllib3 — each with the
    correct family — so a dead first address falls back to the rest instead of
    hard-failing. Every exposed address must still be a validated public IP."""
    import socket as _socket
    from services import url_safety

    captured = {}

    class _FakeResp:
        status_code = 200

    def _fake_post(self, url, **kw):
        infos = _socket.getaddrinfo('multi.example.com', 443)
        # (family, ip) pairs, so we can check each address carries its own family.
        captured['pairs'] = [(info[0], info[4][0]) for info in infos]
        return _FakeResp()

    # Two public IPv4 + one public IPv6 all resolve for the host.
    infos = _addrinfo('93.184.216.34') + _addrinfo('104.16.132.229') + _addrinfo('2606:2800:220:1:248:1893:25c8:1946')
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=infos):
        with mock.patch('requests.Session.post', _fake_post):
            resp = url_safety.post_webhook_safely(
                'https://multi.example.com/hook', data=b'{}', headers={}, timeout=5,
            )
    assert resp.status_code == 200
    # All three validated IPs are exposed to the connection layer (order-agnostic;
    # what matters is the fallback set is complete, not the sort order).
    exposed_ips = {ip for _fam, ip in captured['pairs']}
    assert exposed_ips == {
        '93.184.216.34', '104.16.132.229', '2606:2800:220:1:248:1893:25c8:1946',
    }, captured
    # Each address carries the correct family (IPv6 → AF_INET6, IPv4 → AF_INET),
    # so urllib3 can actually connect on the right socket type.
    for fam, ip in captured['pairs']:
        expected = _socket.AF_INET6 if ':' in ip else _socket.AF_INET
        assert fam == expected, (fam, ip)


def test_pin_raises_on_unsafe_url_before_sending():
    from services import url_safety
    sent = {'called': False}

    def _fake_post(self, url, **kw):
        sent['called'] = True
        return None

    with mock.patch('requests.Session.post', _fake_post):
        try:
            url_safety.post_webhook_safely('https://169.254.169.254/x', data=b'{}', headers={}, timeout=5)
            assert False, "should reject metadata IP before sending"
        except ValidationError:
            pass
    assert sent['called'] is False


def test_rejects_empty_and_overlong():
    try:
        validate_public_https_url('')
        assert False
    except ValidationError:
        pass
    try:
        validate_public_https_url('https://a.com/' + 'x' * 3000)
        assert False
    except ValidationError:
        pass


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
    print(f"All {len(funcs)} url-safety tests passed.")


if __name__ == "__main__":
    _run_all()
