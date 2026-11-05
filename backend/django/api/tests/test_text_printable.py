"""
POST /api/text/printable — the editor's "this text won't print" check.

The rule (which characters a font file has) is pinned DB-free by
services/tests/test_text_coverage.py. These pin the endpoint around it: it
needs an API key, answers per text box in order, checks an unlisted family
against Inter as the print would draw it, refuses oversized requests, and
answers "unknown" rather than "printable" when a font can't be read.

Needs Postgres, like the rest of api/tests/.
"""
from unittest import mock

from django.test import Client, TestCase

from api.models import APIKey
from services import google_fonts as gf
from services import text_coverage as tc

MAN_DANCING = "\U0001F57A"
MUSICAL_NOTES = "\U0001F3B6"


class TextPrintableTest(TestCase):

    def setUp(self):
        self.client = Client()
        self.key = APIKey.objects.create(name='text-printable-test', key='test-text-printable-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        gf.clear_caches()
        tc._COVERAGE.clear()
        patcher = mock.patch.object(gf, 'allowed_families', lambda: [gf.DEFAULT_FONT])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(gf.clear_caches)

    def _post(self, body, **headers):
        return self.client.post('/api/text/printable', data=body, content_type='application/json', **(headers or self.auth))

    def test_needs_an_api_key(self):
        res = self.client.post('/api/text/printable', data={'items': []}, content_type='application/json')
        self.assertIn(res.status_code, (401, 403))

    def test_answers_each_text_box_in_order(self):
        res = self._post({'items': [
            {'text': 'Won the argument, still love her!', 'fontFamily': 'Inter'},
            {'text': f'{MAN_DANCING} {MUSICAL_NOTES}', 'fontFamily': 'Inter'},
            {'text': 'Café ₹500'},
        ]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['results'], [
            {'unprintable': [], 'checked': True},
            {'unprintable': [MAN_DANCING, MUSICAL_NOTES], 'checked': True},
            {'unprintable': [], 'checked': True},
        ])

    def test_an_unlisted_family_is_checked_against_inter(self):
        res = self._post({'items': [{'text': f'Ω {MAN_DANCING}', 'fontFamily': 'Not On The List'}]})
        self.assertEqual(res.json()['results'], [{'unprintable': [MAN_DANCING], 'checked': True}])

    def test_a_font_that_cannot_be_read_is_unknown_not_printable(self):
        with mock.patch.object(gf, 'allowed_families', lambda: ['Pacifico', gf.DEFAULT_FONT]), \
                mock.patch.object(gf, '_read_cached', lambda name: None), \
                mock.patch.object(gf, 'http_get', mock.Mock(side_effect=OSError('offline'))):
            res = self._post({'items': [
                {'text': MAN_DANCING, 'fontFamily': 'Pacifico'},
                {'text': MAN_DANCING, 'fontFamily': 'Inter'},
            ]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['results'], [
            {'unprintable': [], 'checked': False},
            {'unprintable': [MAN_DANCING], 'checked': True},
        ])

    def test_refuses_a_malformed_or_oversized_request(self):
        for body in (
            {},
            {'items': 'abc'},
            {'items': [{'fontFamily': 'Inter'}]},
            {'items': [{'text': 5}]},
            {'items': [{'text': 'x' * 5001}]},
            {'items': [{'text': 'a'}] * 501},
        ):
            res = self._post(body)
            self.assertEqual(res.status_code, 400, body if len(str(body)) < 80 else 'oversized body')

    def test_get_is_not_allowed(self):
        res = self.client.get('/api/text/printable', **self.auth)
        self.assertEqual(res.status_code, 405)


class FontFileTest(TestCase):
    """GET /api/fonts/file/<family> hands the editor the print's own font file."""

    def setUp(self):
        self.client = Client()
        self.key = APIKey.objects.create(name='font-file-test', key='test-font-file-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        gf.clear_caches()
        self.addCleanup(gf.clear_caches)

    def test_needs_an_api_key(self):
        self.assertIn(self.client.get('/api/fonts/file/Inter').status_code, (401, 403))

    def test_serves_the_file_the_print_loads(self):
        from services.fonts import bundled_font_data
        with mock.patch.object(gf, 'allowed_families', lambda: ['Pacifico', gf.DEFAULT_FONT]):
            gf._BYTES_CACHE[gf.cache_name('Pacifico', 400)] = b'\x00\x01\x00\x00 pacifico bytes'
            listed = self.client.get('/api/fonts/file/Pacifico', **self.auth)
            default = self.client.get('/api/fonts/file/Inter', **self.auth)
            unlisted = self.client.get('/api/fonts/file/Not%20On%20The%20List', **self.auth)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed['Content-Type'], 'font/ttf')
        self.assertIn('max-age=86400', listed['Cache-Control'])
        self.assertEqual(listed.content, b'\x00\x01\x00\x00 pacifico bytes')
        self.assertEqual(default.content, bundled_font_data())
        self.assertEqual(unlisted.content, bundled_font_data())

    def test_a_font_that_cannot_be_read_is_a_503(self):
        with mock.patch.object(gf, 'allowed_families', lambda: ['Pacifico', gf.DEFAULT_FONT]), \
                mock.patch.object(gf, '_read_cached', lambda name: None), \
                mock.patch.object(gf, 'http_get', mock.Mock(side_effect=OSError('offline'))):
            res = self.client.get('/api/fonts/file/Pacifico', **self.auth)
        self.assertEqual(res.status_code, 503)

    def test_writes_are_not_allowed(self):
        for method in (self.client.post, self.client.put, self.client.delete):
            self.assertEqual(method('/api/fonts/file/Inter', **self.auth).status_code, 405)
