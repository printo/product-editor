"""
A restore must not bring an erased order back (services/purge_ledger.py).

The scenario, against a real database and real files: an order exists when the
backup is taken, the customer is erased afterwards, then the database is
restored from the backup (rows come back, ledger file does not roll back).
`reapply_purges` must erase the order again, and only that order.

Run:
    docker-compose exec backend python manage.py test api.tests.test_purge_ledger_replay
"""
import io
import os
import shutil
import tempfile
from datetime import timedelta

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from django.utils import timezone

from api.models import APIKey, EmbedSession, UploadedFile
from api.purge import purge_order_data
from services import purge_ledger


class PurgeLedgerReplayTest(TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.uploads = os.path.join(self.root, 'uploads')
        os.makedirs(self.uploads)
        os.makedirs(os.path.join(self.root, 'exports'))
        self.override = override_settings(
            UPLOADS_DIR=self.uploads, EXPORTS_DIR=os.path.join(self.root, 'exports'), STORAGE_ROOT=self.root,
        )
        self.override.enable()
        self.a = APIKey.objects.create(name='ledger-test-a', key='ledger-test-key-a')
        self.b = APIKey.objects.create(name='ledger-test-b', key='ledger-test-key-b')
        self.dump_time = timezone.now() - timedelta(hours=2)

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.root, ignore_errors=True)

    def session(self, key, order_id):
        EmbedSession.objects.create(api_key=key, order_id=order_id, expires_at=timezone.now() + timedelta(hours=2))

    def upload(self, key, order_id, name='p.jpg'):
        folder = os.path.join(self.uploads, order_id)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        with open(path, 'wb') as f:
            f.write(b'photo')
        UploadedFile.objects.create(
            api_key=key, file_path=path, original_filename=name, file_size_bytes=5, order_id=order_id,
        )
        return path

    def replay(self, **kw):
        out = io.StringIO()
        call_command('reapply_purges', since=self.dump_time.strftime('%Y%m%dT%H%M%SZ'), stdout=out, **kw)
        return out.getvalue()

    def test_a_purge_writes_a_ledger_entry_without_the_order_id(self):
        self.session(self.a, 'EXT-LEDGER-1')
        result = purge_order_data('EXT-LEDGER-1')
        self.assertTrue(result['ledger_recorded'], result)
        self.assertNotIn('EXT-LEDGER-1', open(purge_ledger.ledger_path()).read())

    def test_nothing_found_writes_nothing(self):
        purge_order_data('NO-SUCH-ORDER')
        self.assertEqual(purge_ledger.read_entries(), [])

    def test_a_restored_order_is_erased_again_and_others_are_kept(self):
        self.session(self.a, 'ERASED')
        self.session(self.a, 'KEPT')
        purge_order_data('ERASED')                       # after the dump; ledger records it
        self.session(self.a, 'ERASED')                   # the restore brings the rows back
        photo = self.upload(self.a, 'ERASED')
        out = self.replay()
        self.assertIn('purged ERASED', out)
        self.assertFalse(EmbedSession.objects.filter(order_id='ERASED').exists())
        self.assertFalse(UploadedFile.objects.filter(order_id='ERASED').exists())
        self.assertFalse(os.path.exists(photo))
        self.assertTrue(EmbedSession.objects.filter(order_id='KEPT').exists())

    def test_replay_does_not_add_ledger_entries(self):
        self.session(self.a, 'ERASED')
        purge_order_data('ERASED')
        before = len(purge_ledger.read_entries())
        self.session(self.a, 'ERASED')
        self.replay()
        self.assertEqual(len(purge_ledger.read_entries()), before)

    def test_a_key_scoped_purge_does_not_erase_the_other_keys_order(self):
        self.session(self.a, 'SHARED-ID')
        self.session(self.b, 'SHARED-ID')
        purge_order_data('SHARED-ID', api_key=self.a)
        self.session(self.a, 'SHARED-ID')                # restore brings key A's row back
        self.replay()
        self.assertFalse(EmbedSession.objects.filter(order_id='SHARED-ID', api_key=self.a).exists())
        self.assertTrue(EmbedSession.objects.filter(order_id='SHARED-ID', api_key=self.b).exists())

    def test_an_order_recreated_after_the_dump_is_not_touched_by_older_entries(self):
        self.session(self.a, 'REUSED')
        purge_order_data('REUSED')
        # The dump was taken AFTER this erasure and the id was then reused.
        self.dump_time = timezone.now() + timedelta(minutes=5)
        self.session(self.a, 'REUSED')
        self.replay()
        self.assertTrue(EmbedSession.objects.filter(order_id='REUSED').exists())

    def test_dry_run_changes_nothing(self):
        self.session(self.a, 'ERASED')
        purge_order_data('ERASED')
        self.session(self.a, 'ERASED')
        out = self.replay(dry_run=True)
        self.assertIn('would purge ERASED', out)
        self.assertTrue(EmbedSession.objects.filter(order_id='ERASED').exists())

    def test_bad_since_is_an_error(self):
        with self.assertRaises(CommandError):
            call_command('reapply_purges', since='yesterday')
