"""
Print orientation, end to end through the API.

The caller's CMS sends `orientation` on the embed session. The editor-init
response turns the layout with it, the render submit snapshots what happened,
and a missing, unknown or unusable value is never an error: the layout is
served as authored and the report says why.

Needs Postgres and the real cache, like the rest of api/tests/.
"""
import os
from datetime import timedelta
from unittest import mock

from django.test import Client, TestCase
from django.utils import timezone

from api.models import APIKey, EmbedSession, LayoutCatalogue, UploadedFile
from api.views import invalidate_layout_caches

NAME = 'orientation_two_up'
BLOCKED = 'orientation_captions'


def _definition(name, **extra):
    return {
        'name': name,
        'productType': 'single_canvas',
        'canvas': {'width': 3000, 'height': 2000, 'widthMm': 300, 'heightMm': 200},
        'frames': [
            {'id': 'a', 'x': 0.05, 'y': 0.1, 'width': 0.4, 'height': 0.8},
            {'id': 'b', 'x': 0.55, 'y': 0.1, 'width': 0.4, 'height': 0.8},
        ],
        **extra,
    }


class OrientationApiTest(TestCase):

    def setUp(self):
        self.client = Client()
        self.key = APIKey.objects.create(name='orientation-test', key='test-orientation-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        for n in (NAME, BLOCKED):
            invalidate_layout_caches(n)
        LayoutCatalogue.objects.create(name=NAME, definition=_definition(NAME))
        LayoutCatalogue.objects.create(
            name=BLOCKED, definition=_definition(BLOCKED, frameCaptionsEnabled=True),
        )

    def tearDown(self):
        for n in (NAME, BLOCKED):
            invalidate_layout_caches(n)

    def _session(self, **body):
        res = self.client.post('/api/embed/session', body, content_type='application/json', **self.auth)
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()

    def _init(self, layout, orientation=None):
        extra = dict(self.auth)
        if orientation:
            extra['HTTP_X_ORDER_ORIENTATION'] = orientation
        res = self.client.get(f'/api/editor/init?layout={layout}', **extra)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    # ── session ──────────────────────────────────────────────────────────

    def test_session_stores_a_valid_orientation(self):
        body = self._session(order_id='O-1', orientation=' Portrait ')
        self.assertEqual(body['orientation'], 'portrait')
        self.assertEqual(EmbedSession.objects.get(token=body['token']).orientation, 'portrait')

    def test_session_drops_an_unknown_orientation_instead_of_failing(self):
        for raw in ('sideways', 7, ''):
            body = self._session(order_id='O-2', orientation=raw)
            self.assertIsNone(body['orientation'])
            self.assertEqual(EmbedSession.objects.get(token=body['token']).orientation, '')

    def test_session_without_orientation_is_unchanged(self):
        body = self._session(order_id='O-3')
        self.assertIsNone(body['orientation'])

    def test_validate_returns_the_orientation_to_the_proxy(self):
        body = self._session(order_id='O-4', orientation='landscape')
        headers = {}
        if os.getenv('EMBED_INTERNAL_SECRET'):
            headers['HTTP_X_INTERNAL_SECRET'] = os.environ['EMBED_INTERNAL_SECRET']
        res = self.client.get(f"/api/embed/session/validate?token={body['token']}", **headers)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()['orientation'], 'landscape')

    # ── editor init ──────────────────────────────────────────────────────

    def test_init_turns_a_layout_for_the_other_orientation(self):
        data = self._init(NAME, 'portrait')
        self.assertEqual(data['orientation'], {
            'requested': 'portrait', 'applied': True, 'reason': None, 'orientation': 'portrait',
            'blocked': None,
        })
        self.assertEqual((data['layout']['canvas']['width'], data['layout']['canvas']['height']), (2000, 3000))
        self.assertEqual([f['id'] for f in data['layout']['frames']], ['a', 'b'])

    def test_init_serves_the_layout_as_authored_when_nothing_was_asked(self):
        data = self._init(NAME)
        self.assertFalse(data['orientation']['applied'])
        self.assertEqual(data['orientation']['reason'], 'not_sent')
        self.assertEqual(data['layout']['canvas']['width'], 3000)

    def test_init_reports_a_blocked_layout_even_when_nothing_was_asked(self):
        data = self._init(BLOCKED)
        self.assertEqual(data['orientation']['blocked'], 'has_captions')
        self.assertEqual(data['orientation']['reason'], 'not_sent')

    def test_init_the_turned_layout_does_not_poison_the_cache(self):
        self._init(NAME, 'portrait')
        again = self._init(NAME)
        self.assertEqual(again['layout']['canvas']['width'], 3000)

    def test_init_matching_orientation_changes_nothing(self):
        data = self._init(NAME, 'landscape')
        self.assertEqual(data['orientation']['reason'], 'already_that_orientation')
        self.assertEqual(data['layout']['canvas']['width'], 3000)

    def test_init_a_layout_with_captions_is_left_alone_with_the_reason(self):
        data = self._init(BLOCKED, 'portrait')
        self.assertFalse(data['orientation']['applied'])
        self.assertEqual(data['orientation']['reason'], 'has_captions')
        self.assertEqual(data['layout']['canvas']['width'], 3000)

    def test_init_ops_can_switch_a_layout_off(self):
        row = LayoutCatalogue.objects.get(name=NAME)
        row.definition = _definition(NAME, orientationRotatable=False)
        row.save()
        invalidate_layout_caches(NAME)
        data = self._init(NAME, 'portrait')
        self.assertEqual(data['orientation']['reason'], 'not_rotatable')

    def test_init_an_unknown_header_value_is_not_an_error(self):
        data = self._init(NAME, 'diagonal')
        self.assertEqual(data['orientation']['reason'], 'invalid_value')

    # ── render submit snapshot ───────────────────────────────────────────

    def _submit(self, order_id):
        UploadedFile.objects.create(
            api_key=self.key, file_path=f'/tmp/{order_id}.png', original_filename='a.png',
            file_size_bytes=1, upload_session_id=f'up-{order_id}',
        )
        payload = {
            'layout_name': NAME, 'order_id': order_id,
            'canvases': [{'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': f'up-{order_id}'}]}],
        }
        captured = {}

        def fake_submit(self_, **kwargs):
            captured.update(kwargs)
            return {'job_id': 'j', 'order_id': order_id, 'status_url': '/x', 'queue': 'standard'}

        with mock.patch('api.render_submission.RenderSubmissionService.submit', fake_submit):
            res = self.client.post('/api/editor/render', payload, content_type='application/json', **self.auth)
        self.assertEqual(res.status_code, 202, res.content)
        return captured['render_state']['orientation']

    def test_submit_snapshots_what_the_session_asked_for(self):
        EmbedSession.objects.create(
            api_key=self.key, order_id='O-9', orientation='portrait',
            expires_at=timezone.now() + timedelta(hours=1),
        )
        report = self._submit('O-9')
        self.assertEqual(report, {'requested': 'portrait', 'applied': True, 'reason': None, 'orientation': 'portrait', 'blocked': None})

    def test_submit_without_a_session_orientation_prints_as_authored(self):
        EmbedSession.objects.create(
            api_key=self.key, order_id='O-10', expires_at=timezone.now() + timedelta(hours=1),
        )
        report = self._submit('O-10')
        self.assertFalse(report['applied'])
        self.assertEqual(report['reason'], 'not_sent')


class DashboardOrientationTest(OrientationApiTest):
    """The dashboard has no session, so its toggle sends the choice itself;
    only the internal ops key is believed, never an embed caller's."""

    def setUp(self):
        super().setUp()
        ops = APIKey.objects.create(name='orientation-ops', key='test-orientation-ops', is_ops_team=True)
        self.ops_auth = {'HTTP_AUTHORIZATION': f'Bearer {ops.key}'}

    def test_init_honours_the_query_param_for_the_ops_key(self):
        res = self.client.get(f'/api/editor/init?layout={NAME}&orientation=portrait', **self.ops_auth)
        data = res.json()
        self.assertTrue(data['orientation']['applied'])
        self.assertEqual(data['layout']['canvas']['width'], 2000)

    def test_init_ignores_the_query_param_for_an_embed_key(self):
        res = self.client.get(f'/api/editor/init?layout={NAME}&orientation=portrait', **self.auth)
        data = res.json()
        self.assertFalse(data['orientation']['applied'])
        self.assertEqual(data['orientation']['reason'], 'not_sent')
        self.assertEqual(data['layout']['canvas']['width'], 3000)

    def test_the_session_header_still_wins_over_the_query_param(self):
        res = self.client.get(
            f'/api/editor/init?layout={NAME}&orientation=portrait',
            HTTP_X_ORDER_ORIENTATION='landscape', **self.ops_auth,
        )
        self.assertEqual(res.json()['orientation']['reason'], 'already_that_orientation')

    def _submit_as(self, auth, order_id, body_orientation):
        UploadedFile.objects.create(
            api_key=APIKey.objects.get(key=auth['HTTP_AUTHORIZATION'].split()[1]),
            file_path=f'/tmp/{order_id}.png', original_filename='a.png',
            file_size_bytes=1, upload_session_id=f'up-{order_id}',
        )
        payload = {
            'layout_name': NAME, 'order_id': order_id, 'orientation': body_orientation,
            'canvases': [{'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': f'up-{order_id}'}]}],
        }
        captured = {}

        def fake_submit(self_, **kwargs):
            captured.update(kwargs)
            return {'job_id': 'j', 'order_id': order_id, 'status_url': '/x', 'queue': 'standard'}

        with mock.patch('api.render_submission.RenderSubmissionService.submit', fake_submit):
            res = self.client.post('/api/editor/render', payload, content_type='application/json', **auth)
        self.assertEqual(res.status_code, 202, res.content)
        return captured['render_state']['orientation']

    def test_render_takes_the_dashboard_choice_from_the_body(self):
        report = self._submit_as(self.ops_auth, 'D-1', 'portrait')
        self.assertTrue(report['applied'])

    def test_render_ignores_a_body_orientation_from_an_embed_key(self):
        report = self._submit_as(self.auth, 'D-2', 'portrait')
        self.assertFalse(report['applied'])
        self.assertEqual(report['reason'], 'not_sent')
