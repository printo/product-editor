"""
restore.json: what the uploads ZIP carries so an embedding company can bring a
design back after our retention has passed (services/restore_manifest.py).

DB-free. The view and task halves are in api/tests/test_restore_manifest_api.py.
"""
import json

from services.restore_manifest import (
    MAX_EDITOR_STATE_BYTES, SCHEMA_VERSION,
    build_restore_manifest, content_type_for, normalise_restore_payload,
    referenced_uploads, safe_entry_name, zip_entry_name,
)

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
C = '33333333-3333-4333-8333-333333333333'
D = '44444444-4444-4444-8444-444444444444'
ICON = '55555555-5555-4555-8555-555555555555'


def _canvases():
    return [
        {'canvas_index': 0, 'frames': [{'upload_id': A}, {'upload_id': B}],
         'overlays': [
             {'type': 'image', 'source': 'local', 'fileId': C},
             {'type': 'image', 'source': 'icon', 'fileId': ICON},
             {'type': 'text', 'text': 'Happy birthday'},
         ],
         'calendar': {'cells': {'2026-01-14': [{'type': 'image', 'uploadId': D}, {'type': 'text', 'text': 'x'}]}}},
        # The same photo again in a second card, and an empty frame.
        {'canvas_index': 1, 'frames': [{'upload_id': A}, {'upload_id': None}], 'overlays': []},
    ]


def _uploads():
    return {
        A: {'original_name': 'IMG_0001.jpg', 'size_bytes': 100, 'width': 4000, 'height': 3000},
        B: {'original_name': 'IMG_0001.jpg', 'size_bytes': 200, 'width': 3000, 'height': 4000},
        C: {'original_name': 'sticker.png', 'size_bytes': 300, 'width': 500, 'height': 500},
        D: {'original_name': 'birthday.webp', 'size_bytes': 400, 'width': 800, 'height': 600},
        ICON: {'original_name': 'icon.png', 'size_bytes': 50, 'width': 64, 'height': 64},
    }


def _manifest(restore=None, uploads=None, canvases=None):
    return build_restore_manifest(
        order_id='576621', render_job_id='job-1', layout_name='classic_4x6', layout_version=7,
        created_at='2026-11-05T10:15:00+05:30',
        render_state={'canvases': _canvases() if canvases is None else canvases, 'restore': restore},
        uploads=_uploads() if uploads is None else uploads,
    )


def test_each_distinct_photo_is_listed_once_in_a_stable_order():
    assert referenced_uploads(_canvases()) == [
        (A, 'frame'), (B, 'frame'), (C, 'overlay'), (D, 'calendar'),
    ]


def test_an_icon_or_sticker_raster_is_not_a_customer_photo():
    assert ICON not in [uid for uid, _ in referenced_uploads(_canvases())]


def test_nothing_to_list_reads_as_nothing():
    assert referenced_uploads(None) == []
    assert referenced_uploads([{'frames': [{'upload_id': None}]}, 'junk', {'frames': 'junk'}]) == []
    assert _manifest(canvases=[{'frames': [{'upload_id': None}]}]) is None


def test_two_photos_with_one_name_get_distinct_entries():
    photos = _manifest()['photos']
    assert [p['zip_entry'] for p in photos] == [
        '001_IMG_0001.jpg', '002_IMG_0001.jpg', '003_sticker.png', '004_birthday.webp',
    ]
    assert len({p['zip_entry'] for p in photos}) == len(photos)
    assert [p['original_name'] for p in photos[:2]] == ['IMG_0001.jpg', 'IMG_0001.jpg']


def test_the_manifest_carries_what_a_later_restore_cannot_recover():
    m = _manifest(restore={'editor_state': {'surfaces': [{'key': 'default'}]}, 'file_ids': {A: 'file-a', C: 'file-c'}})
    assert m['schema_version'] == SCHEMA_VERSION == 1
    assert (m['order_id'], m['render_job_id'], m['layout_name'], m['layout_version']) == ('576621', 'job-1', 'classic_4x6', 7)
    assert m['created_at'] == '2026-11-05T10:15:00+05:30'
    assert m['editor_state'] == {'surfaces': [{'key': 'default'}]}
    first = m['photos'][0]
    assert first == {
        'file_id': 'file-a', 'upload_id': A, 'kind': 'frame', 'zip_entry': '001_IMG_0001.jpg',
        'original_name': 'IMG_0001.jpg', 'size_bytes': 100, 'content_type': 'image/jpeg',
        'width': 4000, 'height': 3000,
    }
    by_upload = {p['upload_id']: p for p in m['photos']}
    assert by_upload[B]['file_id'] is None          # the editor sent no id for it
    assert by_upload[C]['file_id'] == 'file-c' and by_upload[C]['kind'] == 'overlay'
    assert by_upload[D]['kind'] == 'calendar' and by_upload[D]['content_type'] == 'image/webp'
    assert by_upload[D]['file_id'] == D             # the design names a date photo by its upload id
    json.dumps(m)                                   # it is plain JSON


def test_an_old_editor_build_still_gets_a_photo_list():
    m = _manifest(restore=None)
    assert m['editor_state'] is None
    assert [p['file_id'] for p in m['photos']] == [None, None, None, D]
    assert len(m['photos']) == 4


def test_a_photo_we_no_longer_hold_is_left_out_and_numbering_stays_dense():
    uploads = _uploads()
    del uploads[B]
    photos = _manifest(uploads=uploads)['photos']
    assert [p['upload_id'] for p in photos] == [A, C, D]
    assert [p['zip_entry'][:3] for p in photos] == ['001', '002', '003']


def test_entry_names_are_safe_in_any_zip():
    assert safe_entry_name('../../etc/passwd') == 'passwd'
    assert safe_entry_name('C:\\Users\\me\\photo.jpg') == 'photo.jpg'
    assert safe_entry_name('a/b\x00c:d*e?.png') == 'b_c_d_e_.png'
    assert safe_entry_name('') == 'photo' and safe_entry_name(None) == 'photo' and safe_entry_name(' . ') == 'photo'
    assert safe_entry_name('பிறந்தநாள்.jpg') == 'பிறந்தநாள்.jpg'
    assert len(safe_entry_name('x' * 400 + '.jpeg')) == 125
    assert zip_entry_name(7, 'a.jpg') == '007_a.jpg' and zip_entry_name(1234, 'a.jpg') == '1234_a.jpg'
    assert '/' not in zip_entry_name(1, '../x.jpg')


def test_content_type_follows_the_name():
    assert content_type_for('a.JPG') == 'image/jpeg'
    assert content_type_for('a.png') == 'image/png'
    assert content_type_for('noext') == 'application/octet-stream'


def test_what_the_editor_sent_is_reduced_to_what_we_store():
    out = normalise_restore_payload({
        'editor_state': {'surfaces': []},
        'files': [
            {'file_id': 'file-a', 'upload_id': A},
            {'file_id': 'file-a-again', 'upload_id': A},       # first one wins
            {'file_id': 'has space', 'upload_id': B},          # bad id
            {'file_id': 'file-c', 'upload_id': 'not-a-uuid'},  # bad upload id
            'junk', {'upload_id': C},
        ],
        'anything_else': 'dropped',
    })
    assert out == {'editor_state': {'surfaces': []}, 'file_ids': {A: 'file-a'}}


def test_a_bad_block_is_dropped_never_an_error():
    for raw in (None, 'x', 5, [], {}, {'editor_state': 'x'}, {'files': 'x'}, {'editor_state': [], 'files': [{}]}):
        assert normalise_restore_payload(raw) is None
    # Ids survive a design that is unusable, and the other way round.
    assert normalise_restore_payload({'editor_state': 'x', 'files': [{'file_id': 'f', 'upload_id': A}]}) == {
        'editor_state': None, 'file_ids': {A: 'f'},
    }
    assert normalise_restore_payload({'editor_state': {'a': 1}}) == {'editor_state': {'a': 1}, 'file_ids': {}}


def test_an_oversized_design_is_dropped_but_the_ids_are_kept():
    big = {'blob': 'x' * (MAX_EDITOR_STATE_BYTES + 10)}
    out = normalise_restore_payload({'editor_state': big, 'files': [{'file_id': 'f', 'upload_id': A}]})
    assert out == {'editor_state': None, 'file_ids': {A: 'f'}}


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} restore-manifest tests passed.")
