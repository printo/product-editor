"""
Fetching a customer photo from an embedding company's storage
(services/photo_fetch.py): which links may be fetched, and what a fetch refuses.

DB-free. The endpoint is covered in api/tests/test_upload_from_url.py; the
connection pin itself in test_url_safety.py.
"""
import os
import tempfile
from unittest import mock

from django.core.exceptions import ValidationError

from services import photo_fetch
from services.photo_fetch import (
    PhotoFetchError, check_photo_url, fetch_photo, invalid_photo_hosts, name_from_url, parse_photo_hosts,
)

HOSTS = ['files.example.com']
URL = 'https://files.example.com/user/2026_IMG_1234.jpg?sig=secret-token'


class _Response:
    def __init__(self, status=200, chunks=(b'abc', b'def'), headers=None):
        self.status_code = status
        self._chunks = chunks
        self.headers = headers or {}
        self.closed = False

    def iter_content(self, chunk_size=None):
        yield from self._chunks

    def close(self):
        self.closed = True


def _fetch(response=None, error=None, **kwargs):
    """Run fetch_photo against a stand-in connection; returns (result, path, response)."""
    path = os.path.join(tempfile.mkdtemp(prefix='pe-photo-fetch-'), 'fetched.part')
    opener = mock.Mock(side_effect=error) if error else mock.Mock(return_value=response)
    with mock.patch.object(photo_fetch, 'open_public_get', opener):
        try:
            result = fetch_photo(kwargs.pop('url', URL), allowed_hosts=kwargs.pop('hosts', HOSTS),
                                 dest_path=path, max_bytes=kwargs.pop('max_bytes', 1000), **kwargs)
        except PhotoFetchError as exc:
            result = exc
    return result, path, opener


def _refused(fn, *args):
    try:
        fn(*args)
    except PhotoFetchError as exc:
        return exc
    raise AssertionError(f'{args} was not refused')


# ── the host list ────────────────────────────────────────────────────────────

def test_hosts_are_read_one_per_line_or_comma_lowercased_once_each():
    assert parse_photo_hosts('files.Printo.in\n cdn.example.com , files.printo.in.\n') == ['files.printo.in', 'cdn.example.com']
    assert parse_photo_hosts('') == [] and parse_photo_hosts(None) == []


def test_only_plain_host_names_count():
    bad = 'https://files.example.com\n*.example.com\nfiles.example.com/photos\nfiles.example.com:8443\n10.0.0.5\nlocalhost\n-bad.example.com'
    assert parse_photo_hosts(bad) == []
    assert invalid_photo_hosts(bad) == [
        'https://files.example.com', '*.example.com', 'files.example.com/photos',
        'files.example.com:8443', '10.0.0.5', 'localhost', '-bad.example.com',
    ]
    assert invalid_photo_hosts('files.example.com\ncdn.example.co.in') == []


def test_a_typo_can_only_narrow_the_list():
    assert parse_photo_hosts('files.example.com\nhttps://oops.example.com') == ['files.example.com']


# ── which links may be fetched ───────────────────────────────────────────────

def test_a_link_on_a_listed_host_is_accepted():
    assert check_photo_url(URL, HOSTS) == 'files.example.com'
    assert check_photo_url('https://FILES.example.com:443/a.jpg', HOSTS) == 'files.example.com'


def test_a_host_not_on_the_list_is_refused_with_403():
    for url in ('https://evil.example.org/a.jpg', 'https://files.example.com.evil.org/a.jpg',
                'https://sub.files.example.com/a.jpg', 'https://example.com/a.jpg'):
        assert _refused(check_photo_url, url, HOSTS).status == 403, url


def test_an_empty_list_refuses_everything():
    assert _refused(check_photo_url, URL, []).status == 403
    assert _refused(check_photo_url, URL, None).status == 403


def test_anything_but_plain_https_on_the_standard_port_is_refused():
    for url in ('http://files.example.com/a.jpg', 'ftp://files.example.com/a.jpg', 'files.example.com/a.jpg',
                'https://user:pw@files.example.com/a.jpg', 'https://files.example.com:8443/a.jpg',
                'https:///a.jpg', '', None, 'https://files.example.com:notaport/a.jpg',
                'https://files.example.com/' + 'a' * 2100):
        assert _refused(check_photo_url, url, HOSTS).status == 400, url


def test_a_listed_name_does_not_let_an_address_trick_through():
    # The host is compared as written; "@" would otherwise make the real host evil.org.
    assert _refused(check_photo_url, 'https://files.example.com@evil.org/a.jpg', HOSTS).status == 400


def test_the_link_name_is_the_last_part_of_its_path():
    assert name_from_url(URL) == '2026_IMG_1234.jpg'
    assert name_from_url('https://files.example.com/') == '' and name_from_url(None) == ''


# ── the fetch ────────────────────────────────────────────────────────────────

def test_a_good_fetch_writes_the_bytes_and_closes_the_connection():
    response = _Response()
    size, path, opener = _fetch(response)
    assert size == 6
    with open(path, 'rb') as fh:
        assert fh.read() == b'abcdef'
    assert response.closed
    assert opener.call_args.args[0] == URL


def test_a_refused_link_never_opens_a_connection():
    result, path, opener = _fetch(_Response(), url='https://evil.example.org/a.jpg')
    assert isinstance(result, PhotoFetchError) and result.status == 403
    assert not opener.called and not os.path.exists(path)


def test_anything_but_200_is_a_failure_and_redirects_are_not_followed():
    for status in (301, 302, 307, 403, 404, 500):
        response = _Response(status=status)
        result, path, _ = _fetch(response)
        assert isinstance(result, PhotoFetchError) and result.status == 502, status
        assert not os.path.exists(path) and response.closed
    assert 'redirect' in _fetch(_Response(status=302))[0].detail


def test_a_declared_size_over_the_limit_is_refused_before_reading():
    response = _Response(headers={'Content-Length': '5000'})
    result, path, _ = _fetch(response)
    assert result.status == 413 and not os.path.exists(path) and response.closed


def test_the_size_is_counted_while_reading_whatever_the_host_declares():
    lying = _Response(chunks=(b'x' * 600, b'x' * 600), headers={'Content-Length': '10'})
    result, path, _ = _fetch(lying)
    assert result.status == 413 and not os.path.exists(path)
    silent = _Response(chunks=(b'x' * 1001,))
    assert _fetch(silent)[0].status == 413
    assert _fetch(_Response(chunks=(b'x' * 1000,)))[0] == 1000        # exactly the limit is fine


def test_an_empty_file_is_a_failure():
    result, path, _ = _fetch(_Response(chunks=()))
    assert result.status == 502 and not os.path.exists(path)


def test_a_slow_trickle_hits_the_deadline():
    clock = iter([0.0, 10.0, 70.0, 80.0])
    with mock.patch.object(photo_fetch.time, 'monotonic', lambda: next(clock)):
        result, path, _ = _fetch(_Response(chunks=(b'a', b'b', b'c')), deadline_s=60)
    assert result.status == 504 and not os.path.exists(path)


def test_a_host_that_is_not_public_is_refused_with_403():
    result, path, _ = _fetch(error=ValidationError('callback_url host is not publicly routable.'))
    assert result.status == 403 and 'not a public address' in result.detail and not os.path.exists(path)


def test_an_unreachable_host_or_a_broken_download_is_502():
    assert _fetch(error=ConnectionError('boom'))[0].status == 502

    class _Breaks(_Response):
        def iter_content(self, chunk_size=None):
            yield b'abc'
            raise ConnectionError('reset')
    response = _Breaks()
    result, path, _ = _fetch(response)
    assert result.status == 502 and not os.path.exists(path) and response.closed


def test_what_the_caller_is_told_never_repeats_the_links_signature():
    for response, error in ((_Response(status=404), None), (None, ConnectionError('x')),
                            (_Response(headers={'Content-Length': '5000'}), None)):
        result = _fetch(response, error=error)[0]
        assert 'secret-token' not in result.detail and 'sig=' not in result.detail


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} photo-fetch tests passed.")
