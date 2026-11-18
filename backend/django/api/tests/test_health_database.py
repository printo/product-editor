"""
GET /api/health reports the database it actually reached.

It used to return "connected" unconditionally, so the deploy gate and the
container healthcheck passed with Postgres down.
"""
from unittest import mock

from django.db import OperationalError
from django.test import Client, TestCase


class HealthDatabaseTest(TestCase):

    def test_reachable_database_is_ok(self):
        res = Client().get('/api/health')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['database'], 'connected')

    def test_unreachable_database_is_503(self):
        with mock.patch('api.views.system.connection') as conn:
            conn.cursor.side_effect = OperationalError('connection refused')
            res = Client().get('/api/health')
        self.assertEqual(res.status_code, 503)
        body = res.json()
        self.assertEqual((body['status'], body['database']), ('unavailable', 'unavailable'))
        self.assertNotIn('refused', str(body), 'the driver message must not reach the caller')
