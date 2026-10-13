"""Layout templates against Postgres: the model, the customer reads, the ops
writes, the embed session's `template_id` / `template_flow`, `editor/init`'s
`template` and the live `templateCount` on the layout lists.

Run with: docker-compose exec backend python manage.py test api.tests.test_layout_templates
"""
import io
import os
import shutil
import tempfile

from django.test import TestCase, override_settings
from PIL import Image

from api.models import APIKey, LayoutCatalogue, LayoutTemplate

LAYOUT = {
    'name': 'tpl_test_4x6', 'productType': 'single_canvas', 'type': 'single',
    'canvas': {'width': 1800, 'height': 1200, 'widthMm': 152.4, 'heightMm': 101.6, 'dpi': 300},
    'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.8, 'height': 0.8}],
}

DECO = {'surfaces': {'default': {
    'bgColor': '#fff4e6',
    'overlays': [
        {'type': 'text', 'x': 50, 'y': 8, 'text': 'Happy Birthday', 'fontSize': 72,
         'color': '#64318E', 'fontFamily': 'Lobster', 'textAlign': 'center', 'rotation': 0},
        {'type': 'image', 'source': 'clipart', 'src': '/api/templates/assets/sticker_0123456789abcdef.png',
         'x': 5, 'y': 80, 'width': 15, 'height': 15, 'rotation': 0, 'opacity': 1, 'label': 'balloon'},
    ],
}}}


def _png_bytes(w=64, h=64):
    buf = io.BytesIO()
    Image.new('RGBA', (w, h), (255, 0, 0, 128)).save(buf, format='PNG')
    return buf.getvalue()


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='pe-tpl-')
        self.layout = LayoutCatalogue.objects.create(name='tpl_test_4x6', definition=LAYOUT, product_type='single_canvas')
        self.ops = APIKey.objects.create(name='tpl-ops', key='tpl-ops-key', is_ops_team=True)
        self.partner = APIKey.objects.create(name='tpl-partner', key='tpl-partner-key', is_ops_team=False)
        self.ops_auth = {'HTTP_AUTHORIZATION': f'Bearer {self.ops.key}'}
        self.partner_auth = {'HTTP_AUTHORIZATION': f'Bearer {self.partner.key}'}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make(self, tid='retro-birthday', status='published', **over):
        fields = dict(template_id=tid, layout=self.layout, display_name='Retro Birthday',
                      status=status, decoration=DECO, layout_version=self.layout.version)
        fields.update(over)
        return LayoutTemplate.objects.create(**fields)


class ModelTest(_Base):
    def test_id_is_a_slug_and_immutable(self):
        t = self.make()
        with self.assertRaises(ValueError):
            self.make(tid='Not A Slug')
        t.template_id = 'other-id'
        with self.assertRaises(ValueError):
            t.save()
        with self.assertRaises(ValueError):
            self.make(tid='x', status='live')

    def test_published_means_published_and_not_hidden(self):
        t = self.make()
        self.assertTrue(t.is_published)
        t.is_deleted = True
        self.assertFalse(t.is_published)
        self.assertFalse(self.make(tid='d', status='draft').is_published)


class CustomerReadsTest(_Base):
    def test_list_shows_only_published_templates_of_that_layout(self):
        self.make('pub')
        self.make('draft-one', status='draft')
        hidden = self.make('hidden'); hidden.is_deleted = True; hidden.save()
        other = LayoutCatalogue.objects.create(name='tpl_other', definition={**LAYOUT, 'name': 'tpl_other'})
        LayoutTemplate.objects.create(template_id='elsewhere', layout=other, display_name='x', status='published', decoration=DECO)

        res = self.client.get('/api/templates?layout=tpl_test_4x6', **self.partner_auth)
        self.assertEqual(res.status_code, 200)
        ids = [t['id'] for t in res.json()['templates']]
        self.assertEqual(ids, ['pub'])
        self.assertEqual(res.json()['templates'][0]['layoutName'], 'tpl_test_4x6')
        self.assertEqual(res.json()['templates'][0]['decoration'], DECO)

        self.assertEqual(self.client.get('/api/templates', **self.partner_auth).status_code, 400)
        self.assertEqual(self.client.get('/api/templates?layout=nope', **self.partner_auth).status_code, 404)
        # No credentials: DRF answers 403 here (no WWW-Authenticate scheme), as every other view does.
        self.assertEqual(self.client.get('/api/templates?layout=tpl_test_4x6').status_code, 403)

    def test_detail_returns_published_only(self):
        self.make('pub'); self.make('draft-one', status='draft')
        ok = self.client.get('/api/templates/pub', **self.partner_auth)
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()['layoutName'], 'tpl_test_4x6')
        self.assertEqual(self.client.get('/api/templates/draft-one', **self.partner_auth).status_code, 404)
        self.assertEqual(self.client.get('/api/templates/missing', **self.partner_auth).status_code, 404)

    def test_editor_init_carries_the_template(self):
        self.make('pub'); self.make('draft-one', status='draft')
        res = self.client.get('/api/editor/init?layout=tpl_test_4x6&template=pub', **self.partner_auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['template']['id'], 'pub')
        self.assertEqual(res.json()['layout']['name'], 'tpl_test_4x6')
        plain = self.client.get('/api/editor/init?layout=tpl_test_4x6', **self.partner_auth)
        self.assertIsNone(plain.json()['template'])
        self.assertEqual(self.client.get('/api/editor/init?layout=tpl_test_4x6&template=draft-one', **self.partner_auth).status_code, 404)
        self.assertEqual(self.client.get('/api/editor/init?layout=tpl_test_4x6&template=Bad%20Id', **self.partner_auth).status_code, 400)

    def test_layout_lists_count_templates_live(self):
        from django.core.cache import cache
        cache.delete_many(['layouts_list_all', 'ops_layouts_list_all'])
        before = self.client.get('/api/layouts', **self.partner_auth).json()['layouts']
        self.assertEqual([l['templateCount'] for l in before if l['name'] == 'tpl_test_4x6'], [0])
        self.make('pub'); self.make('draft-one', status='draft')
        # The list itself is cached for 2 min; the count must not be.
        after = self.client.get('/api/layouts', **self.partner_auth).json()['layouts']
        self.assertEqual([l['templateCount'] for l in after if l['name'] == 'tpl_test_4x6'], [1])
        summary = self.client.get('/api/layouts?fields=summary', **self.partner_auth).json()['layouts']
        self.assertEqual([l['templateCount'] for l in summary if l['name'] == 'tpl_test_4x6'], [1])
        ops = self.client.get('/api/ops/layouts', **self.ops_auth).json()['layouts']
        self.assertEqual([l['templateCount'] for l in ops if l['name'] == 'tpl_test_4x6'], [2])


class OpsWritesTest(_Base):
    def test_create_update_publish_and_hide(self):
        body = {'id': 'retro-birthday', 'layout': 'tpl_test_4x6', 'display_name': 'Retro Birthday', 'decoration': DECO}
        res = self.client.post('/api/ops/templates', body, content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()['status'], 'draft')
        self.assertEqual(res.json()['layoutVersion'], self.layout.version)
        self.assertFalse(res.json()['layoutChanged'])

        # Drafts are invisible to customers until published.
        self.assertEqual(self.client.get('/api/templates/retro-birthday', **self.partner_auth).status_code, 404)
        res = self.client.post('/api/ops/templates/retro-birthday', {'status': 'published'},
                               content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.client.get('/api/templates/retro-birthday', **self.partner_auth).status_code, 200)

        # The ops list carries drafts and the layout-changed flag.
        # An ops save bumps `version` (LayoutManagementView.post); the model
        # itself doesn't, so bump it the way that view does.
        self.layout.definition = {**LAYOUT, 'tags': ['x']}; self.layout.version += 1; self.layout.save()
        listed = self.client.get('/api/ops/templates?layout=tpl_test_4x6', **self.ops_auth).json()['templates']
        self.assertEqual(listed[0]['id'], 'retro-birthday')
        self.assertTrue(listed[0]['layoutChanged'])

        # A re-saved decoration is made against the layout as it is now.
        res = self.client.post('/api/ops/templates/retro-birthday', {'decoration': DECO},
                               content_type='application/json', **self.ops_auth)
        self.assertFalse(res.json()['layoutChanged'])

        res = self.client.delete('/api/ops/templates/retro-birthday', **self.ops_auth)
        self.assertEqual(res.status_code, 204)
        self.assertEqual(self.client.get('/api/templates/retro-birthday', **self.partner_auth).status_code, 404)
        self.assertEqual(self.client.get('/api/ops/templates?layout=tpl_test_4x6', **self.ops_auth).json()['templates'], [])
        self.assertTrue(LayoutTemplate.objects.get(template_id='retro-birthday').is_deleted)

    def test_rejections(self):
        base = {'layout': 'tpl_test_4x6', 'display_name': 'x', 'decoration': DECO}
        post = lambda body, **kw: self.client.post('/api/ops/templates', body, content_type='application/json', **kw)
        self.assertEqual(post({**base, 'id': 'Bad Id'}, **self.ops_auth).status_code, 400)
        self.assertEqual(post({**base, 'id': 'ok', 'layout': 'missing_layout'}, **self.ops_auth).status_code, 400)
        local = {'surfaces': {'default': {'overlays': [{'type': 'image', 'source': 'local', 'src': 'blob:x',
                                                         'x': 0, 'y': 0, 'width': 10, 'height': 10}]}}}
        self.assertEqual(post({**base, 'id': 'ok', 'decoration': local}, **self.ops_auth).status_code, 400)
        self.assertEqual(post({'id': 'ok', 'layout': 'tpl_test_4x6'}, **self.ops_auth).status_code, 400)
        self.assertEqual(post({**base, 'id': 'ok'}, **self.partner_auth).status_code, 403)
        self.assertEqual(post({**base, 'id': 'ok'}).status_code, 403)
        self.assertEqual(post({**base, 'id': 'ok'}, **self.ops_auth).status_code, 201)
        # Immutable layout.
        other = LayoutCatalogue.objects.create(name='tpl_other', definition={**LAYOUT, 'name': 'tpl_other'})
        moved = self.client.post('/api/ops/templates/ok', {'layout': other.name}, content_type='application/json', **self.ops_auth)
        self.assertEqual(moved.status_code, 400)

    def test_sticker_upload_and_download(self):
        with override_settings(STORAGE_ROOT=self.tmp, STORAGE_BACKEND='local'):
            png = _png_bytes()
            up = io.BytesIO(png); up.name = 'balloon.png'
            res = self.client.post('/api/ops/templates/assets', {'file': up}, **self.ops_auth)
            self.assertEqual(res.status_code, 201, res.content)
            url = res.json()['url']
            self.assertTrue(url.startswith('/api/templates/assets/sticker_'))
            # Same bytes, same address.
            up2 = io.BytesIO(png); up2.name = 'again.png'
            self.assertEqual(self.client.post('/api/ops/templates/assets', {'file': up2}, **self.ops_auth).json()['url'], url)
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, 'stickers', os.path.basename(url))))

            got = self.client.get(url)
            self.assertEqual(got.status_code, 200)
            self.assertEqual(got['Content-Type'], 'image/png')
            self.assertEqual(b''.join(got.streaming_content), png)
            self.assertEqual(self.client.get('/api/templates/assets/missing.png').status_code, 404)
            self.assertIn(self.client.get('/api/templates/assets/..%2Fx.png').status_code, (400, 404))

            jpg = io.BytesIO(b'\xff\xd8\xff\xe0 not a png'); jpg.name = 'x.jpg'
            self.assertEqual(self.client.post('/api/ops/templates/assets', {'file': jpg}, **self.ops_auth).status_code, 400)
            self.assertEqual(self.client.post('/api/ops/templates/assets', {}, **self.ops_auth).status_code, 400)
            self.assertEqual(self.client.post('/api/ops/templates/assets', {'file': io.BytesIO(png)}, **self.partner_auth).status_code, 403)

    def test_thumbnail_is_stored_with_the_template(self):
        with override_settings(STORAGE_ROOT=self.tmp, STORAGE_BACKEND='local'):
            import json
            thumb = io.BytesIO(_png_bytes(120, 80)); thumb.name = 'thumb.png'
            res = self.client.post('/api/ops/templates', {
                'template_data': json.dumps({'id': 'with-thumb', 'layout': 'tpl_test_4x6',
                                             'display_name': 'With thumb', 'decoration': DECO}),
                'thumbnail': thumb,
            }, **self.ops_auth)
            self.assertEqual(res.status_code, 201, res.content)
            self.assertTrue(res.json()['thumbnailUrl'].startswith('/api/templates/assets/thumb_'))


class EmbedSessionTest(_Base):
    def test_template_id_resolves_the_layout_into_editor_url(self):
        self.make('retro-birthday')
        res = self.client.post('/api/embed/session', {'order_id': 'ORD-1', 'template_id': 'retro-birthday'},
                               content_type='application/json', **self.partner_auth)
        self.assertEqual(res.status_code, 201, res.content)
        data = res.json()
        self.assertEqual(data['template_id'], 'retro-birthday')
        self.assertEqual(data['editor_url'], f"/editor/layout/tpl_test_4x6?token={data['token']}&template=retro-birthday")
        self.assertEqual(data['embed_url_template'], '/editor/layout/{layout_name}?token=' + data['token'])

    def test_template_flow_rides_on_the_address(self):
        res = self.client.post('/api/embed/session', {'template_flow': True},
                               content_type='application/json', **self.partner_auth)
        self.assertEqual(res.status_code, 201)
        self.assertTrue(res.json()['template_flow'])
        self.assertTrue(res.json()['embed_url_template'].endswith('&template_flow=1'))
        self.assertIsNone(res.json()['editor_url'])
        plain = self.client.post('/api/embed/session', {}, content_type='application/json', **self.partner_auth).json()
        self.assertFalse(plain['template_flow'])
        self.assertIsNone(plain['template_id'])
        self.assertIsNone(plain['editor_url'])

    def test_unpublished_or_unknown_template_id_is_refused(self):
        self.make('draft-one', status='draft')
        for tid in ('draft-one', 'missing', 'Bad Id'):
            res = self.client.post('/api/embed/session', {'template_id': tid},
                                   content_type='application/json', **self.partner_auth)
            self.assertEqual(res.status_code, 400, tid)
