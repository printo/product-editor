"""
Two small guards that had a gap:

- The chunked upload's complete step trusted the list in _meta.json, which four
  parallel chunk requests can overwrite one another's entries in. A chunk whose
  part file exists is received, whatever the list says.
- The admin proxy check read DEBUG from the environment with a default of "1",
  where settings defaults to off.
"""
import json
import os
import shutil
import tempfile
import uuid

from django.test import Client, TestCase, override_settings

from api.models import APIKey


class CompleteTrustsTheDiskTest(TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='chunk-test-')
        self.addCleanup(shutil.rmtree, self.root, True)
        override = override_settings(UPLOADS_DIR=self.root)
        override.enable()
        self.addCleanup(override.disable)
        APIKey.objects.create(name='chunk-test', key='chunk-test-key')
        self.auth = {'HTTP_AUTHORIZATION': 'Bearer chunk-test-key'}

    def _session(self, total, listed):
        upload_id = str(uuid.uuid4())
        d = os.path.join(self.root, '.chunks', upload_id)
        os.makedirs(d)
        with open(os.path.join(d, '_meta.json'), 'w') as f:
            json.dump({'filename': 'a.jpg', 'file_size': 10, 'total_chunks': total, 'received_chunks': listed}, f)
        return upload_id, d

    def test_a_chunk_missing_from_the_list_but_on_disk_is_not_reported_missing(self):
        upload_id, d = self._session(total=2, listed=[0])     # the list lost chunk 1
        for i in (0, 1):
            with open(os.path.join(d, f'{i}.part'), 'wb') as f:
                f.write(b'xxxxx')
        res = Client().post(f'/api/upload/{upload_id}/complete', **self.auth)
        self.assertNotIn('Missing chunks', res.content.decode())   # it went on to validate the bytes

    def test_a_chunk_listed_but_not_on_disk_is_still_missing(self):
        upload_id, d = self._session(total=2, listed=[0, 1])
        with open(os.path.join(d, '0.part'), 'wb') as f:
            f.write(b'xxxxx')
        res = Client().post(f'/api/upload/{upload_id}/complete', **self.auth)
        self.assertEqual(res.status_code, 400)
        self.assertIn('Missing chunks: [1]', res.json()['detail'])


class AdminProxyGuardTest(TestCase):

    @override_settings(DEBUG=False)
    def test_the_admin_refuses_a_request_that_skipped_the_proxy(self):
        res = Client().get('/django-admin/')
        self.assertEqual(res.status_code, 403)

    @override_settings(DEBUG=False)
    def test_the_admin_accepts_the_proxys_headers(self):
        res = Client().get('/django-admin/', HTTP_X_FORWARDED_PROTO='https', HTTP_X_FORWARDED_HOST='x')
        self.assertNotEqual(res.status_code, 403)
