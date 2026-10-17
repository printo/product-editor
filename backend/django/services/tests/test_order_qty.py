"""
Tests for server-side order-quantity enforcement (services/order_qty.py).

`qty` shipped in the browser first, as a URL parameter the customer's own
browser could edit. Moving it server-side only helps if the server half keeps
the *shape* of the original rule, so these pin the properties that make it safe
to turn on in front of real orders:

  * over-quantity is rejected, under-quantity is NOT — the asymmetry is the
    whole design, and reversing it would strand a real order at checkout on a
    caller's typo
  * an unknown or unreadable layout means "do not check", never "reject"
  * calendars, books and multi-surface products are exempt, so the server can
    never reject a submission the editor itself allowed
  * a placement count matches what the browser counted: frames holding an
    upload, duplicates included, blanks excluded
  * a quantity that cannot be a quantity (0, negative, fractional, boolean,
    absurd) is refused at session creation rather than stored and enforced

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \\
        python -m services.tests.test_order_qty
"""
from __future__ import annotations

import os

from services.order_qty import (
    calendar_page_count,
    calendar_photo_slots,
    calendar_qty_summary,
    MAX_ORDER_QTY,
    InvalidOrderQty,
    count_placed_photos,
    is_qty_enforceable,
    layout_surface_count,
    parse_order_qty,
    qty_summary,
    qty_violation,
)

SINGLE = {'canvas': {'width': 1200, 'height': 1800}, 'frames': [{}]}
MULTI = {'type': 'product', 'surfaces': [{'key': 'front'}, {'key': 'back'}]}
CALENDAR = {'productType': 'calendar', 'canvas': {}, 'frames': [{}]}
BOOK = {'productType': 'book', 'book': {'pageCount': {'default': 24}}}


def _canvases(*counts, blanks=0):
    """One canvas per count, each holding that many photo frames (+ blanks)."""
    out = []
    n = 0
    for c in counts:
        frames = []
        for _ in range(c):
            frames.append({'frame_index': len(frames), 'upload_id': f'u{n}'})
            n += 1
        for _ in range(blanks):
            frames.append({'frame_index': len(frames), 'upload_id': None})
        out.append({'surface_key': 'front', 'frames': frames})
    return out


# ── parse_order_qty ─────────────────────────────────────────────────────────

def test_absent_quantity_is_not_an_error():
    """"The caller did not say" is a valid state, distinct from a bad value."""
    assert parse_order_qty(None) is None
    assert parse_order_qty('') is None
    assert parse_order_qty('   ') is None


def test_a_clean_quantity_parses_from_int_str_and_whole_float():
    assert parse_order_qty(12) == 12
    assert parse_order_qty('12') == 12
    assert parse_order_qty('  12  ') == 12
    # JSON has no int/float distinction, so a JS client's 12 can arrive as 12.0.
    assert parse_order_qty(12.0) == 12
    assert parse_order_qty(1) == 1
    assert parse_order_qty(MAX_ORDER_QTY) == MAX_ORDER_QTY


def test_non_quantities_are_refused_at_the_door():
    for bad in (0, -1, '0', '-4', '12.5', 12.5, 'abc', '12abc', [], {}):
        try:
            parse_order_qty(bad)
        except InvalidOrderQty:
            continue
        raise AssertionError(f'{bad!r} was accepted as a quantity')


def test_booleans_are_refused_rather_than_read_as_one():
    """`qty: true` is a caller mistake; int(True) == 1 would cap the order at 1."""
    for bad in (True, False):
        try:
            parse_order_qty(bad)
        except InvalidOrderQty:
            continue
        raise AssertionError(f'{bad!r} was accepted as a quantity')


def test_an_absurd_quantity_is_refused():
    try:
        parse_order_qty(MAX_ORDER_QTY + 1)
    except InvalidOrderQty as exc:
        assert str(MAX_ORDER_QTY) in str(exc), exc
    else:
        raise AssertionError('an over-cap quantity was accepted')


# ── layout shape ────────────────────────────────────────────────────────────

def test_surface_count_mirrors_the_frontend_normalizer():
    """type:"product" + surfaces[] is multi-surface; anything else is one."""
    assert layout_surface_count(SINGLE) == 1
    assert layout_surface_count(MULTI) == 2
    # surfaces[] without type:"product" is NOT a product layout — the frontend
    # normalizer builds one implicit `default` surface for it, so we must too.
    assert layout_surface_count({'surfaces': [{'key': 'a'}, {'key': 'b'}]}) == 1
    assert layout_surface_count({'type': 'product', 'surfaces': []}) == 0


def test_only_single_surface_photo_products_are_checked():
    assert is_qty_enforceable(SINGLE) is True
    assert is_qty_enforceable(MULTI) is False
    # A calendar's 12 pages come from the template and a book's from the
    # customer's page count — neither is "how many items were ordered". Both
    # are exempt here even though the browser's flattened surface count caps
    # them, because being narrower than the editor can never reject a
    # submission the editor allowed; the reverse could.
    assert is_qty_enforceable(CALENDAR) is False
    assert is_qty_enforceable(BOOK) is False
    assert is_qty_enforceable({'productType': 'CALENDAR'}) is False


def test_an_unreadable_layout_fails_open():
    """None means "unknown" and must disable the check, not trigger a 400."""
    assert is_qty_enforceable(None) is False
    assert is_qty_enforceable('not-a-layout') is False
    assert qty_violation(50, 1, None) is None


# ── count_placed_photos ─────────────────────────────────────────────────────

def test_counts_frames_that_hold_a_photo():
    assert count_placed_photos(_canvases(1, 1, 1)) == 3
    assert count_placed_photos(_canvases(4, 4, 4)) == 12
    assert count_placed_photos([]) == 0
    assert count_placed_photos(None) == 0


def test_a_repeated_upload_counts_once_per_placement():
    """
    The qty auto-fill deliberately repeats a photo into the remaining slots, so
    3 uploads filling a 12-item order arrive as 12 placements. Counting distinct
    uploads would read that as 3 and let a tampered 12-item order carry 40.
    """
    canvases = [{'frames': [{'upload_id': 'same'}]} for _ in range(12)]
    assert count_placed_photos(canvases) == 12


def test_a_blank_frame_is_not_a_placed_photo():
    """A photo lost client-side prints blank; it was not ordered twice."""
    assert count_placed_photos(_canvases(1, blanks=3)) == 1
    assert count_placed_photos([{'frames': [{'upload_id': ''}, {'upload_id': '  '}]}]) == 0
    assert count_placed_photos([{'frames': [{}]}]) == 0


def test_a_malformed_payload_cannot_raise():
    """The count runs before validation, on whatever the caller posted."""
    assert count_placed_photos(['nope', None, 7]) == 0
    assert count_placed_photos([{'frames': 'nope'}, {'frames': None}, {}]) == 0
    assert count_placed_photos([{'frames': ['nope', {'upload_id': 'u1'}]}]) == 1


# ── qty_violation — the rule itself ─────────────────────────────────────────

def test_exact_and_under_are_accepted():
    assert qty_violation(12, 12, SINGLE) is None
    assert qty_violation(8, 12, SINGLE) is None
    assert qty_violation(0, 12, SINGLE) is None


def test_under_stays_accepted_and_this_is_deliberate():
    """
    The asymmetry is load-bearing. qty is supplied by the caller; a wrong value
    would strand a real order at checkout, and a customer who cannot buy costs
    more than one who ordered 12 and submitted 8. Do not add a lower bound.
    """
    for placed in range(0, 12):
        assert qty_violation(placed, 12, SINGLE) is None, placed


def test_over_is_rejected_with_both_numbers_in_the_message():
    detail = qty_violation(20, 12, SINGLE)
    assert detail is not None
    assert '12' in detail and '20' in detail, detail


def test_one_item_reads_as_singular():
    detail = qty_violation(2, 1, SINGLE)
    assert detail is not None and '1 photo,' in detail, detail


def test_no_quantity_disables_the_check_entirely():
    assert qty_violation(500, None, SINGLE) is None
    # A 0 or negative should never have been stored, but if one ever is it must
    # read as "no quantity" rather than cap every order at nothing.
    assert qty_violation(500, 0, SINGLE) is None
    assert qty_violation(500, -3, SINGLE) is None


def test_exempt_products_are_never_rejected():
    for layout in (MULTI, CALENDAR, BOOK):
        assert qty_violation(500, 1, layout) is None, layout


def test_the_boundary_is_strictly_greater_than():
    assert qty_violation(12, 12, SINGLE) is None
    assert qty_violation(13, 12, SINGLE) is not None


def test_matches_the_browser_verdicts_it_mirrors():
    """
    The cases pinned in src/lib/__tests__/submit-guards.test.ts, run through
    the server half. 'under' and 'ok' both mean "accept" here; only 'over'
    produces a message.
    """
    cases = [
        # (placed, qty, surface_count, browser_verdict)
        (12, 12, 1, 'ok'),
        (8, 12, 1, 'under'),
        (20, 12, 1, 'over'),
        (20, None, 1, 'ok'),
        (5, 0, 1, 'ok'),
        (20, 12, 2, 'ok'),
        (2, 12, 12, 'ok'),
    ]
    for placed, qty, surfaces, verdict in cases:
        layout = (
            SINGLE if surfaces == 1
            else {'type': 'product', 'surfaces': [{'key': f's{i}'} for i in range(surfaces)]}
        )
        rejected = qty_violation(placed, qty, layout) is not None
        assert rejected is (verdict == 'over'), (placed, qty, surfaces, verdict)


def test_qty_summary_records_an_acknowledged_shortfall():
    assert qty_summary(8, 12, SINGLE, True) == {
        'ordered_qty': 12, 'placed_photos': 8, 'shortfall': 4,
        'customer_acknowledged_shortfall': True,
        'summary': 'Customer agreed to proceed with 8 photos instead of the 12 ordered.',
    }


def test_qty_summary_text_for_unacknowledged_and_full_orders():
    assert qty_summary(8, 12, SINGLE, None)['summary'] == (
        'Customer submitted 8 photos instead of the 12 ordered (acknowledgement not received).')
    assert qty_summary(12, 12, SINGLE, True)['summary'] == 'Customer submitted all 12 ordered photos.'


def test_qty_summary_only_a_literal_true_acknowledges():
    for ack in (None, False, 'true', 1):
        assert qty_summary(8, 12, SINGLE, ack)['customer_acknowledged_shortfall'] is False


def test_qty_summary_no_shortfall_means_nothing_to_acknowledge():
    s = qty_summary(12, 12, SINGLE, True)
    assert s['shortfall'] == 0 and s['customer_acknowledged_shortfall'] is False


def test_qty_summary_absent_without_an_enforceable_qty():
    assert qty_summary(8, None, SINGLE, True) is None
    assert qty_summary(8, 0, SINGLE, True) is None
    two_sided = {'type': 'product', 'surfaces': [{'key': 'a'}, {'key': 'b'}]}
    assert qty_summary(1, 12, two_sided, True) is None



# ── Calendars: measured against their own photo pages ──────────────────────

def _photo_slot_cases() -> list:
    import json
    path = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'storage',
                        'parity-fixtures', 'calendar-photo-slots.json')
    if not os.path.exists(path):  # inside the backend container storage is /app/storage
        path = os.path.join(os.path.dirname(__file__), '..', '..', 'storage',
                            'parity-fixtures', 'calendar-photo-slots.json')
    with open(path) as f:
        return json.load(f)['cases']


def test_calendar_photo_slots_match_the_shared_fixture():
    for c in _photo_slot_cases():
        assert calendar_page_count(c['layout']) == c['pages'], c['name']
        assert calendar_photo_slots(c['layout']) == c['slots'], c['name']


CALENDAR_12 = {'productType': 'calendar', 'monthRange': {'count': 12}, 'frames': [{}]}


def test_calendar_summary_reports_pages_without_their_own_photo():
    s = calendar_qty_summary(4, CALENDAR_12, True)
    assert s['ordered_qty'] == 12 and s['placed_photos'] == 4 and s['shortfall'] == 8
    assert s['customer_acknowledged_shortfall'] is True
    assert s['summary'] == ('Customer agreed to proceed with 4 photos for the 12 calendar '
                            'pages; the other 8 repeat those photos.')


def test_calendar_summary_without_acknowledgement_says_so():
    s = calendar_qty_summary(1, CALENDAR_12, None)
    assert s['customer_acknowledged_shortfall'] is False
    assert s['summary'].endswith('(acknowledgement not received).')
    assert '1 photo for' in s['summary']


def test_calendar_summary_when_every_page_has_a_photo():
    s = calendar_qty_summary(12, CALENDAR_12, True)
    assert s['shortfall'] == 0 and s['customer_acknowledged_shortfall'] is False
    assert s['summary'] == 'Customer added photos for all 12 calendar pages.'


def test_calendar_summary_is_none_for_other_products():
    assert calendar_qty_summary(3, {'productType': 'book'}, True) is None
    assert calendar_qty_summary(3, {'canvas': {}, 'frames': [{}]}, True) is None
    assert calendar_qty_summary(3, None, True) is None


def test_the_session_qty_rule_still_exempts_calendars():
    # Calendars are measured by calendar_qty_summary instead; the session qty
    # (calendars bought) must never cap or summarise them.
    assert qty_violation(20, 1, CALENDAR_12) is None
    assert qty_summary(4, 1, CALENDAR_12, True) is None

if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} order-qty tests passed.")
