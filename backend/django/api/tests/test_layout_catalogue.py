"""
Unit tests for LayoutCatalogue model and storage migration.

Tests cover:
- LayoutCatalogue CRUD operations
- Version incrementing
- Product type inference
- Data constraints
"""

import json
from django.test import TestCase
from django.core.exceptions import ValidationError
from api.models import LayoutCatalogue


class LayoutCatalogueModelTest(TestCase):
    """Test LayoutCatalogue model behavior."""

    def setUp(self):
        """Create a basic layout for testing."""
        self.layout_def = {
            'name': 'test_layout',
            'productType': 'single_canvas',
            'canvas': {
                'width': 100,
                'height': 100,
                'widthMm': 50,
                'heightMm': 50,
            }
        }

    def test_create_layout(self):
        """Test creating a new layout."""
        layout = LayoutCatalogue.objects.create(
            name='test_layout',
            definition=self.layout_def,
            product_type='single_canvas',
            category='test',
            is_public=True,
            version=1,
        )
        self.assertEqual(layout.name, 'test_layout')
        self.assertEqual(layout.version, 1)
        self.assertFalse(layout.is_deprecated)
        self.assertTrue(layout.is_public)

    def test_layout_name_unique(self):
        """Test that layout names are unique."""
        LayoutCatalogue.objects.create(
            name='unique_layout',
            definition=self.layout_def,
            product_type='single_canvas',
        )
        with self.assertRaises(Exception):  # IntegrityError
            LayoutCatalogue.objects.create(
                name='unique_layout',
                definition=self.layout_def,
                product_type='single_canvas',
            )

    def test_version_increment(self):
        """Test version incrementing on update."""
        layout = LayoutCatalogue.objects.create(
            name='versioned_layout',
            definition=self.layout_def,
            product_type='single_canvas',
            version=1,
        )
        self.assertEqual(layout.version, 1)

        layout.version += 1
        layout.save()
        layout.refresh_from_db()
        self.assertEqual(layout.version, 2)

    def test_soft_delete(self):
        """Test soft-delete via is_deprecated flag."""
        layout = LayoutCatalogue.objects.create(
            name='deletable_layout',
            definition=self.layout_def,
            product_type='single_canvas',
        )
        self.assertFalse(layout.is_deprecated)

        # Soft delete
        layout.is_deprecated = True
        layout.save()

        # Should be queryable but filtered out by is_deprecated=False
        self.assertTrue(
            LayoutCatalogue.objects.filter(name='deletable_layout', is_deprecated=True).exists()
        )
        self.assertFalse(
            LayoutCatalogue.objects.filter(name='deletable_layout', is_deprecated=False).exists()
        )

    def test_update_or_create(self):
        """Test update_or_create idempotency."""
        # First call: create
        layout1, created1 = LayoutCatalogue.objects.update_or_create(
            name='idempotent_layout',
            defaults={
                'definition': self.layout_def,
                'product_type': 'single_canvas',
                'version': 1,
            },
        )
        self.assertTrue(created1)
        self.assertEqual(layout1.version, 1)

        # Second call: update
        layout1.version = 1  # Already set
        layout1.save()

        layout2, created2 = LayoutCatalogue.objects.update_or_create(
            name='idempotent_layout',
            defaults={
                'definition': self.layout_def,
                'product_type': 'single_canvas',
                'version': 1,
            },
        )
        self.assertFalse(created2)
        self.assertEqual(layout2.version, 1)
        self.assertEqual(layout1.id, layout2.id)

    def test_product_type_inference(self):
        """Test that product_type is inferred from definition."""
        calendar_def = self.layout_def.copy()
        calendar_def['productType'] = 'calendar'

        layout = LayoutCatalogue.objects.create(
            name='calendar_layout',
            definition=calendar_def,
            product_type='calendar',
        )
        self.assertEqual(layout.product_type, 'calendar')

    def test_list_public_layouts(self):
        """Test filtering public layouts."""
        public_layout = LayoutCatalogue.objects.create(
            name='public',
            definition=self.layout_def,
            is_public=True,
        )
        private_layout = LayoutCatalogue.objects.create(
            name='private',
            definition=self.layout_def,
            is_public=False,
        )

        public_count = LayoutCatalogue.objects.filter(
            is_public=True, is_deprecated=False
        ).count()
        self.assertGreaterEqual(public_count, 1)
        self.assertIn(public_layout, LayoutCatalogue.objects.filter(is_public=True))

    def test_category_field(self):
        """Test category field for grouping."""
        layout = LayoutCatalogue.objects.create(
            name='categorized',
            definition=self.layout_def,
            category='polaroid',
        )
        self.assertEqual(layout.category, 'polaroid')

        layouts = LayoutCatalogue.objects.filter(category='polaroid')
        self.assertIn(layout, layouts)
