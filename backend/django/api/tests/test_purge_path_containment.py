"""
An erasure deletes only files inside the uploads and exports folders.

`PUT /api/canvas-state/<id>/` used to store whatever `image_paths` the browser
sent, and `purge_order_data` removes every path an order names. A customer could
plant `/app/storage/purge_ledger.jsonl` and then ask for their own order to be
erased. Two guards, both pinned here: the PUT keeps only paths under the uploads
folder that this key's own uploads own, and the purge refuses any path outside
the two data folders whatever a row says.

Needs Postgres, like the rest of api/tests/. Run:
    docker-compose exec backend python manage.py test api.tests.test_purge_path_containment
"""
import os
import shutil
import tempfile
from datetime import timedelta

from django.test import Client, TestCase, override_settings
from django.utils import timezone

from api.models import APIKey, CanvasData, UploadedFile
from api.purge import _delete_files, _is_contained, purge_order_data

ORDER = 'JOB-2001'


class PurgePathContainmentTest(TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.uploads = os.path.join(self.root, 'uploads')
        self.exports = os.path.join(self.root, 'exports')
        os.makedirs(self.uploads)
        os.makedirs(self.exports)
        self.folders = override_settings(
            UPLOADS_DIR=self.uploads, EXPORTS_DIR=self.exports, STORAGE_ROOT=self.root,
        )
        self.folders.enable()
        self.key = APIKey.objects.create(name='containment-test', key='test-containment-key')
        self.other = APIKey.objects.create(name='containment-other', key='test-containment-other')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}', 'HTTP_X_ORDER_ID': ORDER}
        self.client = Client()
        # A file that must survive: it lives beside the data folders.
        self.precious = os.path.join(self.root, 'purge_ledger.jsonl')
        with open(self.precious, 'w') as f:
            f.write('ledger')

    def tearDown(self):
        self.folders.disable()
        shutil.rmtree(self.root, ignore_errors=True)

    def _upload(self, api_key, order_id, name):
        folder = os.path.join(self.uploads, order_id)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        with open(path, 'wb') as f:
            f.write(b'photo')
        UploadedFile.objects.create(
            api_key=api_key, file_path=path, original_filename=name, file_size_bytes=5, order_id=order_id,
        )
        return path

    def _put(self, image_paths):
        return self.client.put(
            f'/api/canvas-state/{ORDER}/',
            data={'layout_name': 'classic_4x6', 'editor_state': {}, 'image_paths': image_paths},
            content_type='application/json', **self.auth,
        )

    def test_put_drops_a_path_outside_the_uploads_folder(self):
        res = self._put([self.precious])
        self.assertIn(res.status_code, (200, 201), res.content)
        canvas = CanvasData.objects.get(order_id=ORDER, api_key=self.key)
        self.assertEqual(canvas.image_paths, [])

    def test_put_drops_a_path_that_climbs_out_with_dotdot(self):
        sneaky = os.path.join(self.uploads, '..', 'purge_ledger.jsonl')
        self._put([sneaky])
        canvas = CanvasData.objects.get(order_id=ORDER, api_key=self.key)
        self.assertEqual(canvas.image_paths, [])

    def test_put_drops_another_keys_upload(self):
        theirs = self._upload(self.other, 'JOB-9999', 'theirs.jpg')
        self._put([theirs])
        canvas = CanvasData.objects.get(order_id=ORDER, api_key=self.key)
        self.assertEqual(canvas.image_paths, [])

    def test_put_keeps_this_keys_own_upload(self):
        mine = self._upload(self.key, ORDER, 'mine.jpg')
        self._put([mine, self.precious])
        canvas = CanvasData.objects.get(order_id=ORDER, api_key=self.key)
        self.assertEqual(canvas.image_paths, [mine])

    def test_purge_never_removes_a_planted_path(self):
        # A row written before the PUT guard existed, or by any other route.
        CanvasData.objects.create(
            order_id=ORDER, api_key=self.key, layout_name='classic_4x6',
            image_paths=[self.precious], expires_at=timezone.now() + timedelta(days=3),
        )
        result = purge_order_data(ORDER)
        self.assertTrue(os.path.exists(self.precious), result)

    def test_delete_files_refuses_paths_outside_the_data_folders(self):
        deleted, _freed, errors = _delete_files([self.precious])
        self.assertEqual(deleted, 0)
        self.assertTrue(os.path.exists(self.precious))
        self.assertTrue(any('refused' in e for e in errors), errors)

    def test_is_contained(self):
        inside = os.path.join(self.uploads, ORDER, 'a.jpg')
        self.assertTrue(_is_contained(inside))
        self.assertTrue(_is_contained(os.path.join(self.exports, 'job', 'a.png')))
        self.assertFalse(_is_contained(self.uploads))
        self.assertFalse(_is_contained(self.precious))
        self.assertFalse(_is_contained(os.path.join(self.uploads, '..', 'purge_ledger.jsonl')))
        self.assertFalse(_is_contained(None))

    def test_a_symlink_out_of_the_folder_is_refused(self):
        link = os.path.join(self.uploads, 'link.jsonl')
        os.symlink(self.precious, link)
        self.assertFalse(_is_contained(link))
        _delete_files([link])
        self.assertTrue(os.path.exists(self.precious))
