"""
The icon endpoints: GET /api/icons/<prefix>/<name>.svg and GET /api/icon-search.

The store behind them (fetch once, keep for good, spend within a cap) is
pinned DB-free by services/tests/test_icon_store.py. These pin the endpoints
around it: the picture is public and safe to serve from our origin, the search
needs an API key, and "cannot fetch just now" is a 503 with Retry-After,
never a 404 and never a broken 200.

Needs Postgres, like the rest of api/tests/. Iconify, the cache and the
storage root are stand-ins; nothing leaves the machine.
"""
from django.test import Client, TestCase

from api.models import APIKey
from services.tests.test_icon_store import HEART, Env


class IconEndpointsTest(TestCase):

    def setUp(self):
        self.client = Client()
        self.key = APIKey.objects.create(name='icons-test', key='test-icons-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        self.env = Env()
        self.env.__enter__()
        self.addCleanup(self.env.__exit__, None, None, None)

    def test_the_icon_is_public_cached_for_a_year_and_sandboxed(self):
        res = self.client.get('/api/icons/mdi/heart.svg')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, HEART)
        self.assertEqual(res['Content-Type'], 'image/svg+xml')
        self.assertEqual(res['Cache-Control'], 'public, max-age=31536000, immutable')
        self.assertEqual(res['X-Content-Type-Options'], 'nosniff')
        self.assertIn('sandbox', res['Content-Security-Policy'])

    def test_a_second_request_does_not_go_back_to_iconify(self):
        self.client.get('/api/icons/mdi/heart.svg')
        self.client.get('/api/icons/mdi/heart.svg')
        self.assertEqual(len(self.env.iconify.calls), 1)

    def test_an_unknown_icon_is_a_404(self):
        self.assertEqual(self.client.get('/api/icons/mdi/no-such-icon.svg').status_code, 404)

    def test_a_name_that_is_not_an_icon_name_is_a_404_and_reaches_nobody(self):
        for path in ('/api/icons/MDI/heart.svg', '/api/icons/mdi/a%20b.svg', '/api/icons/mdi/..%2Fx.svg'):
            self.assertEqual(self.client.get(path).status_code, 404, path)
        self.assertEqual(self.env.iconify.calls, [])

    def test_iconify_refusing_is_a_503_with_retry_after(self):
        self.env.iconify.status = 429
        res = self.client.get('/api/icons/mdi/heart.svg')
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res['Retry-After'], '60')

    def test_icons_only_answer_get(self):
        for method in (self.client.post, self.client.put, self.client.delete):
            self.assertEqual(method('/api/icons/mdi/heart.svg', **self.auth).status_code, 405)

    def test_the_search_needs_an_api_key(self):
        self.assertIn(self.client.get('/api/icon-search?q=love').status_code, (401, 403))

    def test_the_search_names_icons_and_warms_them(self):
        res = self.client.get('/api/icon-search?q=love', **self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['icons'][:3], [
            {'prefix': 'mdi', 'name': 'heart'}, {'prefix': 'mdi', 'name': 'star'}, {'prefix': 'wide', 'name': 'banner'},
        ])
        before = len(self.env.iconify.calls)
        self.assertEqual(self.client.get('/api/icons/mdi/star.svg').status_code, 200)
        self.assertEqual(len(self.env.iconify.calls), before)

    def test_a_search_we_will_not_send_is_a_400(self):
        for q in ('', 'a', 'x' * 51, 'a%3Fb%3Dc'):
            self.assertEqual(self.client.get(f'/api/icon-search?q={q}', **self.auth).status_code, 400, q)
        self.assertEqual(self.env.iconify.calls, [])

    def test_a_search_iconify_refuses_is_a_503_with_retry_after(self):
        self.env.iconify.status = 429
        res = self.client.get('/api/icon-search?q=love', **self.auth)
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res['Retry-After'], '60')
