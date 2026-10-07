"""
On-demand order erasure (api/purge.py), against a real database and real files.

Pins three fixes made together:

  1. An order holding only uploaded photos — no saved design, no embed session —
     answered "No data found" and left the photos on disk.
  2. A purge scoped to one API key swept the order's whole upload folder and
     deleted every upload row for that order id, another key's photos included
     (order ids are unique only per key).
  3. `matched` counted saved designs only, so the endpoint answered 404 for an
     order it had just erased (an embed session or uploads but no design).

Uploads and exports go to a temporary folder (UPLOADS_DIR / EXPORTS_DIR are
read at call time). Run:
    docker-compose exec backend python manage.py test api.tests.test_order_purge
"""
import os
import shutil
import tempfile
from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone

from api.models import APIKey, EmbedSession, UploadedFile
from api.purge import purge_order_data


class OrderPurgeTest(TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.uploads = os.path.join(self.root, 'uploads')
        os.makedirs(self.uploads)
        os.makedirs(os.path.join(self.root, 'exports'))
        self.folders = override_settings(UPLOADS_DIR=self.uploads, EXPORTS_DIR=os.path.join(self.root, 'exports'))
        self.folders.enable()
        self.storefront = APIKey.objects.create(name='purge-test-storefront', key='purge-test-key-a')
        self.other = APIKey.objects.create(name='purge-test-other', key='purge-test-key-b')

    def tearDown(self):
        self.folders.disable()
        shutil.rmtree(self.root, ignore_errors=True)

    def upload(self, api_key, order_id, name):
        """A stored photo: a file in the order's folder and its UploadedFile row."""
        folder = os.path.join(self.uploads, order_id)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        with open(path, 'wb') as f:
            f.write(b'photo')
        UploadedFile.objects.create(
            api_key=api_key, file_path=path, original_filename=name, file_size_bytes=5, order_id=order_id,
        )
        return path

    def test_an_order_with_only_uploaded_photos_is_erased(self):
        path = self.upload(self.storefront, 'ORD-1', 'a.jpg')
        result = purge_order_data('ORD-1')
        self.assertGreater(result['matched'], 0, result)
        self.assertTrue(result['erasure_complete'], result)
        self.assertFalse(os.path.exists(path))
        self.assertFalse(UploadedFile.objects.filter(order_id='ORD-1').exists())

    def test_files_left_in_the_order_folder_without_rows_are_erased(self):
        folder = os.path.join(self.uploads, 'ORD-2')
        os.makedirs(folder)
        open(os.path.join(folder, 'stray.jpg'), 'wb').close()
        result = purge_order_data('ORD-2')
        self.assertGreater(result['matched'], 0, result)
        self.assertFalse(os.path.exists(folder))

    def test_a_purge_scoped_to_one_key_leaves_another_keys_photos_alone(self):
        EmbedSession.objects.create(
            api_key=self.storefront, order_id='ORD-3', expires_at=timezone.now() + timedelta(hours=2),
        )
        mine = self.upload(self.storefront, 'ORD-3', 'mine.jpg')
        theirs = self.upload(self.other, 'ORD-3', 'theirs.jpg')
        result = purge_order_data('ORD-3', api_key=self.storefront)
        self.assertTrue(result['erasure_complete'], result)
        self.assertFalse(os.path.exists(mine))
        self.assertFalse(UploadedFile.objects.filter(order_id='ORD-3', api_key=self.storefront).exists())
        self.assertTrue(os.path.exists(theirs))
        self.assertTrue(UploadedFile.objects.filter(order_id='ORD-3', api_key=self.other).exists())

    def test_a_scoped_purge_for_a_key_with_nothing_here_touches_nothing(self):
        theirs = self.upload(self.other, 'ORD-4', 'theirs.jpg')
        result = purge_order_data('ORD-4', api_key=self.storefront)
        self.assertEqual(result['matched'], 0, result)
        self.assertTrue(os.path.exists(theirs))

    def test_an_order_with_only_an_embed_session_reports_what_it_erased(self):
        EmbedSession.objects.create(
            api_key=self.storefront, order_id='ORD-5', expires_at=timezone.now() + timedelta(hours=2),
        )
        result = purge_order_data('ORD-5', api_key=self.storefront)
        self.assertGreater(result['matched'], 0, result)
        self.assertEqual(result['embed_rows_deleted'], 1)

    def test_an_unknown_order_is_still_not_found(self):
        self.assertEqual(purge_order_data('NO-SUCH-ORDER')['matched'], 0)

    def test_the_endpoint_answers_200_for_an_order_it_erased(self):
        ops = APIKey.objects.create(name='purge-test-ops', key='purge-test-ops-key', is_ops_team=True)
        self.upload(self.storefront, 'ORD-6', 'a.jpg')
        res = self.client.delete('/api/ops/orders/ORD-6/purge?all_tenants=true', HTTP_AUTHORIZATION=f'Bearer {ops.key}')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()['erasure_complete'])
