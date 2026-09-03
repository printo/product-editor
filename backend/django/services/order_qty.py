"""
Order-quantity enforcement — the server-side half of the `qty` rule.

`qty` is the number of items the customer ordered. It shipped in the browser
first (`checkOrderQty` in `frontend/nextjs/src/lib/submit-guards.ts`, PR #106),
travelling as a `?qty=N` parameter on the iframe URL. That URL belongs to the
customer's browser, so the cap it enforced was advisory: edit the number, or
post straight at `/api/editor/render`, and it was gone.

This module is the tamper-proof half. The quantity now rides the same path
`order_id` already takes — caller → `POST /api/embed/session` → `EmbedSession`
row → embed-proxy cache → `X-Order-Qty` header → `EditorRenderView` — so the
value the server checks against is the one the *caller* set, never the one the
browser carries.

Three properties are deliberate, and each has a reason worth not "tidying":

  1. **The asymmetry survives.** Over-quantity is rejected; under-quantity is
     accepted, exactly as in the browser. A wrong `qty` from the caller must
     never strand a real order at checkout, and the cost of a customer who
     cannot buy far exceeds the cost of one who ordered 12 and submitted 8.
     `qty_violation` therefore has one `>` in it and no lower bound.

  2. **It fails open.** An unreadable layout, an absent header, a header the
     proxy somehow mangled — all mean "do not check", not "reject". The check
     exists to stop tampering, and a guard that can 400 a legitimate order on
     its own uncertainty is worse than no guard.

  3. **It is narrower than the browser's rule, never wider.** The browser
     flattens a calendar template to a single surface and so caps it; this
     module exempts calendars and books outright, because their printed
     surface count comes from the template (12 months) or the customer's page
     count, not from "how many items were ordered". Being more permissive here
     cannot reject a submission the editor allowed — the reverse could.

Pure functions only: no Django, no DB, no I/O. `services/tests/test_order_qty.py`
pins it.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

# Upper bound on an accepted quantity. Not a product limit — a sanity gate, so
# a caller's stray `qty: 99999999` cannot be stored and later reported back as
# though it meant something. Real Printo batches top out in the low hundreds
# (see docs/LOAD_BASELINE.md); 10,000 leaves several orders of magnitude of
# headroom while still rejecting obvious nonsense.
MAX_ORDER_QTY = 10_000

# productTypes where the printed surface count is fixed by the template
# (a calendar is always 12 months) or chosen by the customer (a book's page
# count), so a "quantity ordered" figure does not describe it. Mirrors the
# `surfaceCount > 1` opt-out in checkOrderQty, which reaches these products via
# their materialized surface count rather than by name.
QTY_EXEMPT_PRODUCT_TYPES = frozenset({'calendar', 'book'})


class InvalidOrderQty(ValueError):
    """A supplied quantity cannot be interpreted as one."""


def parse_order_qty(raw: Any) -> Optional[int]:
    """
    Normalise a caller-supplied quantity.

    Returns `None` when nothing was sent (absent, empty, whitespace) — that is
    a valid state meaning "the caller did not specify", not an error. Returns a
    positive `int` within `MAX_ORDER_QTY` otherwise, and raises
    `InvalidOrderQty` for anything else.

    Bools are rejected rather than silently read as 0/1: `qty: true` is a
    caller mistake, and `int(True) == 1` would turn it into a one-item cap.
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        raise InvalidOrderQty('qty must be a positive integer.')
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return None
    elif isinstance(raw, float):
        # 12.0 is a quantity; 12.5 is not. JSON has no int/float distinction,
        # so a caller sending 12 through a JS client can legitimately arrive
        # here as a float.
        if not raw.is_integer():
            raise InvalidOrderQty('qty must be a whole number.')
        raw = int(raw)

    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise InvalidOrderQty('qty must be a positive integer.')

    if value <= 0:
        raise InvalidOrderQty('qty must be a positive integer.')
    if value > MAX_ORDER_QTY:
        raise InvalidOrderQty(f'qty must not exceed {MAX_ORDER_QTY}.')
    return value


def layout_surface_count(layout: Mapping[str, Any]) -> int:
    """
    How many physical surfaces this layout defines.

    Mirrors `normalizeLayout` in `src/lib/layout-utils.ts`: a layout is
    multi-surface only when it declares `type: "product"` *and* carries a
    `surfaces` list. Anything else — canvas and frames at the root — is the one
    implicit `default` surface the editor builds for it.
    """
    surfaces = layout.get('surfaces')
    if layout.get('type') == 'product' and isinstance(surfaces, list):
        return len(surfaces)
    return 1


def is_qty_enforceable(layout: Optional[Mapping[str, Any]]) -> bool:
    """
    Is the quantity rule meaningful for this layout?

    False — do not check — when the layout could not be read at all, when it is
    a calendar or a book, or when it prints more than one surface. See the
    module docstring on why the unknown case fails open.
    """
    if not isinstance(layout, Mapping):
        return False
    product_type = str(layout.get('productType') or '').strip().lower()
    if product_type in QTY_EXEMPT_PRODUCT_TYPES:
        return False
    return layout_surface_count(layout) <= 1


def count_placed_photos(canvases: Optional[Iterable[Mapping[str, Any]]]) -> int:
    """
    Photos the submission actually places, counted the way the browser counts
    them: one per frame holding an `upload_id`.

    Frame *placements*, not distinct files — the qty auto-fill deliberately
    repeats one photo across the remaining slots, so a 3-photo pick filling a
    12-item order arrives as 12 placements of 3 uploads and must read as 12,
    matching `files.length` at the moment `checkOrderQty` ran.

    A frame whose photo was lost client-side carries no `upload_id` and prints
    blank, so it is not a placed photo.
    """
    if not canvases:
        return 0
    total = 0
    for canvas in canvases:
        if not isinstance(canvas, Mapping):
            continue
        frames = canvas.get('frames')
        # list/tuple explicitly, not Iterable: this parses a JSON body, where
        # frames is always an array, and a permissive check would happily
        # iterate the keys of a stray object.
        if not isinstance(frames, (list, tuple)):
            continue
        for frame in frames:
            if not isinstance(frame, Mapping):
                continue
            if str(frame.get('upload_id') or '').strip():
                total += 1
    return total


def qty_violation(
    placed: int,
    order_qty: Optional[int],
    layout: Optional[Mapping[str, Any]],
) -> Optional[str]:
    """
    The 400 detail for a submission that carries more photos than were ordered,
    or `None` to let it through.

    The Python twin of `checkOrderQty`, minus the 'under' verdict — the server
    has no banner to show and no auto-fill to offer, so a shortfall is simply
    accepted. Keep it that way; see the module docstring.
    """
    if order_qty is None or order_qty <= 0:
        return None
    if not is_qty_enforceable(layout):
        return None
    if placed <= order_qty:
        return None
    return (
        f'This order is for {order_qty} photo'
        f'{"" if order_qty == 1 else "s"}, but the submission carries {placed}. '
        'Remove the extras and submit again.'
    )
