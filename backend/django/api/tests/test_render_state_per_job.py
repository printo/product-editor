"""
Each render job keeps the design it was submitted with.

A second submit for the same order replaces CanvasData.render_state while an
earlier job may still be queued. That job must print, and its webhook must
describe, its own submit, not the newer one.

Needs Postgres, like the rest of api/tests/.
"""
import json
import os
import shutil
import tempfile
from datetime import timedelta
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from api.models import APIKey, CanvasData, RenderJob
from api.purge import purge_order_data
from api.render_submission import RenderSubmissionService
from api.tasks import _use_job_snapshot, notify_caller_render_failed_task, notify_caller_webhook_task


def _state(tag, paths=()):
    return {'include_uploads': True, 'qty_summary': {'summary': tag}, 'image_paths': list(paths),
            'orientation': {'applied': False, 'tag': tag}}


class PerJobSnapshotTest(TestCase):

    def setUp(self):
        self.key = APIKey.objects.create(name='snapshot-test', key='snapshot-test-key')

    def _submit(self, order, tag, paths=(), callback_url=None):
        with mock.patch.object(RenderSubmissionService, '_enqueue_task'):
            return RenderSubmissionService(self.key, order).submit(
                layout_name='any', image_paths=list(paths), render_state=_state(tag, paths),
                callback_url=callback_url,
            )

    def test_each_job_stores_the_contract_it_was_submitted_with(self):
        first = self._submit('ORD-SNAP', 'first')
        second = self._submit('ORD-SNAP', 'second')
        j1, j2 = RenderJob.objects.get(id=first['job_id']), RenderJob.objects.get(id=second['job_id'])
        self.assertEqual(j1.render_state['qty_summary']['summary'], 'first')
        self.assertEqual(j2.render_state['qty_summary']['summary'], 'second')
        self.assertEqual(
            CanvasData.objects.get(order_id='ORD-SNAP').render_state['qty_summary']['summary'], 'second',
            "the order keeps the latest, as before",
        )

    def test_the_worker_reads_the_job_snapshot_in_memory_only(self):
        first = self._submit('ORD-MEM', 'first')
        self._submit('ORD-MEM', 'second')
        canvas = CanvasData.objects.get(order_id='ORD-MEM')
        _use_job_snapshot(canvas, RenderJob.objects.get(id=first['job_id']))
        self.assertEqual(canvas.render_state['qty_summary']['summary'], 'first')
        self.assertEqual(
            CanvasData.objects.get(order_id='ORD-MEM').render_state['qty_summary']['summary'], 'second',
            "nothing is written back",
        )

    def test_a_job_with_no_snapshot_uses_the_orders(self):
        canvas = CanvasData.objects.create(
            order_id='ORD-OLD', api_key=self.key, layout_name='l', render_state=_state('order'),
            expires_at=timezone.now() + timedelta(days=3),
        )
        job = RenderJob.objects.create(canvas_data=canvas, queue_name='standard')   # render_state NULL
        _use_job_snapshot(canvas, job)
        self.assertEqual(canvas.render_state['qty_summary']['summary'], 'order')

    def _webhook_body(self, order, job_arg, finished):
        """Run the task body as the worker would and return the JSON it posted."""
        sent = {}

        def post(url, data=None, headers=None, timeout=None):
            sent['body'] = json.loads(data)
            return mock.Mock(raise_for_status=lambda: None)

        with override_settings(PUBLIC_HOST='pe.example.com'), \
                mock.patch('services.url_safety.post_webhook_safely', post):
            notify_caller_webhook_task.run(
                str(CanvasData.objects.get(order_id=order).id), ['/x/print.png'], job_arg,
            )
        return sent['body']

    def test_the_webhook_describes_the_job_it_was_sent_for(self):
        first = self._submit('ORD-HOOK', 'first', callback_url='https://hook.example.com/cb')
        second = self._submit('ORD-HOOK', 'second', callback_url='https://hook.example.com/cb')
        now = timezone.now()
        RenderJob.objects.filter(id=first['job_id']).update(status='completed', completed_at=now - timedelta(seconds=5))
        RenderJob.objects.filter(id=second['job_id']).update(status='completed', completed_at=now)

        body = self._webhook_body('ORD-HOOK', first['job_id'], None)

        self.assertEqual(body['job_id'], first['job_id'], 'not the latest completed job')
        self.assertEqual(body['qty_summary']['summary'], 'first', "not the newer submit's design")
        self.assertIn(first['job_id'], body['download_url'])

    def test_a_task_queued_before_this_change_still_finds_the_latest_job(self):
        only = self._submit('ORD-LEGACY', 'only', callback_url='https://hook.example.com/cb')
        RenderJob.objects.filter(id=only['job_id']).update(status='completed', completed_at=timezone.now())
        body = self._webhook_body('ORD-LEGACY', None, None)      # two arguments, as an old message has
        self.assertEqual(body['job_id'], only['job_id'])

    def test_the_failure_notice_names_its_own_job(self):
        first = self._submit('ORD-FAIL', 'first', callback_url='https://hook.example.com/cb')
        self._submit('ORD-FAIL', 'second', callback_url='https://hook.example.com/cb')
        sent = {}

        def post(url, data=None, headers=None, timeout=None):
            sent['body'] = json.loads(data)
            return mock.Mock(raise_for_status=lambda: None)

        with mock.patch('services.url_safety.post_webhook_safely', post):
            notify_caller_render_failed_task.run(
                str(CanvasData.objects.get(order_id='ORD-FAIL').id), 'Render timed out after 570s', first['job_id'],
            )
        self.assertEqual(sent['body']['job_id'], first['job_id'])


class PurgeCoversJobSnapshotsTest(TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='snap-purge-')
        self.addCleanup(shutil.rmtree, self.root, True)
        os.makedirs(os.path.join(self.root, 'uploads'))
        os.makedirs(os.path.join(self.root, 'exports'))
        o = override_settings(UPLOADS_DIR=os.path.join(self.root, 'uploads'),
                              EXPORTS_DIR=os.path.join(self.root, 'exports'), STORAGE_ROOT=self.root)
        o.enable()
        self.addCleanup(o.disable)
        self.key = APIKey.objects.create(name='snap-purge', key='snap-purge-key')

    def test_a_photo_only_an_earlier_submit_named_is_erased_too(self):
        folder = os.path.join(self.root, 'uploads', 'ORD-P')
        os.makedirs(folder)
        old_photo, new_photo = os.path.join(folder, 'old.jpg'), os.path.join(folder, 'new.jpg')
        for p in (old_photo, new_photo):
            open(p, 'wb').write(b'x')
        canvas = CanvasData.objects.create(
            order_id='ORD-P', api_key=self.key, layout_name='l', image_paths=[],
            render_state={'image_paths': [new_photo]}, expires_at=timezone.now() + timedelta(days=3),
        )
        RenderJob.objects.create(canvas_data=canvas, queue_name='standard', status='completed',
                                 render_state={'image_paths': [old_photo]})

        purge_order_data('ORD-P', api_key=self.key)

        self.assertFalse(os.path.exists(old_photo), "a photo only the first job's snapshot names")
        self.assertFalse(os.path.exists(new_photo))
