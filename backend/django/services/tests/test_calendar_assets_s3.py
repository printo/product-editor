"""
Tests that an ops edit to a calendar asset reaches the print under
STORAGE_BACKEND=s3, not just the preview — and that an ops DELETE sticks.

Two defects stacked here. The render-time readers (holidays, theme style,
Gen-Z palette) opened files under STORAGE_ROOT directly, while the ops
endpoints write through `get_storage()`. And `S3Storage.read_calendar_asset`
built its key with neither the service prefix nor the `.json` suffix that
`write_calendar_asset` adds, so under S3 no read ever found what a write had
put: everything silently fell back to local disk, and an ops edit reached
neither the preview nor the print.

Then a third: the read fell back to the git-seeded local file on ANY S3
failure. So an ops DELETE of a seeded year (en-IN/2026 etc. — seeds exist on
prod) was undone by the very next read, in preview and print alike, and an
S3 outage served the seed as if it were the ops-edited asset. Deletes now
leave a tombstone, only a genuinely absent key reaches the seed, and an
outage raises CalendarAssetUnavailable — a 503 in the preview, a retried
render in the print.

Each case seeds a DIFFERENT local file from the S3 object, so a reader that
still goes to disk returns the seed and fails. S3 is an in-memory stand-in
for the boto3 client — no network, no credentials.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_calendar_assets_s3
"""
from __future__ import annotations

import os
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.test import RequestFactory  # noqa: E402
from django.urls import resolve  # noqa: E402

from services import asset_store  # noqa: E402
from services.asset_store import AssetNotFoundError, CalendarAssetUnavailable  # noqa: E402
from services.calendar_holidays import load_holidays_for_year  # noqa: E402
from services.calendar_layout import _resolve_genz_palette, _resolve_theme_style  # noqa: E402
from services.storage import LocalStorage  # noqa: E402
from services.tests.fake_s3 import FakeClientError, S3Backend  # noqa: E402


def _holidays(*names):
    return {"events": [{"date": f"2031-01-{i + 1:02d}", "name": n} for i, n in enumerate(names)]}


def _printed():
    return [ev["name"] for ev in load_holidays_for_year("en-IN", 2031)]


def _raises(exc_type, fn, *args):
    try:
        fn(*args)
    except exc_type:
        return
    except Exception as exc:  # noqa: BLE001 — report what was raised instead
        raise AssertionError(f"{fn.__name__}{args} raised {exc!r}, expected {exc_type.__name__}")
    raise AssertionError(f"{fn.__name__}{args} did not raise {exc_type.__name__}")


# Errors after which S3 cannot say whether the key exists. Each must NOT be
# answered from the local seed.
OUTAGES = (
    ConnectionError("Could not connect to the endpoint URL"),  # no .response, like botocore's
    FakeClientError("InternalError", 500),
    FakeClientError("SlowDown", 503),
    FakeClientError("InvalidAccessKeyId", 403),
    FakeClientError("RequestTimeTooSkewed", 403),
)


# ── Storage layer ────────────────────────────────────────────────────────────

def test_s3_read_write_and_delete_share_one_key():
    with S3Backend() as b:
        for asset_type, name in (("holidays", "en-IN/2031"),
                                 ("calendar_styles", "modern-minimalist"),
                                 ("calendar_palettes/genz", "butter"),
                                 ("fonts", "fonts")):
            key = b.key(asset_type, name)
            b.storage.write_calendar_asset(asset_type, name, b"{}")
            assert list(b.client.objects) == [key], b.client.objects
            assert b.storage.read_calendar_asset(asset_type, name) == b"{}"
            b.storage.delete_calendar_asset(asset_type, name)
            # Delete leaves a tombstone at the same key, not a gap.
            assert list(b.client.objects) == [key], (asset_type, b.client.objects)
            _raises(FileNotFoundError, b.storage.read_calendar_asset, asset_type, name)
            b.client.objects.clear()
            b.client.metadata.clear()


def test_s3_miss_still_falls_back_to_local_seed():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.seed_local("calendar_styles/modern-minimalist.json", {"colors": {}})
        assert _printed() == ["Local Seed"]
        assert _resolve_theme_style("modern-minimalist") == {"colors": {}}


def test_access_denied_reads_as_a_missing_key():
    # Without s3:ListBucket, S3 answers a GET for a missing key with 403
    # AccessDenied rather than 404 — so it has to reach the seed too, or every
    # never-written asset would be unreadable under such a policy.
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.client.get_error = FakeClientError("AccessDenied", 403)
        assert _printed() == ["Local Seed"]


def test_outage_is_not_mistaken_for_a_missing_key():
    for error in OUTAGES:
        with S3Backend() as b:
            b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
            b.client.get_error = error
            _raises(CalendarAssetUnavailable, b.storage.read_calendar_asset, "holidays", "en-IN/2031")
            _raises(CalendarAssetUnavailable, asset_store.read_asset_json, "holidays", "en-IN/2031")
            # Not an AssetNotFoundError — callers treat that one as "no data".
            assert not issubclass(CalendarAssetUnavailable, FileNotFoundError)


def test_body_read_failure_is_an_outage():
    class _BrokenBody:
        def read(self):
            raise ConnectionError("Connection reset by peer")

    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.client.get_object = lambda Bucket, Key: {"Body": _BrokenBody(), "Metadata": {}}
        _raises(CalendarAssetUnavailable, b.storage.read_calendar_asset, "holidays", "en-IN/2031")


def test_real_botocore_errors_classify_the_same():
    try:
        from botocore.exceptions import ClientError, EndpointConnectionError
    except ImportError:  # pragma: no cover — boto3 is in requirements.txt
        print("    (botocore not installed — skipped)")
        return

    def client_error(code, status):
        return ClientError({"Error": {"Code": code, "Message": code},
                            "ResponseMetadata": {"HTTPStatusCode": status}}, "GetObject")

    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        for error in (client_error("NoSuchKey", 404), client_error("AccessDenied", 403)):
            b.client.get_error = error
            assert _printed() == ["Local Seed"], error
        for error in (client_error("InternalError", 500),
                      EndpointConnectionError(endpoint_url="https://s3.example")):
            b.client.get_error = error
            _raises(CalendarAssetUnavailable, b.storage.read_calendar_asset, "holidays", "en-IN/2031")


def test_failed_delete_raises_and_changes_nothing():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.put("holidays", "en-IN/2031", _holidays("Ops Edit"))
        b.client.put_error = FakeClientError("InternalError", 500)
        # Used to return False, which HolidaysView ignored and answered 204.
        _raises(IOError, b.storage.delete_calendar_asset, "holidays", "en-IN/2031")
        b.client.put_error = None
        assert _printed() == ["Ops Edit"]


def test_local_backend_uses_the_one_seed_path():
    # LocalStorage's file and S3Storage's fallback seed are the same path, and
    # asset_store reads both backends through read_calendar_asset — the '.json'
    # rule used to be written three different ways.
    storage = LocalStorage()
    with S3Backend() as b:  # only for the temp STORAGE_ROOT
        with patch("services.storage._storage_instance", storage):
            for asset_type, name in (("holidays", "en-IN/2031"),
                                     ("calendar_styles", "modern-minimalist"),
                                     ("calendar_palettes/genz", "butter"),
                                     ("fonts", "fonts")):
                path = storage.write_calendar_asset(asset_type, name, b'{"v": 1}')
                assert path == os.path.join(b.root, asset_type, f"{name}.json"), path
                assert asset_store.read_asset_json(asset_type, name) == {"v": 1}
                assert storage.delete_calendar_asset(asset_type, name) is True
                _raises(AssetNotFoundError, asset_store.read_asset, asset_type, name)


# ── Preview and print ────────────────────────────────────────────────────────

def test_holiday_edit_reaches_print_and_preview_under_s3():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.put("holidays", "en-IN/2031", _holidays("Ops Edit"))

        previewed = [ev["name"] for ev in
                     asset_store.read_asset_json("holidays", "en-IN/2031")["events"]]
        assert _printed() == ["Ops Edit"], _printed()
        assert previewed == _printed(), previewed

        b.put("holidays", "en-IN/2031", _holidays("Second Edit"))
        assert _printed() == ["Second Edit"]


def test_theme_style_edit_reaches_print_under_s3():
    with S3Backend() as b:
        b.seed_local("calendar_styles/modern-minimalist.json", {"colors": {"accent": "#local"}})
        b.put("calendar_styles", "modern-minimalist", {"colors": {"accent": "#s3edit"}})
        style = _resolve_theme_style("modern-minimalist")
        assert style == {"colors": {"accent": "#s3edit"}}, style


def test_genz_palette_reaches_print_under_s3():
    with S3Backend() as b:
        b.seed_local("calendar_palettes/genz/butter.json", {"background": "#local"})
        b.put("calendar_palettes/genz", "butter", {"background": "#s3edit"})
        palette = _resolve_genz_palette({"defaultGenzPalette": "butter"})
        assert palette == {"background": "#s3edit"}, palette


def test_deleting_an_edited_year_does_not_resurrect_the_seed():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.put("holidays", "en-IN/2031", _holidays("Ops Edit"))
        b.storage.delete_calendar_asset("holidays", "en-IN/2031")
        _raises(AssetNotFoundError, asset_store.read_asset_json, "holidays", "en-IN/2031")
        assert _printed() == []


def test_deleting_a_never_edited_seeded_year_sticks():
    # Production today: the seeds exist, S3 holds nothing. Deleting a seeded
    # year used to be a no-op — the next read found no object and served the
    # seed again.
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.seed_local("calendar_styles/modern-minimalist.json", {"colors": {}})
        b.seed_local("calendar_palettes/genz/butter.json", {"background": "#local"})
        b.storage.delete_calendar_asset("holidays", "en-IN/2031")
        b.storage.delete_calendar_asset("calendar_styles", "modern-minimalist")
        b.storage.delete_calendar_asset("calendar_palettes/genz", "butter")
        _raises(AssetNotFoundError, asset_store.read_asset_json, "holidays", "en-IN/2031")
        assert _printed() == []
        assert _resolve_theme_style("modern-minimalist") is None
        assert _resolve_genz_palette({"defaultGenzPalette": "butter"}) is None


def test_put_after_delete_serves_the_new_data():
    with S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.storage.delete_calendar_asset("holidays", "en-IN/2031")
        b.put("holidays", "en-IN/2031", _holidays("Re-created"))
        assert _printed() == ["Re-created"]


def test_render_readers_raise_on_outage_so_the_render_retries():
    # Degrading to []/None here would print a calendar with no holidays (or
    # default colours) for a year that has them. render_canvas_task retries
    # any exception, then fails the job visibly.
    for error in OUTAGES:
        with S3Backend() as b:
            b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
            b.seed_local("calendar_styles/modern-minimalist.json", {"colors": {}})
            b.seed_local("calendar_palettes/genz/butter.json", {"background": "#local"})
            b.client.get_error = error
            _raises(CalendarAssetUnavailable, load_holidays_for_year, "en-IN", 2031)
            _raises(CalendarAssetUnavailable, _resolve_theme_style, "modern-minimalist")
            _raises(CalendarAssetUnavailable, _resolve_genz_palette, {"defaultGenzPalette": "butter"})


def test_render_readers_never_raise_on_missing_or_corrupt():
    with S3Backend() as b:
        # Nothing anywhere.
        assert load_holidays_for_year("en-IN", 2031) == []
        assert _resolve_theme_style("modern-minimalist") is None
        assert _resolve_genz_palette({"defaultGenzPalette": "butter"}) is None

        # Present but corrupt, or not a JSON object.
        b.put("holidays", "en-IN/2031", b"{not json")
        b.put("calendar_styles", "modern-minimalist", b"[1, 2]")
        b.put("calendar_palettes/genz", "butter", b"\xff\xfe")
        assert load_holidays_for_year("en-IN", 2031) == []
        assert _resolve_theme_style("modern-minimalist") is None
        assert _resolve_genz_palette({"defaultGenzPalette": "butter"}) is None

    # Storage backend itself can't be constructed (e.g. S3 env vars missing).
    # render_canvas_task calls get_storage() itself first, so a render never
    # gets this far in that state.
    prev = asset_store.get_storage

    def _broken():
        raise RuntimeError("storage unavailable")

    asset_store.get_storage = _broken
    try:
        assert load_holidays_for_year("en-IN", 2031) == []
        assert _resolve_theme_style("modern-minimalist") is None
        assert _resolve_genz_palette({"defaultGenzPalette": "butter"}) is None
    finally:
        asset_store.get_storage = prev


def test_bogus_names_never_reach_storage():
    with S3Backend() as b:
        assert load_holidays_for_year("../etc", 2031) == []
        assert load_holidays_for_year("en-IN/../x", 2031) == []
        assert load_holidays_for_year("en-IN", 3000) == []
        assert _resolve_theme_style("../secrets") is None
        assert _resolve_genz_palette({"defaultGenzPalette": "a/b"}) is None
        assert b.client.reads == [], b.client.reads


# ── Through the real URLconf ─────────────────────────────────────────────────

class _DictCache:
    """Stands in for the Redis cache: the views' get/set/delete only."""

    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value, timeout=None):
        self.data[key] = value

    def delete(self, key):
        self.data.pop(key, None)

    def delete_many(self, keys):
        for key in keys:
            self.delete(key)


_factory = RequestFactory()
_OPS_USER = SimpleNamespace(is_ops_team=True, is_staff=False, is_authenticated=True)


def _dispatch(method, path):
    request = getattr(_factory, method)(path)
    match = resolve(path)
    with ExitStack() as stack:
        for auth in ("BearerTokenAuthentication", "PIAAuthentication"):
            stack.enter_context(patch(
                f"api.authentication.{auth}.authenticate", return_value=(_OPS_USER, None),
            ))
        return match.func(request, **match.kwargs)


def test_ops_delete_of_a_seeded_year_is_a_404_afterwards():
    with S3Backend() as b, patch("django.core.cache.cache", _DictCache()):
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        assert _dispatch("get", "/api/holidays/en-IN/2031").status_code == 200
        assert _dispatch("delete", "/api/ops/holidays/en-IN/2031").status_code == 204
        response = _dispatch("get", "/api/holidays/en-IN/2031")
        assert response.status_code == 404, (response.status_code, response.data)
        assert _printed() == []


def test_ops_delete_that_storage_refuses_is_a_500_not_a_204():
    with S3Backend() as b, patch("django.core.cache.cache", _DictCache()):
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.client.put_error = FakeClientError("InternalError", 500)
        assert _dispatch("delete", "/api/ops/holidays/en-IN/2031").status_code == 500


def test_preview_503s_uncached_on_outage():
    with S3Backend() as b, patch("django.core.cache.cache", _DictCache()) as cache:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.seed_local("calendar_styles/modern-minimalist.json", {"name": "modern-minimalist"})
        b.client.get_error = FakeClientError("InternalError", 500)

        for path in ("/api/holidays/en-IN/2031",
                     "/api/calendar-styles/modern-minimalist",
                     "/api/calendar-styles/"):
            response = _dispatch("get", path)
            assert response.status_code == 503, (path, response.status_code)
            assert "Cache-Control" not in response, path

        # Fonts are read on every editor mount — they degrade to the defaults
        # instead of failing the editor, but aren't cached as the answer.
        response = _dispatch("get", "/api/fonts")
        assert response.status_code == 200, response.status_code
        assert response.data["fonts"], response.data
        assert cache.data == {}, cache.data

        # S3 back: the real data, not a cached outage.
        b.client.get_error = None
        response = _dispatch("get", "/api/holidays/en-IN/2031")
        assert response.status_code == 200 and response.data == _holidays("Local Seed")


def test_corrupt_style_is_a_404_not_a_500():
    for body in (b"[1, 2]", b"\x80not utf-8", b"{not json"):
        with S3Backend() as b, patch("django.core.cache.cache", _DictCache()):
            b.put("calendar_styles", "modern-minimalist", body)
            response = _dispatch("get", "/api/calendar-styles/modern-minimalist")
            assert response.status_code == 404, (body, response.status_code)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} calendar-assets-s3 tests passed.")
