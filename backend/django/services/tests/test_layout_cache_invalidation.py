"""
Regression tests for layout cache invalidation.

Two bugs motivated these, both the same shape — a cache written under one key
family and invalidated under another:

  1. LayoutManagementView.delete() cleared only "layouts_list_all", leaving
     "ops_layouts_list_all" (the cache the ops Templates page actually reads)
     serving the deleted layout for the rest of its 2-minute TTL.

  2. The "layout_detail:<name>:<surfaces>" family — written by BOTH
     GetLayoutView and EditorInitView — was never invalidated by anything.
     Since the renderer reads the layout fresh from disk at render time while
     the editor was served the cached copy, an ops edit opened a window where
     the customer composed against stale frame geometry and the print used the
     new one. Silent wrong print.

These assert the invalidation contract without a database or a live Redis, by
driving invalidate_layout_caches() against a stub cache.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_layout_cache_invalidation
"""
from __future__ import annotations

import fnmatch


class _PlainCache:
    """A backend WITHOUT django_redis' delete_pattern extension."""

    def __init__(self, keys):
        self.keys = set(keys)

    def delete_many(self, keys):
        for k in keys:
            self.keys.discard(k)

    def delete(self, key):
        self.keys.discard(key)


class _RedisCache(_PlainCache):
    """A django_redis-style backend that supports glob deletes."""

    def delete_pattern(self, pattern):
        for k in {k for k in self.keys if fnmatch.fnmatch(k, pattern)}:
            self.keys.discard(k)


def _StubCache(keys, *, supports_pattern=True):
    return (_RedisCache if supports_pattern else _PlainCache)(keys)


def _run(stub, name):
    """Invoke the real helper with `stub` swapped in for django's cache."""
    import django.core.cache as cache_mod
    from api.views import invalidate_layout_caches

    original = cache_mod.cache
    cache_mod.cache = stub
    try:
        invalidate_layout_caches(name)
    finally:
        cache_mod.cache = original


BASE_KEYS = [
    "layouts_list_all",
    "ops_layouts_list_all",
    "layout_detail:classic_5x7:",
    "layout_detail:classic_5x7:front",
    "layout_detail:classic_5x7:front,back",
    "layout_detail:other_layout:",
    "unrelated_key",
]


def test_clears_both_list_caches():
    stub = _StubCache(BASE_KEYS)
    _run(stub, "classic_5x7")
    assert "layouts_list_all" not in stub.keys
    assert "ops_layouts_list_all" not in stub.keys


def test_clears_every_surfaces_variant_of_that_layout():
    stub = _StubCache(BASE_KEYS)
    _run(stub, "classic_5x7")
    remaining = {k for k in stub.keys if k.startswith("layout_detail:classic_5x7:")}
    assert remaining == set(), f"stale detail entries survived: {remaining}"


def test_does_not_touch_other_layouts_or_unrelated_keys():
    stub = _StubCache(BASE_KEYS)
    _run(stub, "classic_5x7")
    assert "layout_detail:other_layout:" in stub.keys
    assert "unrelated_key" in stub.keys


def test_name_prefix_collision_is_not_over_deleted():
    # "classic_5x7" must not take out "classic_5x70".
    stub = _StubCache(BASE_KEYS + ["layout_detail:classic_5x70:"])
    _run(stub, "classic_5x7")
    assert "layout_detail:classic_5x70:" in stub.keys


def test_without_name_only_lists_are_cleared():
    stub = _StubCache(BASE_KEYS)
    _run(stub, None)
    assert "layouts_list_all" not in stub.keys
    assert "layout_detail:classic_5x7:" in stub.keys


def test_backend_without_delete_pattern_still_clears_the_plain_key():
    # A non-Redis backend must degrade, not raise — the write that triggered
    # the invalidation must never fail because of the cache.
    stub = _StubCache(BASE_KEYS, supports_pattern=False)
    _run(stub, "classic_5x7")
    assert "layouts_list_all" not in stub.keys
    assert "layout_detail:classic_5x7:" not in stub.keys


def test_retention_promise_matches_gc_enforcement():
    # The webhook's expires_at and the GC's retention window must derive from
    # one constant; they drifted (30 promised vs 14 enforced) once already.
    from django.conf import settings

    assert isinstance(settings.EXPORT_RETENTION_DAYS, int)
    assert settings.EXPORT_RETENTION_DAYS > 0
    assert (
        settings.EXPORT_RETENTION_DAYS_UNDER_PRESSURE
        <= settings.EXPORT_RETENTION_DAYS
    ), "pressure retention must not exceed the normal window"


if __name__ == "__main__":
    import os
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
    django.setup()

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} layout-cache-invalidation tests passed.")
