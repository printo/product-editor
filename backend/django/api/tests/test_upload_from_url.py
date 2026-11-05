"""
POST /api/upload/from-url: a restored design's photo, fetched from the
embedding company's storage and stored as an ordinary upload.

Off until the API key lists a host. The fetch itself (services/photo_fetch.py)
is stood in for here; its own rules are in services/tests/test_photo_fetch.py.

Needs Postgres and the real cache, like the rest of api/tests/.
"""
import io
import os
import shutil
import tempfile
import uuid
from unittest import mock

from django.core.exceptions import ValidationError
from django.test import Client, TestCase, override_settings
from PIL import Image

from api.models import APIKey, UploadedFile
from services import photo_fetch

HOST = 'files.example.com'
URL = f'https://{HOST}/user/20261105_IMG_1234.jpg?sig=secret-token'


def _jpeg(size=(120, 80)):   # the validator's floor is 50 px a side
    buf = io.BytesIO()
    Image.new('RGB', size, (30, 120, 200)).save(buf, format='JPEG')
    return buf.getvalue()


class _Response:
    def __init__(self, body=b'', status=200, headers=None):
        self.status_code, self._body, self.headers, self.closed = status, body, headers or {}, False

    def iter_content(self, chunk_size=None):
        for i in range(0, len(self._body), 16):
            yield self._body[i:i + 16]

    def close(self):
        self.closed = True


class UploadFromUrlTest(TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='pe-from-url-test-')
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.uploads_dir = os.path.join(self.root, 'uploads')
        os.makedirs(self.uploads_dir)
        override = override_settings(UPLOADS_DIR=self.uploads_dir)
        override.enable()
        self.addCleanup(override.disable)

        self.client = Client()
        self.key = APIKey.objects.create(name='from-url-test', key='test-from-url-key', allowed_photo_hosts=HOST)
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {self.key.key}'}
        # The per-order minute counter lives in the real cache: a fresh order per test.
        self.order = f'JOB-{uuid.uuid4().hex[:8]}'

    def _post(self, body=None, response=None, error=None, order='self', auth=None):
        body = {'url': URL} if body is None else body
        opener = mock.Mock(side_effect=error) if error else mock.Mock(return_value=response or _Response(_jpeg()))
        headers = dict(auth or self.auth)
        order = self.order if order == 'self' else order
        if order:
            headers['HTTP_X_ORDER_ID'] = order
        with mock.patch.object(photo_fetch, 'open_public_get', opener):
            res = self.client.post('/api/upload/from-url', body, content_type='application/json', **headers)
        return res, opener

    def _staging_left(self):
        chunks = os.path.join(self.uploads_dir, '.chunks')
        return os.listdir(chunks) if os.path.isdir(chunks) else []

    # ── switched off unless the key names a host ─────────────────────────

    def test_a_key_with_no_host_list_is_refused_and_nothing_is_fetched(self):
        plain = APIKey.objects.create(name='from-url-plain', key='test-from-url-plain-key')
        res, opener = self._post(auth={'HTTP_AUTHORIZATION': f'Bearer {plain.key}'})
        self.assertEqual(res.status_code, 403)
        self.assertIn('not switched on', res.json()['detail'])
        self.assertFalse(opener.called)

    def test_a_host_the_key_did_not_list_is_refused(self):
        res, opener = self._post({'url': 'https://evil.example.org/a.jpg'})
        self.assertEqual(res.status_code, 403)
        self.assertFalse(opener.called)
        self.assertEqual(UploadedFile.objects.count(), 0)
        self.assertEqual(self._staging_left(), [])

    def test_one_keys_list_does_not_serve_another_key(self):
        other = APIKey.objects.create(name='from-url-other', key='test-from-url-other-key', allowed_photo_hosts='cdn.other.example')
        res, opener = self._post(auth={'HTTP_AUTHORIZATION': f'Bearer {other.key}'})
        self.assertEqual(res.status_code, 403)
        self.assertFalse(opener.called)

    def test_no_api_key_is_refused(self):
        res = self.client.post('/api/upload/from-url', {'url': URL}, content_type='application/json')
        self.assertIn(res.status_code, (401, 403))

    # ── a good fetch is an ordinary upload ───────────────────────────────

    def test_a_fetched_photo_is_stored_under_its_order_like_any_upload(self):
        data = _jpeg()
        res, opener = self._post(response=_Response(data))
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual(body['filename'], '20261105_IMG_1234.jpg')
        self.assertEqual(body['file_size'], len(data))
        self.assertEqual(opener.call_args.args[0], URL)

        row = UploadedFile.objects.get(upload_session_id=body['upload_id'])
        self.assertEqual((row.api_key, row.order_id, row.original_filename, row.file_size_bytes, row.file_type),
                         (self.key, self.order, '20261105_IMG_1234.jpg', len(data), 'image'))
        self.assertTrue(row.file_path.startswith(os.path.join(os.path.realpath(self.uploads_dir), self.order) + os.sep))
        with open(row.file_path, 'rb') as fh:
            self.assertEqual(fh.read(), data)             # the bytes as fetched, not re-encoded
        self.assertIsNotNone(row.expires_at)              # on the retention clock like any upload
        self.assertEqual(self._staging_left(), [])

    def test_the_upload_id_is_accepted_by_the_render_submit(self):
        from api.models import LayoutCatalogue
        from api.views import invalidate_layout_caches
        name = 'from_url_test_4x6'
        invalidate_layout_caches(name)
        self.addCleanup(invalidate_layout_caches, name)
        LayoutCatalogue.objects.create(name=name, definition={
            'name': name, 'canvas': {'width': 1200, 'height': 1800, 'widthMm': 101.6, 'heightMm': 152.4},
            'frames': [{'id': 'a', 'x': 0.05, 'y': 0.05, 'width': 0.9, 'height': 0.9}],
        })
        upload_id = self._post()[0].json()['upload_id']
        captured = {}

        def fake_submit(self_, **kwargs):
            captured.update(kwargs)
            return {'job_id': 'j', 'order_id': self.order, 'status_url': '/x', 'queue': 'standard'}

        with mock.patch('api.render_submission.RenderSubmissionService.submit', fake_submit):
            res = self.client.post('/api/editor/render', {
                'layout_name': name,
                'canvases': [{'canvas_index': 0, 'frames': [{'frame_index': 0, 'upload_id': upload_id}]}],
            }, content_type='application/json', HTTP_X_ORDER_ID=self.order, **self.auth)
        self.assertEqual(res.status_code, 202, res.content)
        self.assertEqual(captured['image_paths'], [UploadedFile.objects.get(upload_session_id=upload_id).file_path])

    def test_the_name_can_be_given_and_is_made_safe(self):
        res, _ = self._post({'url': URL, 'filename': '../../etc/Birthday Party.JPG'})
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()['filename'], 'Birthday Party.JPG')
        row = UploadedFile.objects.get(upload_session_id=res.json()['upload_id'])
        self.assertTrue(os.path.realpath(row.file_path).startswith(os.path.realpath(self.uploads_dir) + os.sep))

    # ── what is refused, and that it leaves nothing behind ───────────────

    def test_bytes_that_are_not_an_image_are_refused(self):
        res, _ = self._post(response=_Response(b'<html>not a photo</html>' * 20))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(UploadedFile.objects.count(), 0)
        self.assertEqual(self._staging_left(), [])
        self.assertEqual(os.listdir(self.uploads_dir), ['.chunks'])

    def test_a_link_without_an_image_extension_needs_a_name(self):
        res, _ = self._post({'url': f'https://{HOST}/blob/abc123'})
        self.assertEqual(res.status_code, 400)
        ok, _ = self._post({'url': f'https://{HOST}/blob/abc123', 'filename': 'IMG_1.jpg'})
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_upstream_failures_answer_with_their_own_status(self):
        for response, error, expected in (
            (_Response(status=404), None, 502),
            (_Response(status=302), None, 502),
            (None, ConnectionError('down'), 502),
            (None, ValidationError('callback_url host is not publicly routable.'), 403),
            (_Response(_jpeg(), headers={'Content-Length': str(10 ** 10)}), None, 413),
        ):
            res, _ = self._post(response=response, error=error)
            self.assertEqual(res.status_code, expected, res.content)
            self.assertNotIn('secret-token', res.content.decode())
        self.assertEqual(UploadedFile.objects.count(), 0)
        self.assertEqual(self._staging_left(), [])

    @override_settings(MAX_UPLOAD_FILE_SIZE=100)
    def test_the_size_limit_is_enforced_while_reading(self):
        res, _ = self._post(response=_Response(_jpeg((400, 400))))
        self.assertEqual(res.status_code, 413)
        self.assertEqual(self._staging_left(), [])

    def test_an_order_and_a_url_are_required(self):
        self.assertEqual(self._post(order=None)[0].status_code, 400)
        self.assertEqual(self._post(order='bad order!')[0].status_code, 400)
        self.assertEqual(self._post({})[0].status_code, 400)
        self.assertEqual(self._post({'url': 'http://files.example.com/a.jpg'})[0].status_code, 400)
        body_order, _ = self._post({'url': URL, 'order_id': self.order}, order=None)
        self.assertEqual(body_order.status_code, 201, body_order.content)

    # ── limits on what one order can make us download ────────────────────

    @override_settings(PHOTO_FETCH_PER_MINUTE=2)
    def test_fetches_for_one_order_are_rate_limited(self):
        self.assertEqual(self._post()[0].status_code, 201)
        self.assertEqual(self._post()[0].status_code, 201)
        limited, opener = self._post()
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited['Retry-After'], '60')
        self.assertFalse(opener.called)
        # Another order of the same key is not affected.
        self.assertEqual(self._post(order=f'JOB-{uuid.uuid4().hex[:8]}')[0].status_code, 201)

    @override_settings(PHOTO_FETCH_MAX_FILES_PER_ORDER=2)
    def test_an_order_cannot_hold_more_files_than_the_cap(self):
        self.assertEqual(self._post()[0].status_code, 201)
        self.assertEqual(self._post()[0].status_code, 201)
        full, opener = self._post()
        self.assertEqual(full.status_code, 429)
        self.assertFalse(opener.called)

    @override_settings(PHOTO_FETCH_MAX_ORDER_MB=0)
    def test_an_order_cannot_hold_more_bytes_than_the_cap(self):
        res, opener = self._post()
        self.assertEqual(res.status_code, 429)
        self.assertFalse(opener.called)

    # ── the admin field ──────────────────────────────────────────────────

    def test_the_host_list_accepts_only_plain_host_names(self):
        self.key.allowed_photo_hosts = 'files.printo.in\ncdn.example.com'
        self.key.full_clean()
        self.assertEqual(self.key.photo_hosts(), ['files.printo.in', 'cdn.example.com'])
        for bad in ('https://files.printo.in', '*.printo.in', 'files.printo.in/user', '10.0.0.1'):
            self.key.allowed_photo_hosts = bad
            with self.assertRaises(ValidationError) as ctx:
                self.key.full_clean()
            self.assertIn('allowed_photo_hosts', ctx.exception.message_dict)

    def test_existing_keys_start_with_the_fetch_off(self):
        self.assertEqual(APIKey.objects.create(name='from-url-new', key='test-from-url-new-key').photo_hosts(), [])
