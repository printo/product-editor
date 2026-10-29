"""services/template_decoration.py — the pure template rules.

DB-free. Pins: a template never holds a customer file, coordinates are
percent of the canvas, ids are URL-safe slugs, the embed editor address
carries the template, sticker names are content fingerprints, and every read
adds the home layout's current geometry (`authoredOn`) so the editor can
centre the decoration on another layout's window box.
"""
from contextlib import contextmanager

from services.template_decoration import (
    AUTHORED_ON,
    InvalidTemplate,
    STICKER_URL_PREFIX,
    authored_on,
    editor_url,
    is_template_id,
    parse_template_flow,
    png_filename,
    sticker_url,
    validate_decoration,
    with_authored_on,
)


@contextmanager
def raises(exc_type):
    """The services/tests modules run standalone, without pytest."""
    try:
        yield
    except exc_type:
        return
    raise AssertionError(f"expected {exc_type.__name__}")


def _text(**over):
    o = {'type': 'text', 'x': 50, 'y': 10, 'text': 'Happy Birthday', 'fontSize': 72,
         'color': '#64318E', 'fontFamily': 'Lobster', 'textAlign': 'center', 'rotation': 0}
    o.update(over)
    return o


def _sticker(**over):
    o = {'type': 'image', 'source': 'clipart', 'src': STICKER_URL_PREFIX + 'sticker_abc.png',
         'x': 5, 'y': 80, 'width': 20, 'height': 15, 'rotation': 0, 'opacity': 1, 'label': 'balloon'}
    o.update(over)
    return o


def _deco(*overlays, key='default', **side):
    return {'surfaces': {key: {'overlays': list(overlays), **side}}}


def test_accepts_text_sticker_icon_and_colours():
    icon = {'type': 'image', 'source': 'icon', 'src': 'https://api.iconify.design/mdi/cake.svg',
            'x': 70, 'y': 70, 'width': 10, 'height': 10, 'rotation': 0, 'opacity': 1}
    out = validate_decoration(_deco(_text(), _sticker(), icon, bgColor='#ffeedd', paperColor='#ffffff'))
    side = out['surfaces']['default']
    assert len(side['overlays']) == 3
    assert side['bgColor'] == '#ffeedd' and side['paperColor'] == '#ffffff'


def test_keeps_every_side_of_a_multi_surface_product():
    out = validate_decoration({'surfaces': {
        'front': {'overlays': [_text()]},
        'back': {'overlays': [], 'bgColor': '#000000'},
    }})
    assert set(out['surfaces']) == {'front', 'back'}
    assert out['surfaces']['back']['overlays'] == []


def test_refuses_customer_uploads():
    with raises(InvalidTemplate):
        validate_decoration(_deco(_sticker(source='local')))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_sticker(fileId='0f3a-...')))


def test_refuses_an_image_without_a_safe_address():
    with raises(InvalidTemplate):
        validate_decoration(_deco(_sticker(src='http://example.com/x.png')))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_sticker(src='/storage/uploads/other-order/photo.jpg')))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_sticker(src='')))


def test_coordinates_are_percent_of_the_canvas():
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(x=120)))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_sticker(width=-1)))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(y='ten')))
    with raises(InvalidTemplate):
        validate_decoration(_deco({'type': 'text', 'text': 'no position'}))


def test_text_and_colour_rules():
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(text=None)))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(text='x' * 2001)))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(color='purple')))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(), bgColor='white'))
    with raises(InvalidTemplate):
        validate_decoration(_deco(_text(fontSize=0)))


def test_shape_and_structure_rules():
    out = validate_decoration(_deco({'type': 'shape', 'shapeType': 'rect', 'x': 0, 'y': 0,
                                     'width': 100, 'height': 10, 'fill': '#ff0000'}))
    assert out['surfaces']['default']['overlays'][0]['shapeType'] == 'rect'
    with raises(InvalidTemplate):
        validate_decoration(_deco({'type': 'video', 'x': 0, 'y': 0}))
    with raises(InvalidTemplate):
        validate_decoration({'surfaces': {}})
    with raises(InvalidTemplate):
        validate_decoration({'surfaces': {'bad key!': {'overlays': []}}})
    with raises(InvalidTemplate):
        validate_decoration(_deco(*[_text()] * 51))
    with raises(InvalidTemplate):
        validate_decoration([])


def test_template_ids_are_url_safe_slugs():
    assert is_template_id('retro-birthday')
    assert is_template_id('a')
    assert is_template_id('x' * 80)
    for bad in ('Retro', 'retro birthday', '-retro', 'retro-', 'x' * 81, '', None, 'retro_birthday', '../x'):
        assert not is_template_id(bad), bad


def test_editor_url_carries_the_template_on_the_address():
    tok = '3e1e0f6a-4c8a-4a8a-9d7c-0f7b1c2d3e4f'
    assert editor_url('retro_polaroid_4.2x3.5', tok) == f'/editor/layout/retro_polaroid_4.2x3.5?token={tok}'
    assert editor_url('classic_4x6', tok, 'retro-birthday') == f'/editor/layout/classic_4x6?token={tok}&template=retro-birthday'
    assert editor_url('classic_4x6', tok, template_flow=True) == f'/editor/layout/classic_4x6?token={tok}&template_flow=1'
    assert editor_url('classic_4x6', tok, 'retro-birthday', True).endswith('&template=retro-birthday&template_flow=1')
    # A layout name is URL-escaped, never inserted raw.
    assert '/editor/layout/a%2Fb?' in editor_url('a/b', tok)


def test_template_flow_parses_form_and_json_values():
    assert parse_template_flow(True) and parse_template_flow('true') and parse_template_flow('1')
    assert not parse_template_flow(False) and not parse_template_flow('') and not parse_template_flow(None)
    assert not parse_template_flow('0') and not parse_template_flow('false')


def test_every_read_carries_the_home_geometry_as_it_is_now():
    """The editor places shared artwork by its offset from the home window
    box's centre, so a read adds the home canvas and box per side, derived
    from the layout as it is now; nothing is stored and a client's own stamp
    never survives validation."""
    layout = {'canvas': {'width': 1524, 'height': 2032, 'widthMm': 152.4, 'heightMm': 203.2},
              'frames': [{'x': 0.1166666667, 'y': 0.0875, 'width': 0.7666666667, 'height': 0.825, 'bleedMm': 7.62}]}
    stored = validate_decoration({**_deco(_text()), AUTHORED_ON: {'layout': 'forged', 'surfaces': {}}})
    assert AUTHORED_ON not in stored
    out = with_authored_on(stored, layout, 'frame_1in')
    assert out['surfaces']['default']['overlays'][0]['text'] == 'Happy Birthday'
    assert out[AUTHORED_ON] == {'layout': 'frame_1in', 'surfaces': {'default': {
        'canvas': {'width': 1524, 'height': 2032, 'widthMm': 152.4, 'heightMm': 203.2},
        'windowBox': {'xMm': 17.78, 'yMm': 17.78, 'widthMm': 116.84, 'heightMm': 167.64},
    }}}
    assert AUTHORED_ON not in stored  # a copy, the stored row is untouched
    # Move the home layout's print areas and the next read says so.
    moved = {**layout, 'frames': [{**layout['frames'][0], 'x': 0.2}]}
    assert with_authored_on(stored, moved, 'frame_1in')[AUTHORED_ON]['surfaces']['default']['windowBox']['xMm'] == 30.48


def test_an_unreadable_decoration_still_reads():
    out = with_authored_on(None, {'canvas': {'widthMm': 10, 'heightMm': 10}, 'frames': []}, 'x')
    assert out[AUTHORED_ON]['layout'] == 'x' and 'surfaces' not in out


def test_the_stamp_covers_every_side_of_a_product():
    product = {'type': 'product', 'surfaces': [
        {'key': 'front', 'canvas': {'width': 1000, 'height': 1000, 'widthMm': 100, 'heightMm': 100},
         'frames': [{'x': 0.1, 'y': 0.1, 'width': 0.8, 'height': 0.8}]},
        {'key': 'back', 'canvas': {'width': 1000, 'height': 1000, 'widthMm': 100, 'heightMm': 100}, 'frames': []},
    ]}
    stamp = authored_on(product, 'card')
    assert set(stamp['surfaces']) == {'front', 'back'}
    assert stamp['surfaces']['front']['windowBox'] == {'xMm': 10, 'yMm': 10, 'widthMm': 80, 'heightMm': 80}
    assert stamp['surfaces']['back']['windowBox'] is None
    assert stamp['surfaces']['back']['canvas'] == {'width': 1000, 'height': 1000, 'widthMm': 100, 'heightMm': 100}
    # An unreadable layout stamps a zero geometry rather than failing the save.
    for broken in (None, {'canvas': 'nope'}):
        assert authored_on(broken, 'x') == {'layout': 'x', 'surfaces': {'default': {
            'canvas': {'width': 0, 'height': 0, 'widthMm': 0, 'heightMm': 0}, 'windowBox': None,
        }}}


def test_sticker_names_are_content_fingerprints():
    a = png_filename(b'png-bytes-1')
    assert a == png_filename(b'png-bytes-1')
    assert a != png_filename(b'png-bytes-2')
    assert a.startswith('sticker_') and a.endswith('.png') and len(a) == len('sticker_') + 16 + 4
    assert png_filename(b'x', 'thumb').startswith('thumb_')
    with raises(ValueError):
        png_filename(b'x', '../evil')
    assert sticker_url(a) == STICKER_URL_PREFIX + a


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} template-decoration tests passed.")
