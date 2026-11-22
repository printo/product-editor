"""Which sides of a layout have no Print Areas (photo frames).

The print engine refuses such a side ("No frames defined for layout"), so a
layout saved without one accepts orders that can never print. One rule, used
by the layout save, the render submit and (as the exception below) the worker.

Calendars and books are left to their own validators: a book's unauthored back
cover is deliberately frameless, and a calendar's frames are checked with its
month blocks.
"""
from __future__ import annotations


class LayoutHasNoFrames(ValueError):
    """The layout as stored cannot print. A retry reads the same layout, so the
    worker fails the job at once instead of retrying."""


def surfaces_without_frames(definition) -> list[str]:
    """Keys of the sides the engine could not print; `['default']` for a plain
    layout. Empty when every side has a Print Area, or the layout is not ours
    to judge (calendar, book, unreadable)."""
    if not isinstance(definition, dict):
        return []
    if definition.get('productType') in ('calendar', 'book'):
        return []
    surfaces = definition.get('surfaces')
    if definition.get('type') == 'product' and isinstance(surfaces, list):
        return [
            str(s.get('key', i)) for i, s in enumerate(surfaces)
            if isinstance(s, dict) and not s.get('frames')
        ]
    grid = definition.get('grid') if isinstance(definition.get('grid'), dict) else {}
    if definition.get('frames') or (grid.get('rows') and grid.get('cols')):
        return []
    return ['default']


def no_frames_message(missing: list[str]) -> str:
    """Ops-facing reason, naming the sides of a multi-side layout."""
    if missing == ['default']:
        return "This layout has no Print Areas, so nothing can be printed on it. Add at least one Print Area."
    sides = ', '.join(f"'{k}'" for k in missing)
    return f"Side {sides} has no Print Areas, so it cannot be printed. Add at least one Print Area to every side."


# What a customer or a partner sees when a submit is refused: the layout's
# set-up is ours to fix, not theirs.
SUBMIT_REFUSED = "This product is not ready for printing yet. Please contact support."
