"""
Layout tags: an ops-managed list of product tags a layout can carry.

A tag has a **key** (lowercase, digits and underscores, fixed once created)
and a **name** (what people see, renameable at any time). A layout stores only
the keys, as `tagKeys` in its definition. Every layout response adds `tags`,
the current names in the same order, so a rename shows everywhere at once and
callers that read `tags` (names) keep working unchanged.

A tag is never deleted, only switched off: a switched-off tag stays on the
layouts that already carry it and drops out of the picker.

Pure module (no Django, no DB): the views pass in the `{key: name}` map.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional

TAG_KEY_MAX = 50
TAG_NAME_MAX = 60
MAX_TAGS_PER_LAYOUT = 20

TAG_KEY_RE = re.compile(r'^[a-z0-9]+(?:_[a-z0-9]+)*$')


class InvalidTag(ValueError):
    """A tag key or name the API refuses, with a message fit for a 400."""


def is_tag_key(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= TAG_KEY_MAX and bool(TAG_KEY_RE.match(value))


def key_for_name(name: str) -> str:
    """Suggested key for a tag name: 'Photo Prints' -> 'photo_prints'."""
    words = re.findall(r'[a-z0-9]+', (name or '').lower())
    return '_'.join(words)[:TAG_KEY_MAX].strip('_')


def clean_tag_name(raw: Any) -> str:
    name = ' '.join(str(raw or '').split())
    if not name:
        raise InvalidTag('Tag name is required.')
    if len(name) > TAG_NAME_MAX:
        raise InvalidTag(f'Tag name must be at most {TAG_NAME_MAX} characters.')
    return name


def clean_tag_key(raw: Any) -> str:
    key = str(raw or '').strip()
    if not is_tag_key(key):
        raise InvalidTag(
            f'Tag key must be 1-{TAG_KEY_MAX} lowercase letters, digits and single '
            f'underscores, e.g. photo_prints.'
        )
    return key


def clean_tag_keys(raw: Any) -> list:
    """A layout's `tagKeys`: a list of valid keys, de-duplicated in order."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise InvalidTag('tagKeys must be a list of tag keys.')
    keys: list = []
    for item in raw:
        key = clean_tag_key(item)
        if key not in keys:
            keys.append(key)
    if len(keys) > MAX_TAGS_PER_LAYOUT:
        raise InvalidTag(f'A layout can carry at most {MAX_TAGS_PER_LAYOUT} tags.')
    return keys


def keys_from_names(names: Any, key_by_name: Mapping[str, str]) -> list:
    """Legacy `tags` (names) -> keys. `key_by_name` is keyed by lowercased name.

    Raises InvalidTag naming the first name that matches no tag.
    """
    if names is None:
        return []
    if not isinstance(names, list):
        raise InvalidTag('tags must be a list of tag names.')
    keys: list = []
    for name in names:
        cleaned = ' '.join(str(name or '').split())
        if not cleaned:
            continue
        key = key_by_name.get(cleaned.lower())
        if key is None:
            raise InvalidTag(f"Unknown tag '{cleaned}'. Create it on the Tags page first.")
        if key not in keys:
            keys.append(key)
    return keys


def resolve_layout_tag_keys(
    layout_data: dict,
    *,
    existing_keys: Optional[Iterable[str]],
    known: Mapping[str, bool],
    key_by_name: Mapping[str, str],
) -> list:
    """The `tagKeys` to store for a layout save.

    `known` maps every tag key to whether it is active. Precedence:
      * `tagKeys` in the body wins;
      * else legacy `tags` (names) are mapped to keys;
      * else the layout keeps the keys it already has (an editor that does not
        show tags must not wipe them).
    Every key must exist. A key the layout did not already carry must also be
    active: a switched-off tag can stay where it is but not be newly added.
    """
    previous = list(existing_keys or [])
    if 'tagKeys' in layout_data:
        keys = clean_tag_keys(layout_data.get('tagKeys'))
    elif 'tags' in layout_data:
        keys = keys_from_names(layout_data.get('tags'), key_by_name)
    else:
        return previous
    for key in keys:
        if key not in known:
            raise InvalidTag(f"Unknown tag key '{key}'.")
        if not known[key] and key not in previous:
            raise InvalidTag(f"Tag '{key}' is switched off and cannot be added to a layout.")
    return keys


def with_tag_names(data: dict, name_by_key: Mapping[str, str]) -> dict:
    """A copy of a layout response with `tagKeys` and `tags` (names) filled in.

    A definition saved before tags had keys carries only `tags` (names); its
    keys are recovered from the names it matches and its names are left as
    they are.
    """
    out = dict(data)
    raw_keys = data.get('tagKeys')
    if isinstance(raw_keys, list):
        keys = [k for k in raw_keys if isinstance(k, str)]
        out['tagKeys'] = keys
        out['tags'] = [name_by_key.get(k, k) for k in keys]
        return out
    names = data.get('tags') if isinstance(data.get('tags'), list) else []
    key_by_name = {n.lower(): k for k, n in name_by_key.items()}
    out['tags'] = names
    out['tagKeys'] = [key_by_name[n.lower()] for n in names if isinstance(n, str) and n.lower() in key_by_name]
    return out


def layout_has_tag(data: dict, key: str) -> bool:
    keys = data.get('tagKeys')
    return isinstance(keys, list) and key in keys
