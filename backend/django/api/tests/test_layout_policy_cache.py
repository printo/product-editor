"""
The over-quantity policy check and the editor must not share a cache entry.

`_read_layout_def` (the quantity check on submit) used to cache the RAW layout
definition under `layout_detail:<name>:` — the key GetLayoutView and
EditorInitView fill with the SHAPED payload (definition + `displayName`) and
return verbatim for two minutes.

The editor's copy expires after those two minutes and a customer usually takes
longer than that to submit, so the policy read found the key cold, refilled it
with the raw definition, and the next editors were served a layout with no
`displayName`. That read also has no public-layout gate, so a non-public
layout's definition could be served from the public key.

Needs Postgres and the real cache, like the rest of api/tests/.
"""
from django.test import Client, TestCase

from api.models import APIKey, LayoutCatalogue
from api.views import invalidate_layout_caches
from api.views.layouts import _read_layout_def

NAME = 'retro_polaroid_4x6'
PRIVATE_NAME = 'internal_only'
DISPLAY_NAME = 'Retro Polaroid Prints (4x6)'


def _definition(name, width=100):
    return {
        'name': name,
        'productType': 'single_canvas',
        'canvas': {'width': width, 'height': 100, 'widthMm': 50, 'heightMm': 50},
    }


class LayoutPolicyCacheTest(TestCase):

    def setUp(self):
        self.client = Client()
        key = APIKey.objects.create(name='policy-cache-test', key='test-policy-cache-key')
        self.auth = {'HTTP_AUTHORIZATION': f'Bearer {key.key}'}
        self._forget()
        LayoutCatalogue.objects.create(
            name=NAME, display_name=DISPLAY_NAME, definition=_definition(NAME),
        )

    def tearDown(self):
        self._forget()

    @staticmethod
    def _forget():
        # Targeted rather than cache.clear(): this suite runs against the
        # same Redis the local dev stack uses.
        for name in (NAME, PRIVATE_NAME):
            invalidate_layout_caches(name)

    def test_submit_time_policy_read_does_not_strip_what_the_editor_is_served(self):
        self.assertIsNotNone(_read_layout_def(NAME))

        detail = self.client.get(f'/api/layouts/{NAME}', **self.auth)

        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(detail.json()['displayName'], DISPLAY_NAME)

    def test_submit_time_policy_read_does_not_strip_the_embed_editor_init(self):
        self.assertIsNotNone(_read_layout_def(NAME))

        init = self.client.get(f'/api/editor/init?layout={NAME}', **self.auth)

        self.assertEqual(init.status_code, 200, init.content)
        self.assertEqual(init.json()['layout']['displayName'], DISPLAY_NAME)

    def test_policy_read_does_not_make_a_non_public_layout_readable(self):
        LayoutCatalogue.objects.create(
            name=PRIVATE_NAME, definition=_definition(PRIVATE_NAME), is_public=False,
        )

        # The policy lookup may see any live layout...
        self.assertIsNotNone(_read_layout_def(PRIVATE_NAME))

        # ...but that must not put it behind the public endpoints.
        detail = self.client.get(f'/api/layouts/{PRIVATE_NAME}', **self.auth)
        init = self.client.get(f'/api/editor/init?layout={PRIVATE_NAME}', **self.auth)
        self.assertEqual(detail.status_code, 404, detail.content)
        self.assertEqual(init.status_code, 404, init.content)

    def test_policy_read_is_cached(self):
        _read_layout_def(NAME)

        with self.assertNumQueries(0):
            self.assertIsNotNone(_read_layout_def(NAME))

    def test_an_ops_edit_is_not_hidden_behind_a_stale_policy_entry(self):
        self.assertEqual(_read_layout_def(NAME)['canvas']['width'], 100)

        LayoutCatalogue.objects.filter(name=NAME).update(definition=_definition(NAME, width=200))
        invalidate_layout_caches(NAME)

        self.assertEqual(_read_layout_def(NAME)['canvas']['width'], 200)
