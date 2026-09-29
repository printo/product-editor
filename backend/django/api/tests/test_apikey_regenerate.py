"""Rotating an APIKey in place from the Django admin."""

from django.contrib.admin.models import LogEntry
from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from api.models import APIKey, CanvasData, EmbedSession


# What nginx adds on every request; ProxyAuthenticationMiddleware rejects
# /django-admin/ requests without them when DEBUG=0.
VIA_PROXY = {'HTTP_X_FORWARDED_PROTO': 'https', 'HTTP_X_FORWARDED_HOST': 'testserver'}


class APIKeyRegenerateTest(TestCase):
    def setUp(self):
        self.client = self.client_class(secure=True, **VIA_PROXY)
        self.admin = User.objects.create_superuser('boss', 'b@printo.in', 'pw')
        self.staff = User.objects.create_user('staff', 's@printo.in', 'pw', is_staff=True)
        self.key = APIKey.create_key('Partner')
        self.old = self.key.key
        EmbedSession.objects.create(
            api_key=self.key, order_id='ORD-1',
            expires_at=timezone.now() + timezone.timedelta(hours=2),
        )
        CanvasData.objects.create(
            api_key=self.key, order_id='ORD-1', layout_name='x',
            expires_at=timezone.now() + timezone.timedelta(days=3),
        )
        self.url = reverse('admin:api_apikey_regenerate', args=[self.key.pk])

    def test_model_regenerate_keeps_row_and_dependents(self):
        new = self.key.regenerate()
        self.key.refresh_from_db()
        self.assertEqual(self.key.key, new)
        self.assertNotEqual(new, self.old)
        self.assertTrue(new.startswith('editor_'))
        self.assertEqual(EmbedSession.objects.filter(api_key=self.key).count(), 1)
        self.assertEqual(CanvasData.objects.filter(api_key=self.key).count(), 1)

    def test_env_seeded_key_refuses(self):
        seeded = APIKey.create_key('DIRECT')
        with self.assertRaises(ValueError):
            seeded.regenerate()

    def test_get_shows_confirmation_without_rotating(self):
        self.client.force_login(self.admin)
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, 200)
        self.assertNotContains(resp, self.old)
        self.key.refresh_from_db()
        self.assertEqual(self.key.key, self.old)

    def test_post_rotates_reveals_once_and_logs(self):
        self.client.force_login(self.admin)
        resp = self.client.post(self.url)
        self.key.refresh_from_db()
        self.assertNotEqual(self.key.key, self.old)
        self.assertContains(resp, self.key.key)
        self.assertIn('no-store', resp['Cache-Control'])
        self.assertTrue(LogEntry.objects.filter(
            object_id=str(self.key.pk), change_message='Regenerated API key').exists())

        change = self.client.get(reverse('admin:api_apikey_change', args=[self.key.pk]))
        self.assertNotContains(change, self.key.key)
        self.assertContains(change, self.key.key[-4:])
        self.assertContains(change, 'Regenerate key')

    def test_non_superuser_forbidden(self):
        self.client.force_login(self.staff)
        resp = self.client.post(self.url)
        self.assertIn(resp.status_code, (302, 403))
        self.key.refresh_from_db()
        self.assertEqual(self.key.key, self.old)

    def test_env_seeded_key_redirects_without_rotating(self):
        seeded = APIKey.create_key('EXTERNAL')
        before = seeded.key
        self.client.force_login(self.admin)
        resp = self.client.post(reverse('admin:api_apikey_regenerate', args=[seeded.pk]))
        self.assertEqual(resp.status_code, 302)
        seeded.refresh_from_db()
        self.assertEqual(seeded.key, before)

    def test_admin_add_generates_and_reveals_key(self):
        self.client.force_login(self.admin)
        resp = self.client.post(reverse('admin:api_apikey_add'), {
            'name': 'New Partner', 'description': '',
            'can_generate_layouts': 'on', 'can_list_layouts': 'on',
            'can_access_exports': 'on', 'max_requests_per_day': 1000, 'is_active': 'on',
        })
        created = APIKey.objects.get(name='New Partner')
        self.assertTrue(created.key.startswith('editor_'))
        self.assertContains(resp, created.key)
