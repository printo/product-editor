"""
Fetching the artwork of an imported design (services/design_import.py): which
addresses may be fetched, what comes back, and how a refusal is worded.
DB-free. The endpoint is covered in api/tests/test_design_import.py, and the
fetch this goes through in test_photo_fetch.py.
"""
import os
import tempfile
from unittest import mock

from django.core.exceptions import ValidationError

from services import design_import, photo_fetch
from services.design_import import MAX_ARTWORK_BYTES, ArtworkFetchError, fetch_artwork, sniff_artwork

HOSTS = ['files.example.com']
URL = 'https://files.example.com/site/20200730_Asset_9.svg'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 40
JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 40
SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>x</script></svg>'


class _Response:
    def __init__(self, status=200, chunks=(SVG,), headers=None):
        self.status_code = status
        self._chunks = chunks
        self.headers = headers or {}

    def iter_content(self, chunk_size=None):
        yield from self._chunks

    def close(self):
        pass


def _fetch(response=None, error=None, **kwargs):
    """Run fetch_artwork against a stand-in connection; returns (result or the refusal, opener)."""
    opener = mock.Mock(side_effect=error) if error else mock.Mock(return_value=response)
    with mock.patch.object(photo_fetch, 'open_public_get', opener):
        try:
            result = fetch_artwork(kwargs.pop('url', URL), allowed_hosts=kwargs.pop('hosts', HOSTS), **kwargs)
        except ArtworkFetchError as exc:
            result = exc
    return result, opener


def test_what_a_file_is_comes_from_its_first_bytes():
    assert sniff_artwork(PNG) == 'png'
    assert sniff_artwork(JPEG) == 'jpeg'
    assert sniff_artwork(SVG) == 'svg'
    assert sniff_artwork(b'\xef\xbb\xbf  <svg viewBox="0 0 1 1"/>') == 'svg'
    assert sniff_artwork(b'<!DOCTYPE svg PUBLIC "a" "b"><svg/>') == 'svg'
    assert sniff_artwork(b'<html><body>not found</body></html>') is None
    assert sniff_artwork(b'GIF89a' + b'\x00' * 20) is None
    assert sniff_artwork(b'') is None


def test_an_artwork_comes_back_as_its_bytes_and_kind():
    (data, kind), opener = _fetch(_Response(chunks=(PNG[:10], PNG[10:])))
    assert (data, kind) == (PNG, 'png')
    assert opener.call_count == 1
    (data, kind), _ = _fetch(_Response(chunks=(JPEG,)))
    assert kind == 'jpeg'


def test_an_svg_is_handed_back_untouched_because_the_sticker_upload_checks_it():
    (data, kind), _ = _fetch(_Response(chunks=(SVG,)))
    assert kind == 'svg' and data == SVG


def test_a_host_off_the_list_is_refused_before_anything_is_fetched_and_the_list_is_named():
    result, opener = _fetch(_Response(), url='https://evil.example.org/a.svg', hosts=['files.example.com', 'cdn.example.com'])
    assert isinstance(result, ArtworkFetchError) and result.status == 403
    assert result.detail == 'Artwork can only be fetched from: files.example.com, cdn.example.com.'
    assert opener.call_count == 0


def test_a_blank_list_switches_the_fetch_off():
    for hosts in ([], None):
        result, opener = _fetch(_Response(), hosts=hosts)
        assert isinstance(result, ArtworkFetchError) and result.status == 403 and 'off for this API key' in result.detail
        assert opener.call_count == 0


def test_only_a_plain_https_address_is_fetched():
    for url in ('http://files.example.com/a.svg', 'https://user:pw@files.example.com/a.svg',
                'https://files.example.com:8443/a.svg', '', None):
        result, opener = _fetch(_Response(), url=url)
        assert isinstance(result, ArtworkFetchError) and result.status == 400, url
        assert opener.call_count == 0


def test_an_address_that_is_not_public_is_refused():
    result, _ = _fetch(error=ValidationError('private'))
    assert isinstance(result, ArtworkFetchError) and result.status == 403 and 'not a public address' in result.detail


def test_a_file_over_the_limit_is_refused_while_reading_whatever_the_header_says():
    result, _ = _fetch(_Response(chunks=(b'x' * 600, b'x' * 600)), max_bytes=1000)
    assert isinstance(result, ArtworkFetchError) and result.status == 413
    assert result.detail == f'The artwork file is larger than {MAX_ARTWORK_BYTES // (1024 * 1024)} MB.'
    result, _ = _fetch(_Response(headers={'Content-Length': '99999999'}))
    assert isinstance(result, ArtworkFetchError) and result.status == 413


def test_a_redirect_or_an_error_from_the_host_is_said_about_artwork():
    result, _ = _fetch(_Response(status=302))
    assert isinstance(result, ArtworkFetchError) and result.status == 502
    assert result.detail == 'The artwork link redirects, and redirects are not followed.'
    result, _ = _fetch(_Response(status=404))
    assert result.status == 502 and 'answered 404 for this artwork' in result.detail and 'photo' not in result.detail
    result, _ = _fetch(error=ConnectionError('down'))
    assert result.status == 502 and "Could not reach 'files.example.com'" in result.detail


def test_something_that_is_not_an_image_is_refused():
    result, _ = _fetch(_Response(chunks=(b'<html><body>Not Found</body></html>',)))
    assert isinstance(result, ArtworkFetchError) and result.status == 415
    assert result.detail == 'That address does not hold a PNG, JPEG or SVG image.'


def test_no_file_is_left_behind_either_way():
    folder = tempfile.mkdtemp(prefix='pe-design-import-test-')
    real = tempfile.mkstemp

    def here(prefix=''):
        return real(prefix=prefix, dir=folder)

    with mock.patch.object(design_import.tempfile, 'mkstemp', here):
        _fetch(_Response(chunks=(PNG,)))
        assert os.listdir(folder) == []
        _fetch(_Response(status=500))
        assert os.listdir(folder) == []
        _fetch(_Response(chunks=(b'not an image',)))
        assert os.listdir(folder) == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} design-import tests passed.")
