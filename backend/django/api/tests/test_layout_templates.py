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
        # The stored decoration, plus the home geometry every read derives.
        self.assertEqual(res.json()['templates'][0]['decoration']['surfaces'], DECO['surfaces'])
        self.assertEqual(res.json()['templates'][0]['decoration']['authoredOn']['layout'], 'tpl_test_4x6')

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


# The home layout's window is 121.92 x 81.28 mm (frames 0.1..0.9 of a
# 152.4 x 101.6 canvas): key 122x81. The same window centred in a wider
# canvas — a thicker frame picture — keys the same; a narrower window does not.
HALF_INCH_FRAME = {
    'name': 'tpl_frame_half', 'productType': 'single_canvas', 'type': 'single',
    'canvas': {'width': 2100, 'height': 1500, 'widthMm': 177.8, 'heightMm': 127, 'dpi': 300},
    'frames': [{'x': 0.157142857, 'y': 0.18, 'width': 0.685714286, 'height': 0.64}],
}
OTHER_SIZE = {
    'name': 'tpl_other_size', 'productType': 'single_canvas', 'type': 'single',
    'canvas': {'width': 1800, 'height': 1200, 'widthMm': 152.4, 'heightMm': 101.6, 'dpi': 300},
    'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': 0.8}],
}
CALENDAR = {
    'name': 'tpl_cal', 'productType': 'calendar', 'type': 'single',
    'canvas': {'width': 1800, 'height': 1200, 'widthMm': 152.4, 'heightMm': 101.6, 'dpi': 300},
    'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.8, 'height': 0.8}],
}


class SharedTemplatesTest(_Base):
    """A template is offered on every same-box layout ops tick (`also_on`),
    the customer reads and counts see it there, and the decoration carries
    the home geometry the editor centres it by."""

    def setUp(self):
        super().setUp()
        self.half = LayoutCatalogue.objects.create(name='tpl_frame_half', definition=HALF_INCH_FRAME, product_type='single_canvas')
        self.other = LayoutCatalogue.objects.create(name='tpl_other_size', definition=OTHER_SIZE, product_type='single_canvas')
        self.cal = LayoutCatalogue.objects.create(name='tpl_cal', definition=CALENDAR, product_type='calendar')

    def ops_post(self, path, body):
        return self.client.post(path, body, content_type='application/json', **self.ops_auth)

    def test_shared_template_is_offered_on_ticked_layouts(self):
        res = self.ops_post('/api/ops/templates', {
            'id': 'shared', 'layout': 'tpl_test_4x6', 'display_name': 'Shared', 'status': 'published',
            'decoration': DECO, 'also_on': ['tpl_frame_half', 'tpl_test_4x6', 'tpl_frame_half'],
        })
        self.assertEqual(res.status_code, 201, res.content)
        data = res.json()
        self.assertEqual(data['layoutName'], 'tpl_test_4x6')
        self.assertEqual(data['alsoOn'], ['tpl_frame_half'])
        self.assertEqual(data['windowBox'], {'xMm': 15.24, 'yMm': 10.16, 'widthMm': 121.92, 'heightMm': 81.28})
        stamp = data['decoration']['authoredOn']
        self.assertEqual(stamp['layout'], 'tpl_test_4x6')
        self.assertEqual(stamp['surfaces']['default']['canvas'], {'width': 1800, 'height': 1200, 'widthMm': 152.4, 'heightMm': 101.6})
        self.assertEqual(stamp['surfaces']['default']['windowBox'], data['windowBox'])

        # The customer picker lists it on both layouts, nowhere else.
        for name, expected in (('tpl_test_4x6', ['shared']), ('tpl_frame_half', ['shared']), ('tpl_other_size', [])):
            listed = self.client.get(f'/api/templates?layout={name}', **self.partner_auth).json()['templates']
            self.assertEqual([t['id'] for t in listed], expected, name)
            if expected:
                self.assertEqual(listed[0]['layoutName'], 'tpl_test_4x6')
                self.assertEqual(listed[0]['alsoOn'], ['tpl_frame_half'])
        # The editor's init accepts it on a ticked layout and refuses it elsewhere.
        on_half = self.client.get('/api/editor/init?layout=tpl_frame_half&template=shared', **self.partner_auth)
        self.assertEqual(on_half.status_code, 200, on_half.content)
        self.assertEqual(on_half.json()['template']['id'], 'shared')
        self.assertEqual(on_half.json()['layout']['name'], 'tpl_frame_half')
        self.assertEqual(self.client.get('/api/editor/init?layout=tpl_other_size&template=shared', **self.partner_auth).status_code, 404)
        # Counts: once per layout it is offered on.
        from django.core.cache import cache
        cache.delete_many(['layouts_list_all', 'ops_layouts_list_all'])
        counts = {l['name']: l['templateCount'] for l in self.client.get('/api/layouts', **self.partner_auth).json()['layouts']}
        self.assertEqual((counts['tpl_test_4x6'], counts['tpl_frame_half'], counts['tpl_other_size']), (1, 1, 0))
        # The ops list filters by either layout and never repeats a template.
        self.assertEqual([t['id'] for t in self.client.get('/api/ops/templates?layout=tpl_frame_half', **self.ops_auth).json()['templates']], ['shared'])
        self.assertEqual([t['id'] for t in self.client.get('/api/ops/templates', **self.ops_auth).json()['templates']], ['shared'])
        # The session's ready-made address still opens the home layout.
        session = self.client.post('/api/embed/session', {'template_id': 'shared'}, content_type='application/json', **self.partner_auth).json()
        self.assertTrue(session['editor_url'].startswith('/editor/layout/tpl_test_4x6?'))

        # Unticking takes it off the other layout; a save without `also_on` keeps the list.
        kept = self.ops_post('/api/ops/templates/shared', {'display_name': 'Shared!'})
        self.assertEqual(kept.json()['alsoOn'], ['tpl_frame_half'])
        res = self.ops_post('/api/ops/templates/shared', {'also_on': []})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()['alsoOn'], [])
        self.assertEqual(self.client.get('/api/templates?layout=tpl_frame_half', **self.partner_auth).json()['templates'], [])

    def test_also_on_is_refused_for_other_sizes_calendars_and_unknown_layouts(self):
        base = {'id': 'picky', 'layout': 'tpl_test_4x6', 'display_name': 'Picky', 'decoration': DECO}
        for also_on, fragment in (
            (['tpl_other_size'], "tpl_other_size' has 76x81 mm print areas (bleed included); 'tpl_test_4x6' has 122x81 mm"),
            (['tpl_cal'], 'calendars and books'),
            (['tpl_missing'], "Layout 'tpl_missing' not found"),
            (['../escape'], 'invalid layout name'),
            ('tpl_frame_half', None),           # a bare string is read as a one-item list
            ({'tpl_frame_half': True}, 'must be a list'),
        ):
            res = self.ops_post('/api/ops/templates', {**base, 'also_on': also_on})
            if fragment is None:
                self.assertEqual(res.status_code, 201, res.content)
                self.assertEqual(res.json()['alsoOn'], ['tpl_frame_half'])
                LayoutTemplate.objects.filter(template_id='picky').delete()
            else:
                self.assertEqual(res.status_code, 400, (also_on, res.content))
                self.assertIn(fragment, res.json()['detail'])
        self.assertFalse(LayoutTemplate.objects.filter(template_id='picky').exists())
        # A home layout without windows cannot share at all.
        bare = LayoutCatalogue.objects.create(name='tpl_bare', definition={**LAYOUT, 'name': 'tpl_bare', 'frames': []})
        res = self.ops_post('/api/ops/templates', {**base, 'id': 'bare', 'layout': bare.name, 'also_on': ['tpl_frame_half']})
        self.assertEqual(res.status_code, 400)
        self.assertIn('no print areas', res.json()['detail'])

    def test_a_ticked_layout_that_is_retired_or_resized_is_flagged_and_must_be_unticked(self):
        self.ops_post('/api/ops/templates', {
            'id': 'shared', 'layout': 'tpl_test_4x6', 'display_name': 'Shared', 'status': 'published',
            'decoration': DECO, 'also_on': ['tpl_frame_half'],
        })
        read = lambda: self.client.get('/api/ops/templates/shared', **self.ops_auth).json()
        self.assertEqual(read()['alsoOnMismatch'], [])
        # The customer picker never carries the flag.
        self.assertNotIn('alsoOnMismatch', self.client.get('/api/templates/shared', **self.partner_auth).json())

        # Ops move the other layout's print areas: it stays ticked, is flagged, and a
        # save that re-sends it is refused by name until it is unticked.
        self.half.definition = {**HALF_INCH_FRAME, 'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': 0.5}]}
        self.half.version += 1
        self.half.save()
        self.assertEqual(read()['alsoOn'], ['tpl_frame_half'])
        self.assertEqual(read()['alsoOnMismatch'], ['tpl_frame_half'])
        self.assertEqual([t['id'] for t in self.client.get('/api/templates?layout=tpl_frame_half', **self.partner_auth).json()['templates']], ['shared'])
        refused = self.ops_post('/api/ops/templates/shared', {'display_name': 'Shared!', 'also_on': ['tpl_frame_half']})
        self.assertEqual(refused.status_code, 400)
        self.assertIn("tpl_frame_half' has 89x64 mm print areas", refused.json()['detail'])
        # A save that leaves `also_on` out keeps the list and still succeeds.
        self.assertEqual(self.ops_post('/api/ops/templates/shared', {'display_name': 'Shared!'}).status_code, 200)

        # A retired layout reads the same way.
        self.half.definition = HALF_INCH_FRAME
        self.half.is_deprecated = True
        self.half.save()
        self.assertEqual(read()['alsoOnMismatch'], ['tpl_frame_half'])
        refused = self.ops_post('/api/ops/templates/shared', {'also_on': ['tpl_frame_half']})
        self.assertEqual(refused.status_code, 400)
        self.assertIn('retired', refused.json()['detail'])
        ok = self.ops_post('/api/ops/templates/shared', {'also_on': []})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()['alsoOn'], [])
        self.assertEqual(ok.json()['alsoOnMismatch'], [])

    def test_every_read_carries_the_home_geometry_as_it_is_now(self):
        """Nothing is stored: a template saved before sharing reads with the
        home geometry too, a client's own stamp is dropped, and moving the
        home layout's print areas moves the geometry on the next read."""
        t = self.make('old-one')
        self.assertNotIn('authoredOn', t.decoration)
        for path, auth in (('/api/templates/old-one', self.partner_auth), ('/api/ops/templates/old-one', self.ops_auth)):
            stamp = self.client.get(path, **auth).json()['decoration']['authoredOn']
            self.assertEqual(stamp['layout'], 'tpl_test_4x6')
            self.assertEqual(stamp['surfaces']['default']['windowBox'], {'xMm': 15.24, 'yMm': 10.16, 'widthMm': 121.92, 'heightMm': 81.28})
        forged = {**DECO, 'authoredOn': {'layout': 'elsewhere', 'surfaces': {}}}
        res = self.ops_post('/api/ops/templates/old-one', {'decoration': forged})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertNotIn('authoredOn', LayoutTemplate.objects.get(template_id='old-one').decoration)
        self.assertEqual(res.json()['decoration']['authoredOn']['layout'], 'tpl_test_4x6')
        self.layout.definition = {**LAYOUT, 'frames': [{'x': 0.2, 'y': 0.1, 'width': 0.8, 'height': 0.8}]}
        self.layout.version += 1
        self.layout.save()
        moved = self.client.get('/api/templates/old-one', **self.partner_auth).json()['decoration']['authoredOn']
        self.assertEqual(moved['surfaces']['default']['windowBox']['xMm'], 30.48)

    def test_a_two_sided_home_cannot_share_with_a_one_sided_layout(self):
        """The decoration is drawn per side, so the sides must match too."""
        two_sided = {
            'name': 'tpl_card', 'productType': 'single_canvas', 'type': 'product',
            'surfaces': [
                {'key': 'front', 'label': 'Front', 'canvas': LAYOUT['canvas'], 'frames': LAYOUT['frames']},
                {'key': 'back', 'label': 'Back', 'canvas': LAYOUT['canvas'], 'frames': []},
            ],
        }
        LayoutCatalogue.objects.create(name='tpl_card', definition=two_sided, product_type='single_canvas')
        by_name = {l['name']: l for l in self.client.get('/api/ops/templates/candidates', **self.ops_auth).json()['layouts']}
        self.assertEqual(by_name['tpl_card']['windowKey'], '122x81')
        self.assertEqual(by_name['tpl_card']['surfaceKeys'], ['front', 'back'])
        self.assertEqual(by_name['tpl_test_4x6']['surfaceKeys'], ['default'])
        res = self.ops_post('/api/ops/templates', {
            'id': 'sides', 'layout': 'tpl_test_4x6', 'display_name': 'Sides', 'decoration': DECO, 'also_on': ['tpl_card'],
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn("tpl_card' has sides front, back; 'tpl_test_4x6' has default", res.json()['detail'])

    def test_a_retired_home_hides_the_template_everywhere(self):
        self.ops_post('/api/ops/templates', {
            'id': 'shared', 'layout': 'tpl_test_4x6', 'display_name': 'Shared', 'status': 'published',
            'decoration': DECO, 'also_on': ['tpl_frame_half'],
        })
        self.layout.is_deprecated = True
        self.layout.save()
        self.assertEqual(self.client.get('/api/templates?layout=tpl_frame_half', **self.partner_auth).json()['templates'], [])
        self.assertEqual(self.client.get('/api/editor/init?layout=tpl_frame_half&template=shared', **self.partner_auth).status_code, 404)
        self.assertEqual(self.client.get('/api/templates/shared', **self.partner_auth).status_code, 404)
        from django.core.cache import cache
        cache.delete_many(['layouts_list_all', 'ops_layouts_list_all'])
        counts = {l['name']: l['templateCount'] for l in self.client.get('/api/layouts', **self.partner_auth).json()['layouts']}
        self.assertEqual(counts['tpl_frame_half'], 0)
        ops = self.client.get('/api/ops/templates/shared', **self.ops_auth).json()
        self.assertTrue(ops['homeRetired'])

    def test_a_draft_shared_template_counts_nothing_for_customers(self):
        self.ops_post('/api/ops/templates', {
            'id': 'draft-shared', 'layout': 'tpl_test_4x6', 'display_name': 'Draft', 'decoration': DECO, 'also_on': ['tpl_frame_half'],
        })
        from django.core.cache import cache
        cache.delete_many(['layouts_list_all', 'ops_layouts_list_all'])
        counts = {l['name']: l['templateCount'] for l in self.client.get('/api/layouts', **self.partner_auth).json()['layouts']}
        self.assertEqual((counts['tpl_test_4x6'], counts['tpl_frame_half']), (0, 0))
        self.assertEqual(self.client.get('/api/templates?layout=tpl_frame_half', **self.partner_auth).json()['templates'], [])
        by_name = {l['name']: l for l in self.client.get('/api/ops/templates/candidates', **self.ops_auth).json()['layouts']}
        self.assertEqual((by_name['tpl_test_4x6']['templateCount'], by_name['tpl_frame_half']['templateCount']), (1, 1))

    def test_candidates_list_generic_layouts_with_their_size(self):
        self.make('home-draft', status='draft')
        res = self.client.get('/api/ops/templates/candidates', **self.ops_auth)
        self.assertEqual(res.status_code, 200, res.content)
        by_name = {l['name']: l for l in res.json()['layouts']}
        self.assertNotIn('tpl_cal', by_name)
        self.assertEqual(by_name['tpl_test_4x6']['windowKey'], '122x81')
        self.assertEqual(by_name['tpl_frame_half']['windowKey'], '122x81')
        self.assertEqual(by_name['tpl_other_size']['windowKey'], '76x81')
        self.assertEqual(by_name['tpl_frame_half']['windowBox'], {'xMm': 27.94, 'yMm': 22.86, 'widthMm': 121.92, 'heightMm': 81.28})
        self.assertEqual(by_name['tpl_test_4x6']['printAreaKey'], '122x81')
        self.assertEqual(by_name['tpl_test_4x6']['bleedMm'], 0)
        self.assertEqual(by_name['tpl_test_4x6']['surfaceKeys'], ['default'])
        self.assertEqual(by_name['tpl_test_4x6']['templateCount'], 1)   # drafts count for ops
        self.assertEqual(by_name['tpl_frame_half']['templateCount'], 0)
        self.assertEqual(by_name['tpl_test_4x6']['displayName'], self.layout.display_name or 'tpl_test_4x6')
        self.assertEqual(self.client.get('/api/ops/templates/candidates', **self.partner_auth).status_code, 403)
