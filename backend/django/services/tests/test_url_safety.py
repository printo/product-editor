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
