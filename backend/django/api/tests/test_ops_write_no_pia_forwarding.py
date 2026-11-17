"""
The ops-write views (fonts, calendar styles, holidays) identify the caller
without sending the bearer token anywhere. An API key, the internal key
included, is resolved against the database and never posted to PIA.

Needs Postgres, like the rest of api/tests/.
"""
from unittest import mock

from django.test import Client, TestCase

from api.models import APIKey


class NoForwardingTest(TestCase):

    def setUp(self):
        self.client = Client()

    def _put(self, key):
        with mock.patch('api.authentication.requests.post') as post, \
                mock.patch('api.views.calendar_assets._write_fonts', return_value=['Inter']):
            res = self.client.put(
                '/api/fonts', {'fonts': ['Inter']}, content_type='application/json',
                HTTP_AUTHORIZATION=f'Bearer {key}',
            )
        return res, post

    def test_an_ops_key_is_never_sent_to_pia(self):
        APIKey.objects.create(name='ops-no-forward', key='test-ops-key', is_ops_team=True)
        res, post = self._put('test-ops-key')
        self.assertFalse(post.called, 'the bearer token reached the PIA verifier')
        self.assertNotEqual(res.status_code, 401)
        self.assertNotEqual(res.status_code, 403)

    def test_a_plain_key_is_refused_without_leaving_the_server(self):
        APIKey.objects.create(name='plain-no-forward', key='test-plain-key')
        res, post = self._put('test-plain-key')
        self.assertFalse(post.called)
        self.assertEqual(res.status_code, 403)

    def test_no_credentials_is_401(self):
        res = self.client.put('/api/fonts', {'fonts': []}, content_type='application/json')
        self.assertEqual(res.status_code, 401)
