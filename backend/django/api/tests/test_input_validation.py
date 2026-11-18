"""
Untrusted input that used to reach a 500, a log line or a caller as it came.

- /api/csp-report accepts anyone's POST: a non-object report answered 500 and a
  newline in a value forged a log line.
- Holidays PUT with a non-object `_meta` answered 500.
- A render accepted an order id of any shape (the embed session and the
  upload endpoints already require ^[A-Za-z0-9_.\\-]{1,64}$).
- The failure webhook carried an exception's own text to the caller.

Needs Postgres, like the rest of api/tests/.
"""
import json
import logging
from unittest import mock

from django.test import Client, TestCase

from api.models import APIKey
from api.tasks import _public_failure_message


class CspReportTest(TestCase):

    def _post(self, body):
        return Client().post('/api/csp-report', data=body, content_type='application/csp-report')

    def test_a_report_that_is_not_an_object_is_204_not_500(self):
        for body in ('{"csp-report": ["x"]}', '{"csp-report": "x"}', '[1,2]', 'not json', '{"csp-report": 5}'):
            self.assertEqual(self._post(body).status_code, 204, body)

    def test_a_newline_in_a_value_cannot_forge_a_log_line(self):
        body = json.dumps({'csp-report': {
            'violated-directive': 'script-src\nERROR forged entry', 'blocked-uri': 'x' * 5000,
        }})
        with self.assertLogs('api.views.system', level=logging.WARNING) as logs:
            self._post(body)
        line = logs.records[0].getMessage()
        self.assertNotIn('\n', line)
        self.assertLess(len(line), 1000)


class HolidaysMetaTest(TestCase):

    def test_a_non_object_meta_is_400(self):
        APIKey.objects.create(name='validation-ops', key='validation-ops-key', is_ops_team=True)
        with mock.patch('api.views.calendar_assets._write_holidays') as write:
            res = Client().put(
                '/api/ops/holidays/en-IN/2026', {'events': [], '_meta': 'oops'},
                content_type='application/json', HTTP_AUTHORIZATION='Bearer validation-ops-key',
            )
        self.assertEqual(res.status_code, 400)
        self.assertFalse(write.called)


class RenderOrderIdTest(TestCase):

    def setUp(self):
        APIKey.objects.create(name='validation-render', key='validation-render-key')
        self.auth = {'HTTP_AUTHORIZATION': 'Bearer validation-render-key'}

    def test_a_render_with_a_malformed_order_id_is_refused(self):
        for bad in ('has space', 'semi;colon', 'a/b', '../x', 'x' * 65, '<script>'):
            res = Client().post(
                '/api/editor/render',
                {'layout_name': 'any', 'order_id': bad, 'canvases': [{'canvas_index': 0, 'frames': []}]},
                content_type='application/json', **self.auth,
            )
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn('order_id', res.json()['detail'], bad)

    def test_the_embed_header_is_judged_too(self):
        res = Client().post(
            '/api/editor/render',
            {'layout_name': 'any', 'canvases': [{'canvas_index': 0, 'frames': []}]},
            content_type='application/json', HTTP_X_ORDER_ID='bad id!', **self.auth,
        )
        self.assertEqual(res.status_code, 400)

    def test_a_well_formed_order_id_passes_this_check(self):
        res = Client().post(
            '/api/editor/render',
            {'layout_name': 'no_such_layout', 'order_id': 'PE-abc_1.2', 'canvases': [{'canvas_index': 0, 'frames': []}]},
            content_type='application/json', **self.auth,
        )
        detail = res.json().get('detail', '') if res.status_code == 400 else ''
        self.assertNotIn('order_id may only', detail)


class FailureWebhookTextTest(TestCase):

    def test_our_own_failure_texts_pass_through(self):
        for text in ('Render exceeded 512 MB memory limit. Layout x', 'Render timed out after 570s',
                     'Server storage is full — render aborted before writing any files.'):
            self.assertEqual(_public_failure_message(text), text)

    def test_an_exceptions_own_text_does_not_reach_the_caller(self):
        for text in ("[Errno 2] No such file or directory: '/app/uploads/PE-1/a.jpg'",
                     "connection to server at \"db\" (172.18.0.2), port 5432 failed", '', None):
            self.assertEqual(_public_failure_message(text), 'Render failed')
