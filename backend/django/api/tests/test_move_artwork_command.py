"""manage.py move_artwork_to_frame: what sat in a generic layout's artwork slot becomes its frame picture."""
import io
import json
import os
import tempfile

from django.core.management import call_command
from django.test import TestCase, override_settings

from api.models import LayoutCatalogue

CANVAS = {'width': 100, 'height': 100, 'widthMm': 10, 'heightMm': 10, 'dpi': 254}


def make(name, **definition):
    return LayoutCatalogue.objects.create(name=name, definition={'name': name, 'canvas': CANVAS, 'frames': [], **definition})


class MoveArtworkCommandTest(TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        override = override_settings(STORAGE_ROOT=self.dir.name)
        override.enable()
        self.addCleanup(override.disable)

    def run_it(self, *args):
        out = io.StringIO()
        call_command('move_artwork_to_frame', *args, stdout=out)
        return out.getvalue()

    def read(self, name):
        return LayoutCatalogue.objects.get(name=name).definition

    def test_without_apply_it_lists_and_changes_nothing(self):
        make('frame', maskUrl='/m/b.png', maskOnExport=True)
        out = self.run_it()
        self.assertIn('Would move 1 layout(s)', out)
        self.assertIn('frame: /m/b.png', out)
        self.assertIn('Nothing changed', out)
        self.assertEqual(self.read('frame')['maskUrl'], '/m/b.png')
        self.assertEqual(os.listdir(self.dir.name), [])

    def test_apply_moves_saves_the_old_values_and_touches_nothing_else(self):
        row = make('frame', maskUrl='/m/b.png', maskOnExport=True)
        make('sleeve', type='product', surfaces=[{'key': 'front', 'artworkMaskUrl': '/m/f.png'}, {'key': 'back', 'frameMaskUrl': '/m/k.png'}])
        make('cal', productType='calendar', maskUrl='/m/c.png', maskOnExport=True)
        make('book', productType='book', book={'cover': {'maskUrl': '/m/k.png', 'maskOnExport': True}})
        make('frame_only', frameMaskUrl='/m/o.png', artworkMaskUrl=None)
        make('preview_only', maskUrl='/m/p.png', maskOnExport=False)
        version, updated = row.version, row.updated_at

        self.assertIn('Done: 2 layout(s) changed', self.run_it('--apply'))

        frame = self.read('frame')
        self.assertEqual(frame['frameMaskUrl'], '/m/b.png')
        self.assertNotIn('maskUrl', frame)
        self.assertNotIn('maskOnExport', frame)
        front, back = self.read('sleeve')['surfaces']
        self.assertEqual(front['frameMaskUrl'], '/m/f.png')
        self.assertNotIn('artworkMaskUrl', front)
        self.assertEqual(back, {'key': 'back', 'frameMaskUrl': '/m/k.png'})
        self.assertEqual(self.read('cal')['maskOnExport'], True)
        self.assertEqual(self.read('book')['book']['cover']['maskOnExport'], True)
        self.assertEqual(self.read('frame_only')['frameMaskUrl'], '/m/o.png')
        self.assertEqual(self.read('preview_only')['maskUrl'], '/m/p.png')
        row.refresh_from_db()
        self.assertEqual((row.version, row.updated_at), (version, updated))

        files = os.listdir(self.dir.name)
        self.assertEqual(len(files), 1)
        with open(os.path.join(self.dir.name, files[0]), encoding='utf-8') as f:
            saved = json.load(f)
        self.assertEqual(set(saved), {'frame', 'sleeve'})
        self.assertEqual(saved['frame']['maskUrl'], '/m/b.png')

    def test_a_layout_with_both_keeps_its_frame_picture_and_says_so(self):
        make('both', frameMaskUrl='/m/f.png', artworkMaskUrl='/m/a.png')
        self.assertIn('dropped, keeps frame picture /m/f.png', self.run_it('--apply'))
        both = self.read('both')
        self.assertEqual(both['frameMaskUrl'], '/m/f.png')
        self.assertNotIn('artworkMaskUrl', both)

    def test_running_twice_changes_nothing_more(self):
        make('twice', artworkMaskUrl='/m/a.png')
        self.run_it('--apply')
        first = self.read('twice')
        self.assertIn('nothing to move', self.run_it('--apply'))
        self.assertEqual(self.read('twice'), first)
