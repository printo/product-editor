"""
An embed session reads only its own order's saved design.

Every customer of one company presents that company's API key, and the order
id in the editor's address is theirs to edit. The embed proxy stamps the
session's order id on each request as `X-Order-ID`; `GET /api/canvas-state/<id>/`
serves that order and no other. Requests without the header (the dashboard, a
partner backend holding the key) are unchanged.

Needs Postgres, like the rest of api/tests/.
"""
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from api.models import APIKey, CanvasData

OWN = 'JOB-1001'
OTHER = 'JOB-1002'


class CanvasStateOwnOrderTest(TestCase):

    def setUp(self):
        self.client = Client()
        self.key = APIKey.objects.create(name='canvas-state-test', key='test-canvas-state-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        for order_id in (OWN, OTHER):
            CanvasData.objects.create(
                order_id=order_id, api_key=self.key, layout_name='classic_4x6',
                editor_state={'surfaces': [{'key': 'default', 'note': f'design of {order_id}'}]},
                expires_at=timezone.now() + timedelta(days=3),
            )

    def _get(self, path_id, session_order_id=None):
        headers = dict(self.auth)
        if session_order_id is not None:
            headers['HTTP_X_ORDER_ID'] = session_order_id
        return self.client.get(f'/api/canvas-state/{path_id}/', **headers)

    def test_session_reads_its_own_order(self):
        res = self._get(OWN, session_order_id=OWN)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['order_id'], OWN)
        self.assertIn(OWN, res.json()['editor_state']['surfaces'][0]['note'])

    def test_session_cannot_read_another_order_of_the_same_key(self):
        res = self._get(OTHER, session_order_id=OWN)
        self.assertEqual(res.status_code, 404)
        self.assertNotIn('editor_state', res.json())

    def test_refusal_reads_like_an_order_with_nothing_saved(self):
        refused = self._get(OTHER, session_order_id=OWN)
        empty = self._get('JOB-NEVER-SAVED', session_order_id='JOB-NEVER-SAVED')
        self.assertEqual(refused.status_code, empty.status_code)
        self.assertEqual(refused.json(), empty.json())

    def test_blank_header_counts_as_no_session(self):
        self.assertEqual(self._get(OTHER, session_order_id='  ').status_code, 200)

    def test_without_the_header_any_order_of_the_key_is_readable(self):
        """The dashboard proxy and a partner backend send no X-Order-ID."""
        for order_id in (OWN, OTHER):
            res = self._get(order_id)
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json()['order_id'], order_id)

    def test_another_key_still_cannot_read_the_order(self):
        other_key = APIKey.objects.create(name='canvas-state-other', key='test-canvas-state-other-key')
        res = self.client.get(
            f'/api/canvas-state/{OWN}/',
            HTTP_AUTHORIZATION=f'Bearer {other_key.key}', HTTP_X_ORDER_ID=OWN,
        )
        self.assertEqual(res.status_code, 404)

    def test_autosave_still_keys_on_the_session_order(self):
        """PUT already preferred the header; a wrong path id must not write elsewhere."""
        res = self.client.put(
            f'/api/canvas-state/{OTHER}/',
            data={'layout_name': 'classic_4x6', 'editor_state': {'surfaces': [{'key': 'default', 'note': 'new'}]}},
            content_type='application/json', HTTP_X_ORDER_ID=OWN, **self.auth,
        )
        self.assertIn(res.status_code, (200, 201))
        self.assertEqual(CanvasData.objects.get(order_id=OWN, api_key=self.key).editor_state['surfaces'][0]['note'], 'new')
        self.assertIn(OTHER, CanvasData.objects.get(order_id=OTHER, api_key=self.key).editor_state['surfaces'][0]['note'])
