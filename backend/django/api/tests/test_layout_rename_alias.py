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


class RenameEndpointAliasTest(TestCase):
    """POST /api/ops/layouts/<name> (rename) must record the alias pointer."""

    def setUp(self):
        self.client = Client()
        self.api_key = APIKey.objects.create(
            name='ops-test-key', key='test-ops-key-12345', is_ops_team=True,
        )
        self.auth_headers = {'HTTP_AUTHORIZATION': f'Bearer {self.api_key.key}'}
        LayoutCatalogue.objects.create(
            name='classic_a4', definition=_layout_def('classic_a4'),
        )

    def test_rename_sets_renamed_to_on_old_row(self):
        response = self.client.post(
            '/api/ops/layouts/classic_prints_4x6',
            data={
                'name': 'classic_prints_4x6',
                'old_name': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_prints_4x6')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)

        old = LayoutCatalogue.objects.get(name='classic_a4')
        new = LayoutCatalogue.objects.get(name='classic_prints_4x6')
        self.assertTrue(old.is_deprecated)
        # renamed_to is keyed on `name` (LayoutCatalogue's natural identifier),
        # so the FK's raw column value is the target's name, not its numeric pk.
        self.assertEqual(old.renamed_to_id, new.name)
        self.assertEqual(old.renamed_to.pk, new.pk)

        # The whole point: the old name still resolves after the rename.
        resolved = LayoutCatalogue.resolve_active('classic_a4')
        self.assertEqual(resolved.name, 'classic_prints_4x6')

    def test_resurrecting_a_deprecated_name_clears_stale_alias(self):
        """
        Renaming A -> B, then later creating a brand-new layout under the
        name 'A' again (no old_name given) must not leave a dangling
        renamed_to pointer on the resurrected row.
        """
        self.client.post(
            '/api/ops/layouts/classic_prints_4x6',
            data={
                'name': 'classic_prints_4x6',
                'old_name': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_prints_4x6')),
            },
            **self.auth_headers,
        )
        # Re-create 'classic_a4' as an unrelated, fresh layout.
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

    def test_rename_onto_an_existing_deprecated_name_is_rejected_cleanly(self):
        """
        Renaming A -> B leaves 'A' as a deprecated alias-source row. Renaming
        some OTHER layout back onto the name 'A' would hit the `name` unique
        constraint inside .create() — it must come back as a clean 400, not
        a raw IntegrityError/500.
        """
        self.client.post(
            '/api/ops/layouts/classic_prints_4x6',
            data={
                'name': 'classic_prints_4x6',
                'old_name': 'classic_a4',
                'layout_data': json.dumps(_layout_def('classic_prints_4x6')),
            },
            **self.auth_headers,
        )
        LayoutCatalogue.objects.create(
            name='unrelated_layout', definition=_layout_def('unrelated_layout'),
        )

        response = self.client.post(
            '/api/ops/layouts/classic_a4',
            data={
                'name': 'classic_a4',
                'old_name': 'unrelated_layout',
                'layout_data': json.dumps(_layout_def('classic_a4')),
            },
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn('already exists', response.json()['detail'])

        # Neither row was corrupted by the failed attempt.
        self.assertTrue(LayoutCatalogue.objects.filter(name='unrelated_layout', is_deprecated=False).exists())
        self.assertTrue(LayoutCatalogue.objects.filter(name='classic_a4', is_deprecated=True).exists())
