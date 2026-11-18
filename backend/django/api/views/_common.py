"""
Helpers shared by several modules of the api.views package.

Imports nothing from the package itself: a submodule importing api.views would
be circular.
"""


import re

#: The one shape an order id may have. It flows into headers, logs, file paths
#: and lookups, so a value outside it is refused wherever a render accepts one.
ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')


def is_valid_order_id(order_id) -> bool:
    return isinstance(order_id, str) and bool(ORDER_ID_RE.match(order_id))


def is_safe_layout_name(name: str) -> bool:
    """
    Is this name structurally safe to build a path from?

    Purely a path-traversal guard — it says nothing about whether the layout
    exists. Callers that need existence must check separately so a missing
    layout can answer 404 rather than 400.
    """
    if not name:
        return False
    return not ('/' in name or '\\' in name or '..' in name or name.startswith('.'))


def layout_policy_cache_key(name: str) -> str:
    """
    Cache key for the raw definition behind quantity-policy decisions.

    Deliberately not part of the "layout_detail:<name>:<surfaces>" family: that
    one holds the shaped payload the editor views return verbatim (definition +
    `displayName`) and is only ever filled for public layouts. Sharing it let
    the policy read overwrite that payload with the bare definition.
    """
    return f"layout_policy:{name}"
