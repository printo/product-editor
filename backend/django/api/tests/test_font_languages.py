"""The language labels in the font picker, as the API serves them. A label must
never cost the editor: a font that can't be read is simply left unlabelled."""
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase

from api.views.calendar_assets import read_font_languages
from services.google_fonts import FontUnavailable

LANGUAGES = {'Poppins': ['Hindi'], 'Hind Madurai': ['Tamil'], 'Lobster': []}


def _fake(family, weight=400):
    if family == 'Broken':
        raise FontUnavailable('no file')
    return LANGUAGES[family]


class ReadFontLanguagesTest(SimpleTestCase):
    def setUp(self):
        cache.delete_many([f'font-languages:{k}' for k in ('poppins', 'hind_madurai', 'lobster', 'broken')])

    def test_lists_only_fonts_with_a_language_and_reads_each_file_once(self):
        with mock.patch('services.text_coverage.shaping_available', return_value=True), \
                mock.patch('services.text_coverage.font_languages', side_effect=_fake) as read:
            fonts = ['Poppins', 'Hind Madurai', 'Lobster']
            expected = {'Poppins': ['Hindi'], 'Hind Madurai': ['Tamil']}
            self.assertEqual(read_font_languages(fonts), expected)
            self.assertEqual(read.call_count, 3)
            self.assertEqual(read_font_languages(fonts), expected)
            self.assertEqual(read.call_count, 3)

    def test_an_unreadable_font_is_left_unlabelled(self):
        with mock.patch('services.text_coverage.shaping_available', return_value=True), \
                mock.patch('services.text_coverage.font_languages', side_effect=_fake):
            self.assertEqual(read_font_languages(['Broken', 'Poppins']), {'Poppins': ['Hindi']})

    def test_nothing_is_offered_or_cached_while_the_print_cannot_shape(self):
        with mock.patch('services.text_coverage.shaping_available', return_value=False):
            self.assertEqual(read_font_languages(['Poppins']), {})
        self.assertIsNone(cache.get('font-languages:poppins'))

    def test_a_failure_never_reaches_the_editor(self):
        with mock.patch('services.text_coverage.shaping_available', side_effect=RuntimeError('boom')):
            self.assertEqual(read_font_languages(['Poppins']), {})
