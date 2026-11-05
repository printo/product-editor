"""
restore.json, end to end through the API: the submit stores what the editor
sent, the render job builds the manifest from it, and the uploads ZIP carries
it with one numbered entry per distinct photo.

The pure half is in services/tests/test_restore_manifest.py. Needs Postgres,
like the rest of api/tests/.
"""
import io
import json
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import timedelta
from unittest import mock

from django.test import Client, TestCase, override_settings
from django.utils import timezone
from PIL import Image

from api.models import APIKey, CanvasData, LayoutCatalogue, RenderJob, UploadedFile
from api.tasks import _build_restore_manifest
from api.views import invalidate_layout_caches

LAYOUT = 'restore_test_4x6'


def _png(path, size):
    Image.new('RGB', size, (200, 30, 30)).save(path)


class RestoreManifestApiTest(TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='pe-restore-test-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.uploads_dir = os.path.join(self.root, 'uploads')
        self.exports_dir = os.path.join(self.root, 'exports')
        os.makedirs(self.uploads_dir)
        os.makedirs(self.exports_dir)
        settings_override = override_settings(UPLOADS_DIR=self.uploads_dir, EXPORTS_DIR=self.exports_dir)
        settings_override.enable()
        self.addCleanup(settings_override.disable)

        self.client = Client()
        self.key = APIKey.objects.create(name='restore-test', key='test-restore-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        invalidate_layout_caches(LAYOUT)
        self.addCleanup(invalidate_layout_caches, LAYOUT)
        self.layout = LayoutCatalogue.objects.create(name=LAYOUT, definition={
            'name': LAYOUT, 'canvas': {'width': 1200, 'height': 1800, 'widthMm': 101.6, 'heightMm': 152.4},
            'frames': [{'id': 'a', 'x': 0.05, 'y': 0.05, 'width': 0.9, 'height': 0.9}],
        })

    # ── helpers ──────────────────────────────────────────────────────────

    def _upload(self, name, size=(40, 30), order_id='JOB-1'):
        upload_id = str(uuid.uuid4())
        path = os.path.join(self.uploads_dir, f'{upload_id}.png')
        _png(path, size)
        UploadedFile.objects.create(
            api_key=self.key, file_path=path, original_filename=name,
            file_size_bytes=os.path.getsize(path), upload_session_id=upload_id, order_id=order_id,
        )
        return upload_id

    def _submit(self, body, include_uploads=None):
        captured = {}

        def fake_submit(self_, **kwargs):
            captured.update(kwargs)
            return {'job_id': 'j', 'order_id': 'JOB-1', 'status_url': '/x', 'queue': 'standard'}

        headers = dict(self.auth)
        if include_uploads is not None:
            headers['HTTP_X_INCLUDE_UPLOADS'] = include_uploads
        with mock.patch('api.render_submission.RenderSubmissionService.submit', fake_submit):
            res = self.client.post('/api/editor/render', body, content_type='application/json', **headers)
        self.assertEqual(res.status_code, 202, res.content)
        return captured['render_state']

    def _job(self, render_state, manifest='build'):
        canvas = CanvasData.objects.create(
            order_id='JOB-1', api_key=self.key, layout_name=LAYOUT,
            image_paths=render_state.get('image_paths') or [], render_state=render_state,
            expires_at=timezone.now() + timedelta(days=3),
        )
        job = RenderJob.objects.create(canvas_data=canvas, queue_name='standard', status='completed')
        job_dir = os.path.join(self.exports_dir, str(job.id))
        os.makedirs(job_dir)
        out = os.path.join(job_dir, 'print.png')
        _png(out, (60, 90))
        job.output_paths = [out]
        if manifest == 'build':
            job.restore_manifest = _build_restore_manifest(canvas, str(job.id), self.layout.version)
        job.save()
        return canvas, job

    def _zip(self, job, query):
        res = self.client.get(f'/api/jobs/{job.id}/download/{query}', **self.auth)
        self.assertEqual(res.status_code, 200, getattr(res, 'content', b'')[:200])
        return zipfile.ZipFile(io.BytesIO(b''.join(res.streaming_content)))

    # ── the submit ───────────────────────────────────────────────────────

    def test_submit_keeps_the_design_and_the_file_ids(self):
        a = self._upload('IMG_0001.jpg')
        state = self._submit({
            'layout_name': LAYOUT, 'order_id': 'JOB-1',
            'canvases': [{'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': a}]}],
            'restore': {
                'editor_state': {'layoutName': LAYOUT, 'surfaces': [{'key': 'default', 'canvases': []}]},
                'files': [{'file_id': 'browser-file-a', 'upload_id': a}],
            },
        })
        self.assertEqual(state['restore'], {
            'editor_state': {'layoutName': LAYOUT, 'surfaces': [{'key': 'default', 'canvases': []}]},
            'file_ids': {a: 'browser-file-a'},
        })

    def test_a_submit_without_the_block_or_with_a_bad_one_is_still_accepted(self):
        a = self._upload('IMG_0001.jpg')
        body = {'layout_name': LAYOUT, 'order_id': 'JOB-1',
                'canvases': [{'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': a}]}]}
        self.assertNotIn('restore', self._submit(body))
        for bad in ('junk', 5, [], {'editor_state': 'x', 'files': 'y'}):
            self.assertNotIn('restore', self._submit({**body, 'restore': bad}))

    def test_nothing_is_kept_when_the_caller_does_not_want_the_uploads(self):
        a = self._upload('IMG_0001.jpg')
        state = self._submit({
            'layout_name': LAYOUT, 'order_id': 'JOB-1',
            'canvases': [{'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': a}]}],
            'restore': {'editor_state': {'surfaces': []}, 'files': [{'file_id': 'f', 'upload_id': a}]},
        }, include_uploads='0')
        self.assertNotIn('restore', state)
        self.assertIsNone(_build_restore_manifest(self._job(state, manifest=None)[0], 'job', 1))

    # ── the manifest and the archive ─────────────────────────────────────

    def _two_card_state(self):
        """Two cards: photo A twice, photo B (same name as A), the customer's
        own sticker, an icon raster, and a calendar date photo."""
        a = self._upload('IMG_0001.jpg', (40, 30))
        b = self._upload('IMG_0001.jpg', (30, 40))
        sticker = self._upload('my sticker.png', (10, 10))
        icon = self._upload('icon.png', (8, 8))
        cell = self._upload('birthday.png', (20, 20))
        state = self._submit({
            'layout_name': LAYOUT, 'order_id': 'JOB-1',
            'canvases': [
                {'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': a}],
                 'overlays': [{'type': 'image', 'source': 'local', 'fileId': sticker},
                              {'type': 'image', 'source': 'icon', 'fileId': icon}],
                 'calendar': {'cells': {'2026-01-14': [{'type': 'image', 'uploadId': cell}]}}},
                {'canvas_index': 1, 'frames': [{'frame_index': 0, 'upload_id': a}]},
                {'canvas_index': 2, 'frames': [{'frame_index': 0, 'upload_id': b}]},
            ],
            'restore': {
                'editor_state': {'layoutName': LAYOUT, 'surfaces': [{'key': 'default', 'canvases': [{'id': 1}]}]},
                'files': [{'file_id': 'fid-a', 'upload_id': a}, {'file_id': 'fid-b', 'upload_id': b},
                          {'file_id': 'fid-sticker', 'upload_id': sticker}, {'file_id': 'fid-cell', 'upload_id': cell}],
            },
        })
        return state, {'a': a, 'b': b, 'sticker': sticker, 'icon': icon, 'cell': cell}

    def test_the_job_lists_each_customer_photo_once_with_its_pixel_size(self):
        state, ids = self._two_card_state()
        _, job = self._job(state)
        m = job.restore_manifest
        self.assertEqual((m['schema_version'], m['order_id'], m['render_job_id'], m['layout_name'], m['layout_version']),
                         (1, 'JOB-1', str(job.id), LAYOUT, self.layout.version))
        self.assertEqual(m['editor_state']['surfaces'][0]['canvases'], [{'id': 1}])
        self.assertEqual(
            [(p['upload_id'], p['file_id'], p['kind'], p['zip_entry'], p['width'], p['height']) for p in m['photos']],
            [(ids['a'], 'fid-a', 'frame', '001_IMG_0001.jpg', 40, 30),
             (ids['b'], 'fid-b', 'frame', '002_IMG_0001.jpg', 30, 40),
             (ids['sticker'], 'fid-sticker', 'overlay', '003_my sticker.png', 10, 10),
             (ids['cell'], 'fid-cell', 'calendar', '004_birthday.png', 20, 20)],
        )
        self.assertTrue(all(p['size_bytes'] > 0 for p in m['photos']))

    def test_the_uploads_zip_carries_restore_json_and_numbered_photos(self):
        state, _ = self._two_card_state()
        _, job = self._job(state)
        zf = self._zip(job, '?content=uploads')
        self.assertEqual(sorted(zf.namelist()), [
            '001_IMG_0001.jpg', '002_IMG_0001.jpg', '003_my sticker.png', '004_birthday.png', 'restore.json',
        ])
        manifest = json.loads(zf.read('restore.json'))
        self.assertEqual(manifest, job.restore_manifest)
        # Every entry the manifest names is in the archive, byte for byte.
        for photo in manifest['photos']:
            row = UploadedFile.objects.get(upload_session_id=photo['upload_id'])
            with open(row.file_path, 'rb') as fh:
                self.assertEqual(zf.read(photo['zip_entry']), fh.read())

    def test_the_combined_zip_keeps_its_folders(self):
        state, _ = self._two_card_state()
        _, job = self._job(state)
        names = self._zip(job, '').namelist()
        self.assertIn('1_customer_uploads/restore.json', names)
        self.assertIn('1_customer_uploads/001_IMG_0001.jpg', names)
        self.assertIn('3_print/print.png', names)
        self.assertEqual(len([n for n in names if n.startswith('1_customer_uploads/')]), 5)

    def test_print_and_mock_parts_never_carry_it(self):
        state, _ = self._two_card_state()
        _, job = self._job(state)
        self.assertEqual(self._zip(job, '?content=print').namelist(), ['print.png'])
        self.assertNotIn('1_customer_uploads/restore.json', self._zip(job, '?include_uploads=0').namelist())

    def test_a_job_rendered_before_manifests_is_packaged_the_old_way(self):
        state, _ = self._two_card_state()
        _, job = self._job(state, manifest=None)
        names = self._zip(job, '?content=uploads').namelist()
        self.assertNotIn('restore.json', names)
        self.assertEqual(set(names), {'IMG_0001.jpg'})      # one entry per frame, the customer's names

    def test_a_photo_deleted_since_is_left_out_of_the_archive(self):
        state, ids = self._two_card_state()
        _, job = self._job(state)
        UploadedFile.objects.filter(upload_session_id=ids['b']).update(is_deleted=True)
        names = self._zip(job, '?content=uploads').namelist()
        self.assertNotIn('002_IMG_0001.jpg', names)
        self.assertIn('001_IMG_0001.jpg', names)
        self.assertIn('restore.json', names)

    def test_another_keys_upload_never_reaches_the_manifest(self):
        other = APIKey.objects.create(name='restore-other', key='test-restore-other-key')
        foreign = str(uuid.uuid4())
        path = os.path.join(self.uploads_dir, 'foreign.png')
        _png(path, (5, 5))
        UploadedFile.objects.create(api_key=other, file_path=path, original_filename='theirs.png',
                                    file_size_bytes=1, upload_session_id=foreign)
        mine = self._upload('mine.png')
        state = {'include_uploads': True, 'canvases': [
            {'frames': [{'upload_id': mine}], 'overlays': [{'type': 'image', 'source': 'local', 'fileId': foreign}]},
        ]}
        _, job = self._job(state)
        self.assertEqual([p['original_name'] for p in job.restore_manifest['photos']], ['mine.png'])
