"""
GET /api/exports/<path>: one company's files are not another company's.

The path starts with a job id, which says nothing about whose job it is, so an
API key reads only exports of its own renders. The file is streamed from disk
rather than read whole into memory.

Needs Postgres, like the rest of api/tests/.
"""
import os
import shutil
import tempfile
import uuid
from datetime import timedelta

from django.http import FileResponse
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from api.models import APIKey, CanvasData, ExportedResult, RenderJob


class ExportDownloadTest(TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='export-dl-test-')
        self.exports = os.path.join(self.root, 'exports')
        os.makedirs(self.exports)
        override = override_settings(EXPORTS_DIR=self.exports)
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, self.root, True)
        self.a = APIKey.objects.create(name='export-a', key='export-key-a', can_access_exports=True)
        self.b = APIKey.objects.create(name='export-b', key='export-key-b', can_access_exports=True)

    def _job_file(self, api_key, order_id, name='print.png', body=b'pixels'):
        canvas = CanvasData.objects.create(
            order_id=order_id, api_key=api_key, layout_name='l',
            expires_at=timezone.now() + timedelta(days=3),
        )
        job = RenderJob.objects.create(canvas_data=canvas, queue_name='standard')
        folder = os.path.join(self.exports, str(job.id))
        os.makedirs(folder)
        with open(os.path.join(folder, name), 'wb') as fh:
            fh.write(body)
        return job, f'{job.id}/{name}'

    def _get(self, key, path):
        return Client().get(f'/api/exports/{path}', HTTP_AUTHORIZATION=f'Bearer {key}')

    def test_the_owner_downloads_and_it_is_streamed(self):
        _job, path = self._job_file(self.a, 'ORD-A', body=b'abc' * 1000)
        res = self._get('export-key-a', path)
        self.assertEqual(res.status_code, 200)
        self.assertIsInstance(res, FileResponse)
        self.assertEqual(b''.join(res.streaming_content), b'abc' * 1000)
        self.assertIn('attachment', res['Content-Disposition'])

    def test_another_companys_key_gets_404_not_the_file(self):
        _job, path = self._job_file(self.a, 'ORD-A')
        res = self._get('export-key-b', path)
        self.assertEqual(res.status_code, 404)
        self.assertNotIn(b'pixels', res.content)

    def test_a_sync_export_row_belongs_to_its_key(self):
        folder = os.path.join(self.exports, 'sync-render')
        os.makedirs(folder)
        full = os.path.join(folder, 'a.png')
        with open(full, 'wb') as fh:
            fh.write(b'sync')
        ExportedResult.objects.create(
            api_key=self.a, layout_name='l', export_file_path=full,
            generation_time_ms=1, file_size_bytes=4, expires_at=timezone.now() + timedelta(days=1),
        )
        self.assertEqual(self._get('export-key-a', 'sync-render/a.png').status_code, 200)
        self.assertEqual(self._get('export-key-b', 'sync-render/a.png').status_code, 404)

    def test_a_path_with_no_owner_is_404_and_traversal_is_still_refused(self):
        stray = os.path.join(self.exports, str(uuid.uuid4()))
        os.makedirs(stray)
        with open(os.path.join(stray, 'x.png'), 'wb') as fh:
            fh.write(b'x')
        self.assertEqual(self._get('export-key-a', f'{os.path.basename(stray)}/x.png').status_code, 404)
        self.assertEqual(self._get('export-key-a', '../etc/passwd').status_code, 403)
