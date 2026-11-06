"""The design import's server half against Postgres: `POST /api/ops/import/artwork`
(who may call it and what it answers) and `create_only` on the layout write,
which keeps an import from ever replacing a live layout.

Run with: docker-compose exec backend python manage.py test api.tests.test_design_import
"""
import json
from unittest import mock

from django.test import TestCase

from api.models import APIKey, LayoutCatalogue
from services.design_import import ArtworkFetchError

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'
LAYOUT = {
    'name': 'import_test_6x8',
    'canvas': {'width': 1800, 'height': 2400, 'widthMm': 152.4, 'heightMm': 203.2, 'dpi': 300},
    'frames': [{'id': 'import-1', 'x': 0.2, 'y': 0.3, 'width': 0.6, 'height': 0.4,
                'xMm': 30.48, 'yMm': 60.96, 'widthMm': 91.44, 'heightMm': 81.28, 'bleedMm': 0, 'borderRadiusMm': 0}],
    'printSheet': {'mode': 'canvas'},
}


class _Base(TestCase):
    def setUp(self):
        self.ops = APIKey.objects.create(name='import-ops', key='import-ops-key', is_ops_team=True,
                                         allowed_photo_hosts='files.example.com\ncdn.example.com')
        self.partner = APIKey.objects.create(name='import-partner', key='import-partner-key', is_ops_team=False)
        self.ops_auth = {'HTTP_AUTHORIZATION': f'Bearer {self.ops.key}'}
        self.partner_auth = {'HTTP_AUTHORIZATION': f'Bearer {self.partner.key}'}


class ArtworkFetchEndpointTest(_Base):
    URL = '/api/ops/import/artwork'

    def post(self, body, auth=None):
        return self.client.post(self.URL, data=json.dumps(body), content_type='application/json', **(auth or {}))

    def test_only_the_ops_team_may_ask(self):
        with mock.patch('api.views.design_import.fetch_artwork') as fetch:
            self.assertIn(self.post({'url': 'https://files.printo.in/a.svg'}).status_code, (401, 403))
            self.assertEqual(self.post({'url': 'https://files.printo.in/a.svg'}, self.partner_auth).status_code, 403)
            fetch.assert_not_called()

    def test_it_is_a_post_and_nothing_else(self):
        self.assertEqual(self.client.get(self.URL, **self.ops_auth).status_code, 405)

    def test_the_file_comes_back_as_bytes_that_can_never_run_as_a_page(self):
        with mock.patch('api.views.design_import.fetch_artwork', return_value=(SVG, 'svg')) as fetch:
            res = self.post({'url': 'https://files.example.com/site/Asset_9.svg'}, self.ops_auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content, SVG)
        self.assertEqual(res['Content-Type'], 'image/svg+xml')
        self.assertEqual(res['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(res['Content-Disposition'], 'attachment')
        self.assertIn('sandbox', res['Content-Security-Policy'])
        self.assertEqual(res['Cache-Control'], 'no-store')
        # The hosts are the calling key's own list, the one that gates a photo fetch.
        fetch.assert_called_once_with('https://files.example.com/site/Asset_9.svg',
                                      allowed_hosts=['files.example.com', 'cdn.example.com'])

    def test_a_png_is_served_as_a_png(self):
        with mock.patch('api.views.design_import.fetch_artwork', return_value=(b'\x89PNG', 'png')):
            res = self.post({'url': 'https://files.example.com/a.png'}, self.ops_auth)
        self.assertEqual((res.status_code, res['Content-Type']), (200, 'image/png'))

    def test_a_refusal_is_passed_on_with_its_status(self):
        refusal = ArtworkFetchError('The artwork file is larger than 5 MB.', status=413)
        with mock.patch('api.views.design_import.fetch_artwork', side_effect=refusal):
            res = self.post({'url': 'https://files.example.com/big.png'}, self.ops_auth)
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.json()['detail'], 'The artwork file is larger than 5 MB.')

    def test_a_host_off_the_list_is_refused_without_a_fetch(self):
        # No stand-in: the real check runs and must stop before any network call.
        with mock.patch('services.photo_fetch.open_public_get') as opener:
            res = self.post({'url': 'https://evil.example.org/a.svg'}, self.ops_auth)
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()['detail'], 'Artwork can only be fetched from: files.example.com, cdn.example.com.')
        opener.assert_not_called()

    def test_it_is_off_for_a_key_that_lists_no_host(self):
        # The default for every key, the ops ones included: an administrator opts in per key.
        bare = APIKey.objects.create(name='import-ops-bare', key='import-ops-bare-key', is_ops_team=True)
        with mock.patch('services.photo_fetch.open_public_get') as opener:
            res = self.post({'url': 'https://files.example.com/a.svg'}, {'HTTP_AUTHORIZATION': f'Bearer {bare.key}'})
        self.assertEqual(res.status_code, 403)
        self.assertIn('off for this API key', res.json()['detail'])
        opener.assert_not_called()

    def test_a_missing_address_is_a_400(self):
        self.assertEqual(self.post({}, self.ops_auth).status_code, 400)


class FontCheckEndpointTest(_Base):
    URL = '/api/ops/import/font'

    def post(self, body, auth=None):
        return self.client.post(self.URL, data=json.dumps(body), content_type='application/json', **(auth or {}))

    def test_only_the_ops_team_may_ask(self):
        self.assertIn(self.post({'family': 'Lobster'}).status_code, (401, 403))
        self.assertEqual(self.post({'family': 'Lobster'}, self.partner_auth).status_code, 403)

    def test_a_listed_font_is_not_looked_up_again(self):
        with mock.patch('api.views.design_import.is_listed', return_value=True), \
                mock.patch('api.views.design_import.font_available') as available:
            res = self.post({'family': '  Marck   Script '}, self.ops_auth)
        self.assertEqual(res.json(), {'family': 'Marck Script', 'listed': True, 'available': True})
        available.assert_not_called()

    def test_an_unlisted_font_says_whether_it_could_be_printed(self):
        for found in (True, False):
            with mock.patch('api.views.design_import.is_listed', return_value=False), \
                    mock.patch('api.views.design_import.font_available', return_value=found):
                res = self.post({'family': 'Marck Script'}, self.ops_auth)
            self.assertEqual(res.json(), {'family': 'Marck Script', 'listed': False, 'available': found})

    def test_a_missing_family_is_a_400(self):
        self.assertEqual(self.post({'family': '  '}, self.ops_auth).status_code, 400)


class CreateOnlyLayoutTest(_Base):
    def write(self, name, definition, **extra):
        return self.client.post(f'/api/ops/layouts/{name}', data={'layout_data': json.dumps(definition), **extra}, **self.ops_auth)

    def test_a_new_name_is_created(self):
        res = self.write('import_test_6x8', LAYOUT, create_only='1', display_name='Import test')
        self.assertEqual(res.status_code, 200, res.content)
        row = LayoutCatalogue.objects.get(name='import_test_6x8')
        self.assertEqual((row.version, row.display_name), (1, 'Import test'))

    def test_a_name_that_exists_is_refused_and_the_layout_is_left_as_it_was(self):
        LayoutCatalogue.objects.create(name='import_test_6x8', definition=LAYOUT, product_type='single_canvas', display_name='Live one')
        changed = {**LAYOUT, 'frames': []}
        res = self.write('import_test_6x8', changed, create_only='true', display_name='Imported')
        self.assertEqual(res.status_code, 409)
        self.assertIn("already exists", res.json()['detail'])
        row = LayoutCatalogue.objects.get(name='import_test_6x8')
        self.assertEqual((row.version, row.display_name, len(row.definition['frames'])), (1, 'Live one', 1))

    def test_a_retired_name_is_refused_too(self):
        LayoutCatalogue.objects.create(name='import_test_6x8', definition=LAYOUT, product_type='single_canvas', is_deprecated=True)
        self.assertEqual(self.write('import_test_6x8', LAYOUT, create_only='1').status_code, 409)
        self.assertTrue(LayoutCatalogue.objects.get(name='import_test_6x8').is_deprecated)

    def test_without_it_the_same_write_still_updates(self):
        LayoutCatalogue.objects.create(name='import_test_6x8', definition=LAYOUT, product_type='single_canvas')
        res = self.write('import_test_6x8', LAYOUT)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(LayoutCatalogue.objects.get(name='import_test_6x8').version, 2)
