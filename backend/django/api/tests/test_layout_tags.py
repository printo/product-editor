"""Layout tags against Postgres: the seeded list, ops create / rename /
switch-off, what a layout save stores, the names and `?tag=` filter on the
layout reads, and the 0024 migration's conversion of old `tags` names.

Run with: docker-compose exec backend python manage.py test api.tests.test_layout_tags
"""
import importlib

from django.apps import apps as django_apps
from django.core.cache import cache
from django.test import TestCase

from api.models import APIKey, LayoutCatalogue, LayoutTag

LAYOUT = {
    'productType': 'single_canvas', 'type': 'single',
    'canvas': {'width': 1800, 'height': 1200, 'widthMm': 152.4, 'heightMm': 101.6, 'dpi': 300},
    'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.8, 'height': 0.8}],
}

SEEDED = ['photo_prints', 'canvas_prints', 'magnets', 'coasters', 'mugs', 'stationery', 'gifts', 'calendar', 'photobook']


class _Base(TestCase):
    def setUp(self):
        cache.clear()
        self.ops = APIKey.objects.create(name='tag-ops', key='tag-ops-key', is_ops_team=True)
        self.partner = APIKey.objects.create(name='tag-partner', key='tag-partner-key', is_ops_team=False)
        self.ops_auth = {'HTTP_AUTHORIZATION': f'Bearer {self.ops.key}'}
        self.partner_auth = {'HTTP_AUTHORIZATION': f'Bearer {self.partner.key}'}

    def save_layout(self, name, **extra):
        return self.client.post(
            '/api/ops/layouts', {'name': name, 'layout_data': {**LAYOUT, **extra}},
            content_type='application/json', **self.ops_auth,
        )

    def stored(self, name):
        return LayoutCatalogue.objects.get(name=name).definition


class SeedTest(_Base):
    def test_migration_seeds_the_nine_former_hard_coded_tags(self):
        self.assertEqual(sorted(LayoutTag.objects.values_list('key', flat=True)), sorted(SEEDED))
        self.assertEqual(LayoutTag.objects.get(key='photo_prints').name, 'Photo Prints')

    def test_key_is_immutable(self):
        tag = LayoutTag.objects.get(key='mugs')
        tag.key = 'cups'
        with self.assertRaises(ValueError):
            tag.save()


class ManagementTest(_Base):
    def test_ops_create_rename_and_switch_off(self):
        res = self.client.post('/api/ops/layout-tags', {'key': 'wedding', 'name': 'Wedding'},
                               content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json(), {'key': 'wedding', 'name': 'Wedding', 'isActive': True, 'layoutCount': 0})

        res = self.client.patch('/api/ops/layout-tags/wedding', {'name': 'Weddings & Events'},
                                content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()['name'], 'Weddings & Events')

        res = self.client.patch('/api/ops/layout-tags/wedding', {'isActive': False},
                                content_type='application/json', **self.ops_auth)
        self.assertFalse(res.json()['isActive'])
        self.assertFalse(LayoutTag.objects.get(key='wedding').is_active)

    def test_bad_or_duplicate_tags_are_refused(self):
        post = lambda body: self.client.post('/api/ops/layout-tags', body, content_type='application/json', **self.ops_auth)
        self.assertEqual(post({'key': 'Wedding Day', 'name': 'Wedding'}).status_code, 400)
        self.assertEqual(post({'key': 'wedding', 'name': ''}).status_code, 400)
        self.assertEqual(post({'key': 'mugs', 'name': 'Mugs Again'}).status_code, 400)
        self.assertEqual(post({'key': 'mugs_two', 'name': 'MUGS'}).status_code, 400)
        res = self.client.patch('/api/ops/layout-tags/gifts', {'name': 'mugs'},
                                content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 400)
        res = self.client.patch('/api/ops/layout-tags/gifts', {'isActive': 'no'},
                                content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 400)
        res = self.client.patch('/api/ops/layout-tags/nope', {'name': 'x'},
                                content_type='application/json', **self.ops_auth)
        self.assertEqual(res.status_code, 404)

    def test_no_delete_and_no_partner_writes(self):
        self.assertEqual(self.client.delete('/api/ops/layout-tags/mugs', **self.ops_auth).status_code, 405)
        res = self.client.post('/api/ops/layout-tags', {'key': 'x', 'name': 'X'},
                               content_type='application/json', **self.partner_auth)
        self.assertEqual(res.status_code, 403)

    def test_anyone_with_a_key_can_read_the_list_with_counts(self):
        # Migration 0017 imports the production layouts, some already tagged,
        # so count relative to what is there before.
        counts = lambda: {t['key']: t['layoutCount'] for t in
                          self.client.get('/api/layout-tags', **self.partner_auth).json()['tags']}
        before = counts()
        self.save_layout('tag_a', tagKeys=['mugs', 'gifts'])
        self.save_layout('tag_b', tagKeys=['mugs'])
        res = self.client.get('/api/layout-tags', **self.partner_auth)
        self.assertEqual(res.status_code, 200)
        after = counts()
        self.assertEqual(after['mugs'] - before['mugs'], 2)
        self.assertEqual(after['gifts'] - before['gifts'], 1)
        self.assertEqual(after['coasters'], before['coasters'])


class LayoutSaveTest(_Base):
    def test_save_stores_keys_only_and_answers_with_names(self):
        res = self.save_layout('tag_save', tagKeys=['mugs', 'gifts', 'mugs'])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()['layout']['tags'], ['Mugs', 'Gifts'])
        stored = self.stored('tag_save')
        self.assertEqual(stored['tagKeys'], ['mugs', 'gifts'])
        self.assertNotIn('tags', stored)

    def test_legacy_names_are_mapped_to_keys(self):
        self.assertEqual(self.save_layout('tag_legacy', tags=['photo prints']).status_code, 200)
        self.assertEqual(self.stored('tag_legacy')['tagKeys'], ['photo_prints'])

    def test_a_save_without_tags_keeps_them(self):
        self.save_layout('tag_keep', tagKeys=['calendar'])
        self.assertEqual(self.save_layout('tag_keep').status_code, 200)
        self.assertEqual(self.stored('tag_keep')['tagKeys'], ['calendar'])
        self.save_layout('tag_keep', tagKeys=[])
        self.assertEqual(self.stored('tag_keep')['tagKeys'], [])

    def test_unknown_and_switched_off_tags(self):
        self.assertEqual(self.save_layout('tag_bad', tagKeys=['nope']).status_code, 400)
        self.assertEqual(self.save_layout('tag_bad', tags=['Nope']).status_code, 400)
        self.save_layout('tag_off', tagKeys=['mugs'])
        LayoutTag.objects.filter(key='mugs').update(is_active=False)
        # Kept where it already was ...
        self.assertEqual(self.save_layout('tag_off', tagKeys=['mugs', 'gifts']).status_code, 200)
        # ... but not added anywhere new.
        self.assertEqual(self.save_layout('tag_other', tagKeys=['mugs']).status_code, 400)


class LayoutReadTest(_Base):
    def test_reads_carry_current_names_and_filter_by_key(self):
        self.save_layout('tag_r1', tagKeys=['mugs'])
        self.save_layout('tag_r2', tagKeys=['gifts', 'mugs'])
        self.save_layout('tag_r3')
        # Warm the caches, then rename: the next reads must show the new name.
        self.client.get('/api/layouts', **self.partner_auth)
        self.client.get('/api/layouts/tag_r2', **self.partner_auth)
        LayoutTag.objects.filter(key='mugs').update(name='Mugs & Cups')

        rows = {d['name']: d for d in self.client.get('/api/layouts?fields=summary', **self.partner_auth).json()['layouts']}
        self.assertEqual(rows['tag_r2']['tagKeys'], ['gifts', 'mugs'])
        self.assertEqual(rows['tag_r2']['tags'], ['Gifts', 'Mugs & Cups'])
        self.assertEqual(rows['tag_r3']['tags'], [])

        detail = self.client.get('/api/layouts/tag_r2', **self.partner_auth).json()
        self.assertEqual(detail['tags'], ['Gifts', 'Mugs & Cups'])
        external = self.client.get('/api/external/layouts/tag_r2', **self.partner_auth).json()
        self.assertEqual(external['tagKeys'], ['gifts', 'mugs'])
        ops = self.client.get('/api/ops/layouts/tag_r2', **self.ops_auth).json()
        self.assertEqual(ops['tags'], ['Gifts', 'Mugs & Cups'])

        names = [d['name'] for d in self.client.get('/api/layouts?tag=mugs', **self.partner_auth).json()['layouts']]
        self.assertEqual(sorted(names), ['tag_r1', 'tag_r2'])
        self.assertEqual(self.client.get('/api/layouts?tag=nope', **self.partner_auth).json()['layouts'], [])


class MigrationConversionTest(_Base):
    """0024's forwards/backwards, run against the live models."""

    def setUp(self):
        super().setUp()
        self.mod = importlib.import_module('api.migrations.0024_layouttag')

    def test_names_become_keys_and_unknown_names_become_tags(self):
        LayoutCatalogue.objects.create(name='mig_a', definition={**LAYOUT, 'tags': ['Photo Prints', 'Wedding Albums', '']})
        LayoutCatalogue.objects.create(name='mig_b', definition={**LAYOUT})
        LayoutCatalogue.objects.create(name='mig_c', definition={**LAYOUT, 'tagKeys': ['mugs']})
        version_before = LayoutCatalogue.objects.get(name='mig_a').version

        self.mod.forwards(django_apps, None)

        a = LayoutCatalogue.objects.get(name='mig_a')
        self.assertEqual(a.definition['tagKeys'], ['photo_prints', 'wedding_albums'])
        self.assertNotIn('tags', a.definition)
        self.assertEqual(a.version, version_before)
        self.assertEqual(LayoutTag.objects.get(key='wedding_albums').name, 'Wedding Albums')
        self.assertEqual(LayoutCatalogue.objects.get(name='mig_b').definition['tagKeys'], [])
        self.assertEqual(LayoutCatalogue.objects.get(name='mig_c').definition['tagKeys'], ['mugs'])

        self.mod.backwards(django_apps, None)
        a = LayoutCatalogue.objects.get(name='mig_a')
        self.assertEqual(a.definition['tags'], ['Photo Prints', 'Wedding Albums'])
        self.assertNotIn('tagKeys', a.definition)
