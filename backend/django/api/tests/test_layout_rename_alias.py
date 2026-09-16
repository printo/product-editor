"""
Tests for LayoutCatalogue.resolve_active() — the rename-alias fallback.

Context: LayoutCatalogue.name is both the ops-editable display name AND the
identifier partners (printo.in) hardcode into their iframe embed URLs
(`/editor/layout/<name>?token=...`). Renaming a layout used to soft-delete
the old row with no forwarding pointer, so every read path (editor init,
layout fetch, render submission) 404'd on the old name immediately and
forever, with no way for the caller to find out short of a support ticket.

resolve_active() follows a `renamed_to` pointer set at rename time so a
stale name keeps resolving to whatever the layout is called now.
"""

import json

from django.test import TestCase, Client
from api.models import APIKey, LayoutCatalogue


def _layout_def(name):
    return {
        'name': name,
        'productType': 'single_canvas',
        'canvas': {'width': 100, 'height': 100, 'widthMm': 50, 'heightMm': 50},
    }


class ResolveActiveTest(TestCase):
    """Model-level behavior of the alias resolver."""

    def test_active_layout_resolves_to_itself(self):
        layout = LayoutCatalogue.objects.create(
            name='classic_a4', definition=_layout_def('classic_a4'),
        )
        resolved = LayoutCatalogue.resolve_active('classic_a4')
        self.assertEqual(resolved.pk, layout.pk)

    def test_renamed_layout_resolves_via_old_name(self):
        old = LayoutCatalogue.objects.create(
            name='classic_a4', definition=_layout_def('classic_a4'),
        )
        new = LayoutCatalogue.objects.create(
            name='classic_prints_4x6', definition=_layout_def('classic_prints_4x6'),
            version=2,
        )
        old.is_deprecated = True
        old.renamed_to = new
        old.save()

        resolved = LayoutCatalogue.resolve_active('classic_a4')
        self.assertEqual(resolved.pk, new.pk)
        self.assertEqual(resolved.name, 'classic_prints_4x6')

    def test_multi_hop_rename_chain_resolves(self):
        """A renamed twice (A -> B -> C) still resolves from the original name."""
        a = LayoutCatalogue.objects.create(name='a', definition=_layout_def('a'))
        b = LayoutCatalogue.objects.create(name='b', definition=_layout_def('b'), version=2)
        c = LayoutCatalogue.objects.create(name='c', definition=_layout_def('c'), version=3)

        a.is_deprecated = True
        a.renamed_to = b
        a.save()
        b.is_deprecated = True
        b.renamed_to = c
        b.save()

        resolved = LayoutCatalogue.resolve_active('a')
        self.assertEqual(resolved.name, 'c')

    def test_deprecated_without_rename_still_404s(self):
        """A genuinely deleted layout (deprecated, no renamed_to) must not resolve."""
        LayoutCatalogue.objects.create(
            name='discontinued', definition=_layout_def('discontinued'),
            is_deprecated=True,
        )
        with self.assertRaises(LayoutCatalogue.DoesNotExist):
            LayoutCatalogue.resolve_active('discontinued')

    def test_unknown_name_raises_does_not_exist(self):
        with self.assertRaises(LayoutCatalogue.DoesNotExist):
            LayoutCatalogue.resolve_active('never_existed')

    def test_cycle_guard_does_not_infinite_loop(self):
        """A self-referential or circular renamed_to chain must raise, not hang."""
        a = LayoutCatalogue.objects.create(name='a', definition=_layout_def('a'))
        b = LayoutCatalogue.objects.create(name='b', definition=_layout_def('b'), version=2)
        a.is_deprecated = True
        a.renamed_to = b
        a.save()
        b.is_deprecated = True
        b.renamed_to = a
        b.save()

        with self.assertRaises(LayoutCatalogue.DoesNotExist):
            LayoutCatalogue.resolve_active('a')

    def test_require_public_rejects_private_target(self):
        LayoutCatalogue.objects.create(
            name='internal_only', definition=_layout_def('internal_only'),
            is_public=False,
        )
        with self.assertRaises(LayoutCatalogue.DoesNotExist):
            LayoutCatalogue.resolve_active('internal_only', require_public=True)
        # Without require_public it still resolves (ops/internal callers).
        resolved = LayoutCatalogue.resolve_active('internal_only')
        self.assertEqual(resolved.name, 'internal_only')


class RenameEndpointRetiredTest(TestCase):
    """
    POST /api/ops/layouts/<name> no longer performs a rename (2026-09-16) —
    `name` is immutable once a row exists. `old_name`/`originalName` are
    still read, purely to reject a stale client with a clear message instead
    of a generic error. The historical alias mechanism (LayoutCatalogue.
    resolve_active(), renamed_to) is exercised separately in ResolveActiveTest
    since nothing can create a new alias through this endpoint any more.
    """

    def setUp(self):
        self.client = Client()
        self.api_key = APIKey.objects.create(
            name='ops-test-key', key='test-ops-key-12345', is_ops_team=True,
        )
        self.auth_headers = {'HTTP_AUTHORIZATION': f'Bearer {self.api_key.key}'}
        LayoutCatalogue.objects.create(
            name='classic_a4', definition=_layout_def('classic_a4'),
            display_name='Classic A4',
        )

    def test_old_name_differing_from_name_is_rejected(self):
        response = self.client.post(
            '/api/ops/layouts/classic_prints_4x6',
            data={
                'name': 'classic_prints_4x6',
                'old_name': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_prints_4x6')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn('immutable', response.json()['detail'])

        # Nothing was created or touched.
        self.assertFalse(LayoutCatalogue.objects.filter(name='classic_prints_4x6').exists())
        old = LayoutCatalogue.objects.get(name='classic_a4')
        self.assertFalse(old.is_deprecated)
        self.assertIsNone(old.renamed_to)

    def test_original_name_alias_of_old_name_is_also_rejected(self):
        response = self.client.post(
            '/api/ops/layouts/classic_prints_4x6',
            data={
                'name': 'classic_prints_4x6',
                'originalName': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_prints_4x6')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 400, response.content)

    def test_display_name_auto_derived_when_omitted_on_create(self):
        response = self.client.post(
            '/api/ops/layouts/retro_polaroid_4x6',
            data={
                'name': 'retro_polaroid_4x6',
                'layout_data': json.dumps(_layout_def('retro_polaroid_4x6')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)
        created = LayoutCatalogue.objects.get(name='retro_polaroid_4x6')
        self.assertEqual(created.display_name, 'Retro Polaroid 4x6')

    def test_display_name_used_when_provided_on_create(self):
        response = self.client.post(
            '/api/ops/layouts/retro_polaroid_4x6',
            data={
                'name': 'retro_polaroid_4x6',
                'display_name': 'Retro Polaroid Prints (4x6)',
                'layout_data': json.dumps(_layout_def('retro_polaroid_4x6')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)
        created = LayoutCatalogue.objects.get(name='retro_polaroid_4x6')
        self.assertEqual(created.display_name, 'Retro Polaroid Prints (4x6)')

    def test_display_name_preserved_on_update_when_omitted(self):
        """
        Updating an existing layout's definition without sending display_name
        (e.g. an old client build, or the calendar/book ops editors, which
        don't have a dedicated display-name field yet) must not silently
        blank out — or reset to an auto-derived value — an ops-curated name.
        """
        response = self.client.post(
            '/api/ops/layouts/classic_a4',
            data={
                'name': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_a4')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)
        updated = LayoutCatalogue.objects.get(name='classic_a4')
        self.assertEqual(updated.display_name, 'Classic A4')
        self.assertEqual(updated.version, 2)

    def test_display_name_can_be_edited_on_update(self):
        response = self.client.post(
            '/api/ops/layouts/classic_a4',
            data={
                'name': 'classic_a4',
                'display_name': 'Classic Prints (A4)',
                'layout_data': json.dumps(_layout_def('classic_a4')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)
        updated = LayoutCatalogue.objects.get(name='classic_a4')
        self.assertEqual(updated.display_name, 'Classic Prints (A4)')

    def test_resurrecting_a_deprecated_name_clears_stale_alias(self):
        """
        A deprecated, aliased row (the historical shape, built directly since
        the endpoint can no longer produce one) that gets a fresh create
        under the same name must not keep a dangling renamed_to pointer.
        """
        target = LayoutCatalogue.objects.create(
            name='classic_prints_4x6', definition=_layout_def('classic_prints_4x6'), version=2,
        )
        old = LayoutCatalogue.objects.get(name='classic_a4')
        old.is_deprecated = True
        old.renamed_to = target
        old.save()

        response = self.client.post(
            '/api/ops/layouts/classic_a4',
            data={
                'name': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_a4')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)

        resurrected = LayoutCatalogue.objects.get(name='classic_a4')
        self.assertFalse(resurrected.is_deprecated)
        self.assertIsNone(resurrected.renamed_to)


class LayoutNameImmutabilityTest(TestCase):
    """Model-level guard: LayoutCatalogue.name cannot change on an existing row."""

    def test_changing_name_on_existing_row_raises(self):
        layout = LayoutCatalogue.objects.create(
            name='classic_a4', definition=_layout_def('classic_a4'),
        )
        layout.name = 'classic_a4_v2'
        with self.assertRaises(ValueError):
            layout.save()

    def test_saving_without_changing_name_is_fine(self):
        layout = LayoutCatalogue.objects.create(
            name='classic_a4', definition=_layout_def('classic_a4'),
        )
        layout.display_name = 'Classic A4 Updated'
        layout.save()  # must not raise
        layout.refresh_from_db()
        self.assertEqual(layout.display_name, 'Classic A4 Updated')

    def test_creating_a_new_row_is_unaffected(self):
        layout = LayoutCatalogue.objects.create(
            name='brand_new', definition=_layout_def('brand_new'),
        )
        self.assertEqual(layout.name, 'brand_new')


class DefaultDisplayNameTest(TestCase):
    """default_display_name_for() must match the frontend's formatLayoutDisplayName() exactly."""

    def test_underscores_become_spaces_and_words_title_case(self):
        from api.models import default_display_name_for
        self.assertEqual(default_display_name_for('classic_a4'), 'Classic A4')

    def test_matches_the_hyphenated_dimension_example_from_the_incident(self):
        from api.models import default_display_name_for
        self.assertEqual(
            default_display_name_for('retro_polaroid_-_4.2x3.5_in'),
            'Retro Polaroid - 4.2x3.5 In',
        )

    def test_empty_name_does_not_crash(self):
        from api.models import default_display_name_for
        self.assertEqual(default_display_name_for(''), '')
        self.assertEqual(default_display_name_for(None), '')
