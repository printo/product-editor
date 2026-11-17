"""
POST /api/upload/init and POST /api/orientation/detect keep their own limits,
because /api/upload/ is exempt from the per-IP rate limit.

Needs Postgres and the real cache, like the rest of api/tests/.
"""
import io
import os
import shutil
import tempfile
import uuid
from unittest import mock

from django.test import Client, TestCase, override_settings
from PIL import Image

from api.models import APIKey, UploadedFile


def _jpeg(size=(120, 80)):
    buf = io.BytesIO()
    Image.new('RGB', size, (30, 120, 200)).save(buf, format='JPEG')
    return buf.getvalue()


class LimitsTest(TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='pe-limits-test-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.uploads_dir = os.path.join(self.root, 'uploads')
        os.makedirs(self.uploads_dir)
        override = override_settings(UPLOADS_DIR=self.uploads_dir)
        override.enable()
        self.addCleanup(override.disable)
        self.client = Client()
        self.key = APIKey.objects.create(name='limits-test', key='test-limits-key')
        self.headers = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        self.order = f'JOB-{uuid.uuid4().hex[:8]}'  # the counter lives in the real cache

    def _init(self, order='self'):
        headers = dict(self.headers)
        order = self.order if order == 'self' else order
        if order:
            headers['HTTP_X_ORDER_ID'] = order
        return self.client.post(
            '/api/upload/init', {'filename': 'a.jpg', 'file_size': 1000, 'total_chunks': 1},
            content_type='application/json', **headers,
        )

    def test_starting_uploads_is_counted_per_order(self):
        with override_settings(UPLOAD_INIT_PER_MINUTE=3):
            codes = [self._init().status_code for _ in range(5)]
            other = self._init(order=f'JOB-{uuid.uuid4().hex[:8]}').status_code
        self.assertEqual(codes, [201, 201, 201, 429, 429])
        self.assertEqual(other, 201)  # another order is unaffected

    def test_a_refused_start_stages_nothing(self):
        with override_settings(UPLOAD_INIT_PER_MINUTE=1):
            self._init()
            before = len(os.listdir(os.path.join(self.uploads_dir, '.chunks')))
            res = self._init()
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res['Retry-After'], '60')
        self.assertEqual(len(os.listdir(os.path.join(self.uploads_dir, '.chunks'))), before)

    def test_an_order_that_holds_its_most_is_refused(self):
        UploadedFile.objects.create(
            api_key=self.key, order_id=self.order, original_filename='x.jpg',
            file_path='/nowhere', file_size_bytes=10,
        )
        with override_settings(PHOTO_FETCH_MAX_FILES_PER_ORDER=1):
            self.assertEqual(self._init().status_code, 429)
            self.assertEqual(self._init(order='').status_code, 201)  # no order named: not judged by it

    def _detect(self, body, order='self'):
        headers = dict(self.headers)
        order = self.order if order == 'self' else order
        if order:
            headers['HTTP_X_ORDER_ID'] = order
        upload = io.BytesIO(body)
        upload.name = 'p.jpg'
        return self.client.post('/api/orientation/detect', {'file': upload}, **headers)

    def test_orientation_checks_are_counted_per_order(self):
        with override_settings(ORIENTATION_DETECT_PER_MINUTE=2, AUTO_ORIENTATION_MODE='mediapipe'), \
                mock.patch('services.orientation.detect_rotation', return_value=None):
            codes = [self._detect(_jpeg()).status_code for _ in range(3)]
        self.assertEqual(codes, [204, 204, 429])

    def test_orientation_refuses_a_file_over_the_upload_ceiling(self):
        with override_settings(MAX_UPLOAD_FILE_SIZE=100, AUTO_ORIENTATION_MODE='mediapipe'):
            self.assertEqual(self._detect(_jpeg()).status_code, 413)

    def test_orientation_refuses_a_photo_with_too_many_pixels_without_decoding_it(self):
        with override_settings(MAX_PHOTO_MEGAPIXELS=0, AUTO_ORIENTATION_MODE='mediapipe'), \
                mock.patch('services.orientation.detect_rotation') as detect:
            res = self._detect(_jpeg())
        self.assertEqual(res.status_code, 400)
        self.assertFalse(detect.called)

    def test_a_normal_photo_still_reaches_the_detector(self):
        with override_settings(AUTO_ORIENTATION_MODE='mediapipe'), \
                mock.patch('services.orientation.detect_rotation', return_value=None) as detect:
            res = self._detect(_jpeg())
        self.assertEqual(res.status_code, 204)
        self.assertTrue(detect.called)
