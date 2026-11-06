"""garbage_collector_task end to end, against real Postgres and a temp storage root.

A characterization test: it pins what one sweep deletes, keeps and reports so the
task can be split into per-sweep functions without changing behaviour. Every
sweep in the task has a case here; the result keys are pinned as a set because
/api/celery/monitor/ and services/gc_status.py read them.
"""
import os
import shutil
import tempfile
import uuid
from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone

from api.models import (
    APIKey, APIRequest, CanvasData, EmbedSession, ExportedResult, RenderJob, UploadedFile,
)
from api.tasks import garbage_collector_task

RESULT_KEYS = {
    'purge_ledger_trimmed', 'chunk_staging', 'orphan_exports', 'deleted_count',
    'deleted_bytes', 'skipped_count', 'upload_deleted_count', 'upload_deleted_bytes',
    'async_render_files_deleted', 'async_render_bytes_deleted', 'canvas_data_deleted',
    'tombstones_deleted', 'audit_rows_deleted', 'embed_sessions_deleted',
    'disk_usage_percent',
}


class GarbageCollectorTaskTest(TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='gc-task-test-')
        self.exports = os.path.join(self.root, 'exports')
        self.uploads = os.path.join(self.root, 'uploads')
        os.makedirs(self.exports)
        os.makedirs(self.uploads)
        overrides = override_settings(
            STORAGE_ROOT=self.root, EXPORTS_DIR=self.exports, UPLOADS_DIR=self.uploads,
            EXPORT_RETENTION_DAYS=3, EXPORT_RETENTION_DAYS_UNDER_PRESSURE=3,
            API_AUDIT_RETENTION_DAYS=90,
        )
        overrides.enable()
        self.addCleanup(overrides.disable)
        self.addCleanup(shutil.rmtree, self.root, True)
        self.key = APIKey.objects.create(name='gc-test', key='gc-test-key')
        self.now = timezone.now()

    def _file(self, folder, name, size=10):
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        with open(path, 'wb') as fh:
            fh.write(b'x' * size)
        return path

    def _age(self, obj, days):
        type(obj).objects.filter(pk=obj.pk).update(created_at=self.now - timedelta(days=days))

    def _export(self, path, expires_in_days, age_days=1):
        row = ExportedResult.objects.create(
            api_key=self.key, layout_name='l', export_file_path=path,
            generation_time_ms=1, file_size_bytes=10,
            expires_at=self.now + timedelta(days=expires_in_days),
        )
        self._age(row, age_days)
        return row

    def _upload(self, path, expires_in_days, age_days=1):
        row = UploadedFile.objects.create(
            api_key=self.key, file_path=path, original_filename='p.png', file_size_bytes=10,
            expires_at=self.now + timedelta(days=expires_in_days),
        )
        self._age(row, age_days)
        return row

    def _canvas(self, order_id, expires_in_days, review=False):
        return CanvasData.objects.create(
            order_id=order_id, api_key=self.key, layout_name='l',
            expires_at=self.now + timedelta(days=expires_in_days),
            requires_manual_review=review,
        )

    def test_result_keys_are_stable(self):
        self.assertEqual(set(garbage_collector_task()), RESULT_KEYS)

    def test_expired_export_is_removed_and_flagged_and_live_one_kept(self):
        old_dir = os.path.join(self.exports, str(uuid.uuid4()))
        old = self._file(old_dir, 'a.png', size=25)
        live = self._file(os.path.join(self.exports, 'live'), 'b.png')
        old_row = self._export(old, expires_in_days=-1)
        live_row = self._export(live, expires_in_days=2)

        result = garbage_collector_task()

        self.assertFalse(os.path.exists(old))
        self.assertFalse(os.path.isdir(old_dir), 'emptied export directory is removed')
        self.assertTrue(os.path.exists(live))
        self.assertEqual((result['deleted_count'], result['deleted_bytes']), (1, 25))
        old_row.refresh_from_db()
        live_row.refresh_from_db()
        self.assertTrue(old_row.is_deleted)
        self.assertFalse(live_row.is_deleted)

    def test_export_of_a_manual_review_order_is_skipped_by_whole_path_segment(self):
        CanvasData.objects.create(
            order_id='EXT-1', api_key=self.key, layout_name='l',
            expires_at=self.now + timedelta(days=5), requires_manual_review=True,
        )
        held = self._file(os.path.join(self.exports, 'EXT-1'), 'a.png')
        other = self._file(os.path.join(self.exports, 'EXT-12'), 'a.png')
        self._export(held, expires_in_days=-1)
        self._export(other, expires_in_days=-1)

        result = garbage_collector_task()

        self.assertTrue(os.path.exists(held))
        self.assertFalse(os.path.exists(other), 'EXT-1 must not match inside EXT-12')
        self.assertEqual((result['deleted_count'], result['skipped_count']), (1, 1))

    def test_expired_upload_is_removed_and_flagged(self):
        gone = self._file(self.uploads, 'old.png', size=7)
        kept = self._file(self.uploads, 'new.png')
        gone_row = self._upload(gone, expires_in_days=-1)
        self._upload(kept, expires_in_days=2)

        result = garbage_collector_task()

        self.assertFalse(os.path.exists(gone))
        self.assertTrue(os.path.exists(kept))
        self.assertEqual((result['upload_deleted_count'], result['upload_deleted_bytes']), (1, 7))
        gone_row.refresh_from_db()
        self.assertTrue(gone_row.is_deleted)

    def test_expired_canvas_loses_its_render_files_and_rows_but_review_canvas_stays(self):
        canvas = self._canvas('ORD-OLD', expires_in_days=-1)
        job_dir = os.path.join(self.exports, str(uuid.uuid4()))
        out = self._file(job_dir, 'out.png', size=40)
        job = RenderJob.objects.create(
            canvas_data=canvas, queue_name='standard', output_paths=[out], status='processing',
        )
        self._age(job, 3)
        held = self._canvas('ORD-HELD', expires_in_days=-1, review=True)
        held_dir = os.path.join(self.exports, str(uuid.uuid4()))
        held_out = self._file(held_dir, 'out.png')
        held_job = RenderJob.objects.create(
            canvas_data=held, queue_name='standard', output_paths=[held_out], status='completed',
        )
        self._age(held_job, 3)

        result = garbage_collector_task()

        self.assertFalse(os.path.exists(out))
        self.assertFalse(os.path.isdir(job_dir))
        self.assertTrue(os.path.exists(held_out))
        self.assertEqual((result['async_render_files_deleted'], result['async_render_bytes_deleted']), (1, 40))
        # QuerySet.delete() counts the cascaded RenderJob row as well.
        self.assertEqual(result['canvas_data_deleted'], 2)
        self.assertFalse(CanvasData.objects.filter(order_id='ORD-OLD').exists())
        self.assertFalse(RenderJob.objects.filter(pk=job.pk).exists())
        self.assertTrue(CanvasData.objects.filter(order_id='ORD-HELD').exists())

    def test_a_job_under_a_day_old_keeps_its_files_even_on_an_expired_canvas(self):
        canvas = self._canvas('ORD-NEW', expires_in_days=-1)
        out = self._file(os.path.join(self.exports, str(uuid.uuid4())), 'out.png')
        RenderJob.objects.create(canvas_data=canvas, queue_name='standard', output_paths=[out])

        result = garbage_collector_task()

        self.assertTrue(os.path.exists(out))
        self.assertEqual(result['async_render_files_deleted'], 0)

    def test_tombstones_older_than_the_window_are_hard_deleted(self):
        old_export = self._export('/nope/a', expires_in_days=-1, age_days=10)
        old_upload = self._upload('/nope/b', expires_in_days=-1, age_days=10)
        recent = self._export('/nope/c', expires_in_days=-1, age_days=1)
        for row in (old_export, old_upload, recent):
            type(row).objects.filter(pk=row.pk).update(is_deleted=True)

        result = garbage_collector_task()

        self.assertEqual(result['tombstones_deleted'], 2)
        self.assertFalse(ExportedResult.objects.filter(pk=old_export.pk).exists())
        self.assertFalse(UploadedFile.objects.filter(pk=old_upload.pk).exists())
        self.assertTrue(ExportedResult.objects.filter(pk=recent.pk).exists())

    def test_audit_rows_and_embed_sessions_have_their_own_clocks(self):
        def audit(days):
            row = APIRequest.objects.create(
                api_key=self.key, endpoint='/x', method='GET', status_code=200,
                response_time_ms=1,
            )
            APIRequest.objects.filter(pk=row.pk).update(created_at=self.now - timedelta(days=days))
            return row

        old_audit, fresh_audit = audit(100), audit(10)
        old_session = EmbedSession.objects.create(
            api_key=self.key, order_id='S-OLD', expires_at=self.now - timedelta(days=31))
        fresh_session = EmbedSession.objects.create(
            api_key=self.key, order_id='S-NEW', expires_at=self.now - timedelta(days=5))

        result = garbage_collector_task()

        self.assertEqual(result['audit_rows_deleted'], 1)
        self.assertFalse(APIRequest.objects.filter(pk=old_audit.pk).exists())
        self.assertTrue(APIRequest.objects.filter(pk=fresh_audit.pk).exists())
        self.assertEqual(result['embed_sessions_deleted'], 1)
        self.assertFalse(EmbedSession.objects.filter(pk=old_session.pk).exists())
        self.assertTrue(EmbedSession.objects.filter(pk=fresh_session.pk).exists())

    def test_a_missing_file_still_flags_its_row(self):
        row = self._export(os.path.join(self.exports, 'missing.png'), expires_in_days=-1)
        result = garbage_collector_task()
        row.refresh_from_db()
        self.assertTrue(row.is_deleted)
        self.assertEqual(result['deleted_count'], 0)
