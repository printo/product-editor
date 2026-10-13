"""APIKey.max_requests_per_day, end to end: a capped key is answered 429 once
its audited calls for the IST day reach the cap, an uncapped key never is.
Needs the real cache (the counter lives in Redis) and Postgres (the key row),
which is why it sits here and not in services/tests/."""
from django.core.cache import cache
from django.test import TestCase

from api.models import APIKey, APIRequest


class ApiKeyDailyCapTest(TestCase):
    def setUp(self):
        cache.clear()
        self.capped = APIKey.objects.create(name='cap-test-capped', key='cap-test-key-capped', max_requests_per_day=2)
        self.open = APIKey.objects.create(name='cap-test-open', key='cap-test-key-open')

    def tearDown(self):
        cache.clear()

    def _get(self, key):
        return self.client.get('/api/layouts', HTTP_AUTHORIZATION=f'Bearer {key.key}')

    def test_default_is_no_cap(self):
        self.assertIsNone(self.open.max_requests_per_day)

    def test_capped_key_is_throttled_on_the_call_after_the_cap(self):
        self.assertNotEqual(self._get(self.capped).status_code, 429)
        self.assertNotEqual(self._get(self.capped).status_code, 429)
        res = self._get(self.capped)
        self.assertEqual(res.status_code, 429)
        self.assertIn('Retry-After', res)
        self.assertIn('midnight IST', res.json()['detail'])
        # The refusal is in the audit trail under the key, and did not spend quota.
        self.assertTrue(APIRequest.objects.filter(api_key=self.capped, status_code=429).exists())
        self.assertEqual(self._get(self.capped).status_code, 429)

    def test_uncapped_key_is_never_throttled(self):
        for _ in range(5):
            self.assertNotEqual(self._get(self.open).status_code, 429)

    def test_keys_do_not_share_a_counter(self):
        for _ in range(3):
            self._get(self.open)
        self.assertNotEqual(self._get(self.capped).status_code, 429)
