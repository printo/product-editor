"""
Tests for services.icon_store — icons served from our own cache.

The Icons tab loaded each tile straight from api.iconify.design in the
customer's browser; Iconify blocks an address after roughly 180 requests in a
few minutes, and the tiles turned into broken images (2026-11-05). These pin:
an icon is fetched from Iconify once and then served from storage for good; a
search warms its icons with one request per icon set; everything fetched is
counted against one server-wide cap, past which the answer is "unavailable",
never a request; only safe SVGs with checked names are stored; and Iconify's
own refusals are "try later", not "no such icon".

No network, no database, no Redis: Iconify, the cache and the storage root
are all stand-ins.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_icon_store
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.conf import settings

from services import icon_store as store
from services import storage as storage_mod

HEART = b'<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="currentColor" d="M12 21l-8-9a5 5 0 0 1 8-6a5 5 0 0 1 8 6z"/></svg>'
STAR_BODY = '<path fill="currentColor" d="M12 2l3 7h7l-6 4l2 8l-6-5l-6 5l2-8l-6-4h7z"/>'


class FakeCache:
    """The few cache calls the store makes, over a dict."""

    def __init__(self):
        self.data: dict = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value, timeout=None):
        self.data[key] = value

    def add(self, key, value, timeout=None):
        if key in self.data:
            return False
        self.data[key] = value
        return True

    def incr(self, key):
        self.data[key] += 1
        return self.data[key]


class FakeIconify:
    """Serves single icons, icon-set JSON and searches; records every call."""

    def __init__(self):
        self.svgs: dict[str, bytes] = {"mdi/heart": HEART}
        self.sets: dict[str, dict] = {
            "mdi": {"prefix": "mdi", "width": 24, "height": 24, "icons": {
                "heart": {"body": HEART.split(b">", 1)[1].rsplit(b"</svg>", 1)[0].decode()},
                "star": {"body": STAR_BODY},
                "turned": {"body": STAR_BODY, "rotate": 1},
            }, "aliases": {"favorite": {"parent": "heart"}}},
            "wide": {"prefix": "wide", "icons": {"banner": {"body": STAR_BODY, "width": 30, "height": 16}}},
        }
        self.searches: dict[str, list[str]] = {"love": ["mdi:heart", "mdi:star", "wide:banner", "mdi:turned"]}
        self.calls: list[str] = []
        self.status: int | None = None

    def __call__(self, url: str, max_bytes: int):
        self.calls.append(url)
        if self.status is not None:
            return self.status, b"error code: 1015"
        path = url[len(store.API) + 1:]
        if path.startswith("search?"):
            q = path.split("query=", 1)[1].split("&", 1)[0]
            return 200, json.dumps({"icons": self.searches.get(q, [])}).encode()
        if ".json?icons=" in path:
            prefix, _, names = path.partition(".json?icons=")
            data = self.sets.get(prefix)
            if data is None:
                return 404, b"404"
            wanted = names.replace("%2C", ",").split(",")
            icons = {n: data["icons"][n] for n in wanted if n in data["icons"]}
            return 200, json.dumps({**data, "icons": icons}).encode()
        body = self.svgs.get(path[:-len(".svg")])
        return (200, body) if body is not None else (404, b"404")


class Env:
    """A temp storage root, a dict cache and a fake Iconify for one test."""

    def __enter__(self):
        self.root = tempfile.mkdtemp(prefix="icon-store-")
        self._saved = (settings.STORAGE_ROOT, storage_mod._storage_instance, store.http_get, store.get_cache,
                       getattr(settings, "ICON_UPSTREAM_BUDGET", store.DEFAULT_BUDGET))
        settings.STORAGE_ROOT = self.root
        storage_mod._storage_instance = storage_mod.LocalStorage()
        self.iconify = FakeIconify()
        self.cache = FakeCache()
        store.http_get = self.iconify
        store.get_cache = lambda: self.cache
        store.clear_memory()
        return self

    def __exit__(self, *exc):
        (settings.STORAGE_ROOT, storage_mod._storage_instance, store.http_get, store.get_cache,
         settings.ICON_UPSTREAM_BUDGET) = self._saved
        store.clear_memory()
        shutil.rmtree(self.root, ignore_errors=True)
        return False


def _raises(exc_type, fn, *args):
    try:
        fn(*args)
    except exc_type:
        return True
    return False


def test_an_icon_is_fetched_once_and_then_served_from_storage_for_good():
    with Env() as env:
        assert store.icon_svg("mdi", "heart") == HEART
        assert env.iconify.calls == [f"{store.API}/mdi/heart.svg"]
        assert os.path.exists(os.path.join(env.root, "icon_cache", "mdi", "heart.svg"))
        store.clear_memory()                      # a new process
        env.iconify.status = 429                  # and Iconify refusing everything
        assert store.icon_svg("mdi", "heart") == HEART
        assert len(env.iconify.calls) == 1


def test_an_icon_iconify_does_not_have_is_not_found_and_not_asked_for_again():
    with Env() as env:
        assert _raises(store.IconNotFound, store.icon_svg, "mdi", "no-such-icon")
        assert _raises(store.IconNotFound, store.icon_svg, "mdi", "no-such-icon")
        assert len(env.iconify.calls) == 1


def test_names_that_are_not_icon_names_never_reach_iconify_or_the_disk():
    with Env() as env:
        for prefix, name in (("..", "heart"), ("mdi", "../../etc/passwd"), ("MDI", "heart"), ("mdi", "a b"),
                             ("mdi", ""), ("mdi/x", "y"), ("mdi", "heart.svg"), ("m" * 51, "x")):
            assert _raises(store.IconNotFound, store.icon_svg, prefix, name), (prefix, name)
        assert env.iconify.calls == []


def test_iconify_refusing_or_unreachable_is_try_later_not_missing():
    with Env() as env:
        for status in (429, 500, 503):
            env.iconify.status = status
            assert _raises(store.IconUnavailable, store.icon_svg, "mdi", "heart"), status
        env.iconify.status = None

        def offline(url, max_bytes):
            raise OSError("no route")

        store.http_get = offline
        assert _raises(store.IconUnavailable, store.icon_svg, "mdi", "heart")
        store.http_get = env.iconify
        assert store.icon_svg("mdi", "heart") == HEART      # nothing was remembered as missing


def test_an_unsafe_svg_is_refused_and_not_stored():
    with Env() as env:
        env.iconify.svgs["bad/script"] = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>'
        env.iconify.svgs["bad/remote"] = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="https://evil.example/x.png"/></svg>'
        env.iconify.svgs["bad/notsvg"] = b"<html>hello</html>"
        for name in ("script", "remote", "notsvg"):
            assert _raises(store.IconNotFound, store.icon_svg, "bad", name), name
        assert not os.path.exists(os.path.join(env.root, "icon_cache", "bad"))


def test_fetches_stop_at_the_server_wide_cap():
    with Env() as env:
        settings.ICON_UPSTREAM_BUDGET = 3
        for name in ("a", "b", "c"):
            assert _raises(store.IconNotFound, store.icon_svg, "mdi", name)
        assert _raises(store.IconUnavailable, store.icon_svg, "mdi", "heart")
        assert len(env.iconify.calls) == 3          # the fourth was never sent
        env.cache.data.clear()                      # the next window
        assert store.icon_svg("mdi", "heart") == HEART


def test_a_cached_icon_costs_nothing_when_the_cap_is_spent():
    with Env() as env:
        store.icon_svg("mdi", "heart")
        settings.ICON_UPSTREAM_BUDGET = 0
        env.cache.data[next(k for k in env.cache.data if k.startswith("icon-upstream:"))] = 999
        assert store.icon_svg("mdi", "heart") == HEART


def test_a_search_warms_its_icons_with_one_request_per_icon_set():
    with Env() as env:
        names = store.search("  LOVE ")
        assert names == ["mdi:heart", "mdi:star", "wide:banner", "mdi:turned"]
        assert env.iconify.calls[0] == f"{store.API}/search?query=love&limit=60"
        assert sorted(env.iconify.calls[1:]) == [          # the sets are fetched side by side
            f"{store.API}/mdi.json?icons=heart%2Cstar%2Cturned",
            f"{store.API}/wide.json?icons=banner",
        ]
        before = len(env.iconify.calls)
        store.icon_svg("mdi", "heart")
        store.icon_svg("mdi", "star")
        store.icon_svg("wide", "banner")
        assert len(env.iconify.calls) == before     # all three were warmed
        assert _raises(store.IconNotFound, store.icon_svg, "mdi", "turned")   # a rotated icon: left to the single fetch
        assert env.iconify.calls[-1] == f"{store.API}/mdi/turned.svg"


def test_a_search_is_answered_from_the_cache_the_second_time():
    with Env() as env:
        store.search("love")
        before = len(env.iconify.calls)
        assert store.search("Love") == ["mdi:heart", "mdi:star", "wide:banner", "mdi:turned"]
        assert len(env.iconify.calls) == before


def test_a_search_we_will_not_send_is_a_value_error():
    with Env() as env:
        for q in ("", "a", "x" * 51, "love/../x", "a?b=c", "<script>"):
            assert _raises(ValueError, store.search, q), q
        assert env.iconify.calls == []


def test_a_search_still_answers_when_the_cap_runs_out_during_warm_up():
    with Env() as env:
        settings.ICON_UPSTREAM_BUDGET = 2           # the search and one icon set
        assert len(store.search("love")) == 4
        assert len(env.iconify.calls) == 2
        # Whichever set got the last of the budget is cached; the other is "try later".
        outcomes = []
        for prefix, name in (("mdi", "heart"), ("wide", "banner")):
            try:
                store.icon_svg(prefix, name)
                outcomes.append("cached")
            except store.IconUnavailable:
                outcomes.append("later")
        assert sorted(outcomes) == ["cached", "later"]


def test_a_refused_search_is_try_later():
    with Env() as env:
        env.iconify.status = 429
        assert _raises(store.IconUnavailable, store.search, "love")


def test_the_svg_built_from_an_icon_set_is_the_one_iconify_serves():
    data = {"prefix": "mdi", "width": 24, "height": 24, "icons": {"star": {"body": STAR_BODY}}}
    assert store.svg_from_set(data, "star") == (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">' + STAR_BODY + '</svg>'
    ).encode()
    wide = {"icons": {"banner": {"body": STAR_BODY, "width": 30, "height": 16, "left": 1, "top": 2}}}
    assert store.svg_from_set(wide, "banner").startswith(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="1.88em" height="1em" viewBox="1 2 30 16">')
    linked = {"width": 24, "height": 24, "icons": {"a": {"body": '<use xlink:href="#b"/>'}}}
    assert b'xmlns:xlink="http://www.w3.org/1999/xlink"' in store.svg_from_set(linked, "a")
    for plain_only in ({"icons": {"a": {"body": STAR_BODY, "hFlip": True}}}, {"icons": {}}, {"aliases": {"a": {"parent": "b"}}}, {}):
        assert store.svg_from_set(plain_only, "a") is None


def test_the_s3_backend_keeps_icons_under_icon_cache_as_svg():
    from services.tests.fake_s3 import S3Backend

    with S3Backend() as s3:
        saved = (store.http_get, store.get_cache)
        iconify, cache = FakeIconify(), FakeCache()
        store.http_get, store.get_cache = iconify, lambda: cache
        store.clear_memory()
        try:
            assert store.icon_svg("mdi", "heart") == HEART
            key = s3.storage.icon_key("mdi/heart.svg")
            assert key.endswith("icon-cache/mdi/heart.svg")
            assert s3.storage.read_icon_file("mdi/heart.svg") == HEART
            store.clear_memory()
            iconify.status = 429
            assert store.icon_svg("mdi", "heart") == HEART
            assert len(iconify.calls) == 1
        finally:
            store.http_get, store.get_cache = saved
            store.clear_memory()


if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL {t.__name__}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
