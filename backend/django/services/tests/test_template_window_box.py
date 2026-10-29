"""services/print_sheet.py — the window box a layout template is keyed on.

DB-free, Django-free. Pins, against the ground truth in
storage/parity-fixtures/template-window-box.json that the TypeScript twin
(frontend/nextjs/src/lib/__tests__/print-sheet.test.ts) also asserts on:

- the box is the one around the stored windows, bleed included, clamped to
  the canvas (the bleed area when there is a bleed, the print area when not);
- the print-area box is the same with each window inset by its own bleed;
- a key is the box's size rounded to the millimetre (JavaScript rounding);
- no windows, or a canvas without millimetres, gives no box and no key.

Run: python -m services.tests.test_template_window_box
"""
import json
import os

from services.print_sheet import (
    box_key, box_orientation, print_area_box_mm, surface_blocks, template_size, window_box_mm,
)


def _fixture_path() -> str:
    candidates = [
        os.path.join(os.environ.get('STORAGE_ROOT') or '', 'parity-fixtures', 'template-window-box.json'),
        os.path.join('/app', 'storage', 'parity-fixtures', 'template-window-box.json'),
        os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'storage', 'parity-fixtures', 'template-window-box.json'),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return os.path.abspath(path)
    raise FileNotFoundError(
        "Parity fixture template-window-box.json missing; both this test and "
        "src/lib/__tests__/print-sheet.test.ts load it from storage/parity-fixtures/."
    )


def _cases() -> list:
    with open(_fixture_path(), encoding='utf-8') as f:
        return json.load(f)['cases']


def test_window_box_matches_the_fixture():
    for case in _cases():
        block = {'canvas': case['canvas'], 'frames': case['frames']}
        assert window_box_mm(block) == case['windowBox'], case['name']
        assert box_key(window_box_mm(block)) == case['windowKey'], case['name']


def test_print_area_box_matches_the_fixture():
    for case in _cases():
        block = {'canvas': case['canvas'], 'frames': case['frames']}
        assert print_area_box_mm(block) == case['printAreaBox'], case['name']
        assert box_key(print_area_box_mm(block)) == case['printAreaKey'], case['name']


def test_two_frame_pictures_around_one_window_share_a_key():
    """The case the feature exists for: a 1-inch and a half-inch frame picture
    around the same 4x6 window with the same bleed are one size."""
    by_name = {c['name']: c for c in _cases()}
    one_inch = by_name['4x6 window with 0.3 in bleed inside a 1 in frame picture']
    half_inch = by_name['the same window with 0.3 in bleed inside a half-inch frame picture']
    plain = by_name['classic 4x6 print: one full-canvas window, no bleed']
    key = lambda c: box_key(window_box_mm({'canvas': c['canvas'], 'frames': c['frames']}))
    assert key(one_inch) == key(half_inch) == '117x168'
    # The plain print has no bleed, so its box is the window alone: a different size.
    assert key(plain) == '102x152'
    # Their print areas agree: the ops page shows the plain print as a near-miss.
    area = lambda c: box_key(print_area_box_mm({'canvas': c['canvas'], 'frames': c['frames']}))
    assert area(one_inch) == area(plain) == '102x152'


def test_key_rounds_half_up_like_javascript():
    assert box_key({'widthMm': 100.5, 'heightMm': 99.4999}) == '101x99'
    assert box_key({'widthMm': 0.5, 'heightMm': 1.5}) == '1x2'
    assert box_key(None) is None
    assert box_key({}) is None


def test_template_size_reads_the_first_surface_and_names_the_sides():
    single = {'canvas': {'widthMm': 100, 'heightMm': 100}, 'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': 0.5, 'bleedMm': 2}]}
    size = template_size(single)
    assert size['windowKey'] == '50x50' and size['bleedMm'] == 2 and size['surfaceKeys'] == ['default']
    product = {'type': 'product', 'surfaces': [
        {'key': 'front', **single},
        {'key': 'back', 'canvas': {'widthMm': 100, 'heightMm': 100}, 'frames': [{'x': 0, 'y': 0, 'width': 1, 'height': 1}]},
    ]}
    assert template_size(product)['windowKey'] == '50x50'
    assert template_size(product)['surfaceKeys'] == ['front', 'back']
    assert [k for k, _ in surface_blocks(product)] == ['front', 'back']
    assert [k for k, _ in surface_blocks(single)] == ['default']
    assert template_size({})['windowBox'] is None and template_size({})['windowKey'] is None
    assert template_size({})['bleedMm'] == 0 and template_size({})['surfaceKeys'] == ['default']
    assert template_size(None)['windowKey'] is None and template_size(None)['surfaceKeys'] == []  # type: ignore[arg-type]


def test_boxes_round_half_up_like_the_twin():
    """8.125 is exact in binary: Python's half-even `round` would give 8.12,
    JavaScript's Math.round gives 8.13; the fixture pins both sides to 8.13."""
    block = {'canvas': {'widthMm': 8.125, 'heightMm': 8.125}, 'frames': [{'x': 0, 'y': 0, 'width': 1, 'height': 1}]}
    assert window_box_mm(block) == {'xMm': 0, 'yMm': 0, 'widthMm': 8.13, 'heightMm': 8.13}


def test_box_orientation_is_which_way_the_print_areas_face():
    """A template is offered only where the customer's print areas face the
    way the template's did; a square box, or none, faces either way."""
    assert box_orientation({'xMm': 0, 'yMm': 0, 'widthMm': 101.6, 'heightMm': 152.4}) == 'portrait'
    assert box_orientation({'xMm': 0, 'yMm': 0, 'widthMm': 152.4, 'heightMm': 101.6}) == 'landscape'
    assert box_orientation({'xMm': 5, 'yMm': 5, 'widthMm': 100, 'heightMm': 100}) == 'square'
    assert box_orientation(None) is None
    assert box_orientation({'widthMm': 0, 'heightMm': 10}) is None
    assert box_orientation({'widthMm': 'x', 'heightMm': 10}) is None


def test_unreadable_numbers_count_as_zero():
    block = {'canvas': {'widthMm': '100', 'heightMm': 100}, 'frames': [
        {'x': 'left', 'y': 0, 'width': 0.5, 'height': 0.5, 'bleedMm': 'none'},
        'not a frame',
    ]}
    assert window_box_mm(block) == {'xMm': 0, 'yMm': 0, 'widthMm': 50, 'heightMm': 50}


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} template-window-box tests passed.")
