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
        'https://100.100.100.200/latest/meta-data',    # Alibaba metadata, shared address space
        'https://100.64.0.1/x',                        # carrier-grade NAT, 100.64.0.0/10
        'https://100.127.255.254/x',
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


def test_the_edges_of_the_shared_address_space_are_judged_exactly():
    from services.url_safety import _is_public_ip

    assert not _is_public_ip('100.64.0.0') and not _is_public_ip('100.127.255.255')
    assert _is_public_ip('100.63.255.255') and _is_public_ip('100.128.0.1')
    assert not _is_public_ip('::ffff:100.100.100.200')  # mapped form is judged on the v4


def test_accepts_public_ipv6():
    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('2606:2800:220:1:248:1893:25c8:1946')):
        ips = validate_public_https_url('https://ipv6.example.com/x')
        assert ips and not ips[0].startswith('fc'), ips


def test_the_pinned_connection_dials_the_validated_ip_and_never_resolves_the_name():
    """A connection opens its socket to the validated address directly. The host
    name is not looked up at connect time, so DNS cannot rebind it; `.invalid`
    never resolves, and getaddrinfo is made to fail to prove nothing asks."""
    import socket as _socket
    import threading
    from services import url_safety

    listener = _socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    accepted = []
    t = threading.Thread(target=lambda: accepted.append(listener.accept()[1]), daemon=True)
    t.start()

    real = _socket.getaddrinfo

    def only_literals(host, *a, **kw):
        # socket.create_connection itself asks about the IP literal; the host
        # NAME must never be asked about.
        assert host != 'pinned.invalid', 'the name was resolved'
        return real(host, *a, **kw)

    pool = url_safety._pinned_pool_class(['127.0.0.1'])('pinned.invalid', port=port)
    with mock.patch('socket.getaddrinfo', only_literals):
        conn = pool.ConnectionCls('pinned.invalid', port=port, timeout=5)
        sock = conn._new_conn()
    t.join(5)
    sock.close()
    listener.close()
    assert accepted and accepted[0][0] == '127.0.0.1', accepted


def test_the_pin_tries_each_validated_address_in_turn_and_never_another():
    """A host with several public records stays reachable when the first is
    down (the fallback the old resolver pin kept), and a connection that
    exhausts them fails rather than dialling anything else."""
    import socket as _socket
    from urllib3.exceptions import NewConnectionError
    from services import url_safety

    dialled = []
    good = mock.Mock()

    def fake_create(address, timeout=None, source_address=None):
        dialled.append(address[0])
        if address[0] == '93.184.216.34':
            raise ConnectionRefusedError('down')
        return good

    pool = url_safety._pinned_pool_class(['93.184.216.34', '104.16.132.229', '2606:2800:220:1:248:1893:25c8:1946'])('multi.example.com', port=443)
    conn = pool.ConnectionCls('multi.example.com', port=443, timeout=5)
    with mock.patch('socket.create_connection', fake_create):
        assert conn._new_conn() is good
    assert dialled == ['93.184.216.34', '104.16.132.229'], dialled

    dialled.clear()
    with mock.patch('socket.create_connection', side_effect=ConnectionRefusedError('all down')) as c:
        try:
            conn._new_conn()
            raise AssertionError('a connection with no reachable address succeeded')
        except NewConnectionError:
            pass
        assert [call.args[0][0] for call in c.call_args_list] == [
            '93.184.216.34', '104.16.132.229', '2606:2800:220:1:248:1893:25c8:1946',
        ]


def test_the_pin_patches_nothing_process_wide():
    """socket.getaddrinfo is the same object before, during and after a request,
    so another thread's fetch is never waiting on, or redirected by, this one."""
    import socket as _socket
    from services import url_safety

    original = _socket.getaddrinfo
    seen = {}

    def _fake_post(self, url, **kw):
        seen['during'] = _socket.getaddrinfo
        seen['trust_env'] = self.trust_env
        seen['redirects'] = kw.get('allow_redirects')
        return mock.Mock(status_code=200)

    with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('93.184.216.34')) as resolver:
        with mock.patch('requests.Session.post', _fake_post):
            url_safety.post_webhook_safely('https://printo.in/hook', data=b'{}', headers={}, timeout=5)
        assert seen['during'] is resolver                  # untouched while the request is in flight
    assert _socket.getaddrinfo is original
    assert not hasattr(url_safety, '_PIN_LOCK')
    assert seen['trust_env'] is False and seen['redirects'] is False


def test_a_slow_fetch_does_not_hold_up_another():
    """The old pin held one lock for the whole connect, so a host that was slow
    to answer queued every other fetch in the process behind it."""
    import threading
    import time
    from services import url_safety

    started, release = threading.Event(), threading.Event()

    def slow_get(self, url, **kw):
        started.set()
        release.wait(5)
        return mock.Mock(status_code=200)

    def fast_get(self, url, **kw):
        return mock.Mock(status_code=200)

    results = {}

    def run(name, host):
        with mock.patch('services.url_safety.validate_public_https_url', return_value=['93.184.216.34']):
            results[name] = url_safety.open_public_get(f'https://{host}/a.jpg', timeout=5)

    with mock.patch('requests.Session.get', lambda self, url, **kw: slow_get(self, url, **kw) if 'slow' in url else fast_get(self, url, **kw)):
        slow = threading.Thread(target=run, args=('slow', 'slow.example.com'))
        slow.start()
        assert started.wait(5)
        t0 = time.time()
        run('fast', 'fast.example.com')
        elapsed = time.time() - t0
        release.set()
        slow.join(5)
    assert 'fast' in results and elapsed < 1.0, elapsed


def test_a_real_request_reaches_the_pinned_address_over_tls():
    """End to end with a real TLS server on 127.0.0.1: the URL names a host that
    does not resolve, the connection goes to the pinned address, and the
    certificate is still checked against the URL's host name."""
    import shutil
    import socket as _socket
    import ssl
    import subprocess
    import tempfile
    import threading
    from services import url_safety

    if not shutil.which('openssl'):
        print('    (skipped: no openssl)')
        return
    tmp = tempfile.mkdtemp(prefix='pin-tls-')
    key, crt = f'{tmp}/k.pem', f'{tmp}/c.pem'
    subprocess.run([
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1',
        '-subj', '/CN=pinned.example.test', '-addext', 'subjectAltName=DNS:pinned.example.test',
    ], check=True, capture_output=True)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    server = _socket.socket()
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    port = server.getsockname()[1]
    got = {}

    def serve():
        conn, _ = server.accept()
        with ctx.wrap_socket(conn, server_side=True) as tls:
            got['request'] = tls.recv(4096)
            tls.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')

    t = threading.Thread(target=serve, daemon=True)
    t.start()

    real_post = __import__('requests').Session.post

    def post_trusting_our_cert(self, url, **kw):
        kw['verify'] = crt
        return real_post(self, url, **kw)

    try:
        _socket.getaddrinfo('pinned.example.test', port)
        raise AssertionError('the test host name unexpectedly resolves')
    except _socket.gaierror:
        pass
    with mock.patch('services.url_safety.validate_public_https_url', return_value=['127.0.0.1']):
        with mock.patch('requests.Session.post', post_trusting_our_cert):
            resp = url_safety.post_webhook_safely(
                f'https://pinned.example.test:{port}/hook', data=b'{}', headers={}, timeout=5,
            )
    t.join(5)
    server.close()
    shutil.rmtree(tmp, ignore_errors=True)
    assert resp.status_code == 200 and resp.content == b'ok'
    assert b'POST /hook' in got['request'] and b'Host: pinned.example.test' in got['request']


def test_streamed_get_refuses_an_unsafe_url_before_connecting():
    from services import url_safety
    called = {'n': 0}

    def _fake_get(self, url, **kw):
        called['n'] += 1

    with mock.patch('requests.Session.get', _fake_get):
        for url in ('http://files.example.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://169.254.169.254/latest'):
            try:
                url_safety.open_public_get(url, timeout=5)
                raise AssertionError(f'{url} was not refused')
            except ValidationError:
                pass
        with mock.patch('services.url_safety.socket.getaddrinfo', return_value=_addrinfo('10.0.0.7')):
            try:
                url_safety.open_public_get('https://files.example.com/a.jpg', timeout=5)
                raise AssertionError('a host resolving to a private address was not refused')
            except ValidationError:
                pass
    assert called['n'] == 0


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
