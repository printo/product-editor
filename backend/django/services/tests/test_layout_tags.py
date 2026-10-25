"""Layout tags, pure rules: key/name checks, what a layout save stores, and
the names filled in on the way out. DB-free; the API side is
api/tests/test_layout_tags.py.

Run: python -m services.tests.test_layout_tags
"""
from services.layout_tags import (
    InvalidTag,
    MAX_TAGS_PER_LAYOUT,
    clean_tag_key,
    clean_tag_keys,
    clean_tag_name,
    is_tag_key,
    key_for_name,
    resolve_layout_tag_keys,
    with_tag_names,
)

KNOWN = {'photo_prints': True, 'wedding': True, 'old_promo': False}
KEY_BY_NAME = {'photo prints': 'photo_prints', 'wedding': 'wedding', 'old promo': 'old_promo'}
NAMES = {'photo_prints': 'Photo Prints', 'wedding': 'Wedding', 'old_promo': 'Old Promo'}


def _raises(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except InvalidTag as exc:
        return str(exc)
    raise AssertionError(f"{fn.__name__} did not raise")


def _resolve(body, existing=None):
    return resolve_layout_tag_keys(body, existing_keys=existing, known=KNOWN, key_by_name=KEY_BY_NAME)


def test_keys_are_lowercase_words_joined_by_single_underscores():
    for ok in ('photo_prints', 'a', 'x2', 'year_2026'):
        assert is_tag_key(ok), ok
    for bad in ('', 'Photo', 'photo prints', 'photo__prints', '_x', 'x_', 'a-b', 'a' * 51, None, 5):
        assert not is_tag_key(bad), bad
    assert clean_tag_key(' wedding ') == 'wedding'
    _raises(clean_tag_key, 'Wedding')


def test_key_suggested_from_a_name():
    assert key_for_name('Photo Prints') == 'photo_prints'
    assert key_for_name('  Mugs & Cups 11oz ') == 'mugs_cups_11oz'
    assert key_for_name('!!!') == ''


def test_names_are_trimmed_and_bounded():
    assert clean_tag_name('  Wedding   Albums ') == 'Wedding Albums'
    _raises(clean_tag_name, '   ')
    _raises(clean_tag_name, 'x' * 61)


def test_tag_keys_list_is_deduplicated_in_order_and_capped():
    assert clean_tag_keys(['wedding', 'photo_prints', 'wedding']) == ['wedding', 'photo_prints']
    assert clean_tag_keys(None) == []
    _raises(clean_tag_keys, 'wedding')
    _raises(clean_tag_keys, [f'k{i}' for i in range(MAX_TAGS_PER_LAYOUT + 1)])


def test_save_prefers_tag_keys_then_names_then_keeps_what_it_had():
    assert _resolve({'tagKeys': ['wedding'], 'tags': ['Photo Prints']}) == ['wedding']
    assert _resolve({'tags': ['photo prints', 'WEDDING']}) == ['photo_prints', 'wedding']
    assert _resolve({}, existing=['wedding']) == ['wedding']
    assert _resolve({}, existing=None) == []
    assert _resolve({'tagKeys': []}, existing=['wedding']) == []


def test_unknown_tags_are_refused():
    assert 'nope' in _raises(_resolve, {'tagKeys': ['nope']})
    assert 'Birthday' in _raises(_resolve, {'tags': ['Birthday']})


def test_switched_off_tag_stays_but_cannot_be_added():
    assert _resolve({'tagKeys': ['old_promo', 'wedding']}, existing=['old_promo']) == ['old_promo', 'wedding']
    assert 'switched off' in _raises(_resolve, {'tagKeys': ['old_promo']}, existing=['wedding'])


def test_responses_carry_keys_and_current_names():
    out = with_tag_names({'name': 'x', 'tagKeys': ['wedding', 'photo_prints']}, NAMES)
    assert out['tagKeys'] == ['wedding', 'photo_prints']
    assert out['tags'] == ['Wedding', 'Photo Prints']
    # A key whose tag row is gone shows as the key rather than vanishing.
    assert with_tag_names({'tagKeys': ['ghost']}, NAMES)['tags'] == ['ghost']
    assert with_tag_names({}, NAMES) == {'tags': [], 'tagKeys': []}


def test_a_definition_saved_before_keys_still_reads():
    out = with_tag_names({'tags': ['Photo Prints', 'Something Else']}, NAMES)
    assert out['tags'] == ['Photo Prints', 'Something Else']
    assert out['tagKeys'] == ['photo_prints']


def test_input_is_not_mutated():
    src = {'tagKeys': ['wedding']}
    with_tag_names(src, NAMES)
    assert src == {'tagKeys': ['wedding']}


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    raise SystemExit(1 if failures else 0)
