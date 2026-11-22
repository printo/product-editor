"""A layout with no Print Areas is refused at the save and at the submit.

`stamp_size_print` was saved with none in July 2026 and took orders that could
only fail in the worker (nine orders, 2026-11-19 to 22).

Run with: docker compose exec backend python manage.py test api.tests.test_layout_without_print_areas
"""
import json
from unittest import mock

from django.test import TestCase

from api.models import APIKey, CanvasData, LayoutCatalogue, RenderJob
from api.views import invalidate_layout_caches
from services.layout_frames import SUBMIT_REFUSED

CANVAS = {'width': 236, 'height': 295, 'widthMm': 20, 'heightMm': 25, 'dpi': 300}
FRAME = {'id': 'a', 'x': 0, 'y': 0, 'width': 1, 'height': 1}
EMPTY = 'zz_no_print_areas'
GOOD = 'zz_one_print_area'


class SaveTest(TestCase):
    def setUp(self):
        self.ops = APIKey.objects.create(name='frames-ops', key='frames-ops-key', is_ops_team=True)
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.ops.key}'}

    def write(self, name, definition):
        return self.client.post(f'/api/ops/layouts/{name}', data={'layout_data': json.dumps(definition)}, **self.auth)

    def test_a_plain_layout_with_no_print_areas_is_refused(self):
        res = self.write(EMPTY, {'name': EMPTY, 'canvas': CANVAS, 'frames': []})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('Print Area', res.json()['detail'])
        self.assertFalse(LayoutCatalogue.objects.filter(name=EMPTY).exists())

    def test_a_product_with_an_empty_side_is_refused_by_name(self):
        res = self.write(EMPTY, {'name': EMPTY, 'type': 'product', 'surfaces': [
            {'key': 'front', 'canvas': CANVAS, 'frames': [FRAME]},
            {'key': 'back', 'canvas': CANVAS, 'frames': []},
        ]})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("'back'", res.json()['detail'])

    def test_a_layout_with_a_print_area_saves(self):
        res = self.write(GOOD, {'name': GOOD, 'canvas': CANVAS, 'frames': [FRAME]})
        self.assertEqual(res.status_code, 200, res.content)

    def test_an_existing_empty_layout_cannot_be_saved_again_until_it_has_one(self):
        LayoutCatalogue.objects.create(name=EMPTY, definition={'name': EMPTY, 'canvas': CANVAS, 'frames': []})
        self.assertEqual(self.write(EMPTY, {'name': EMPTY, 'canvas': CANVAS, 'frames': []}).status_code, 400)
        self.assertEqual(self.write(EMPTY, {'name': EMPTY, 'canvas': CANVAS, 'frames': [FRAME]}).status_code, 200)


class SubmitTest(TestCase):
    def setUp(self):
        self.key = APIKey.objects.create(name='frames-partner', key='frames-partner-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        invalidate_layout_caches(EMPTY)
        LayoutCatalogue.objects.create(name=EMPTY, definition={'name': EMPTY, 'canvas': CANVAS, 'frames': []})

    def tearDown(self):
        invalidate_layout_caches(EMPTY)

    def test_the_editor_submit_is_refused_before_anything_is_queued(self):
        body = {'layout_name': EMPTY, 'order_id': 'ZZ-frames-1', 'canvases': [
            {'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': '00000000-0000-4000-8000-000000000001'}]},
        ]}
        with mock.patch('api.views.render.logger') as log:
            res = self.client.post('/api/editor/render', data=json.dumps(body), content_type='application/json', **self.auth)
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(res.json()['detail'], SUBMIT_REFUSED)
        log.error.assert_called_once()
        self.assertFalse(RenderJob.objects.exists())
        self.assertFalse(CanvasData.objects.filter(order_id='ZZ-frames-1').exists())
