"""
Tests that an ops edit to a calendar asset reaches the print under
STORAGE_BACKEND=s3, not just the preview.

Two defects stacked here. The render-time readers (holidays, theme style,
Gen-Z palette) opened files under STORAGE_ROOT directly, while the ops
endpoints write through `get_storage()`. And `S3Storage.read_calendar_asset`
built its key with neither the service prefix nor the `.json` suffix that
`write_calendar_asset` adds, so under S3 no read ever found what a write had
put: everything silently fell back to local disk, and an ops edit reached
neither the preview nor the print.

Each case seeds a DIFFERENT local file from the S3 object, so a reader that
still goes to disk returns the seed and fails. S3 is an in-memory stand-in
for the boto3 client — no network, no credentials.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_calendar_assets_s3
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile

import django
from django.conf import settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from services import asset_store, storage as storage_mod  # noqa: E402
from services.calendar_holidays import load_holidays_for_year  # noqa: E402
from services.calendar_layout import _resolve_genz_palette, _resolve_theme_style  # noqa: E402

BUCKET = "test-bucket"
PREFIX = "product-editor"


class _FakeS3Client:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.reads: list[str] = []

    def get_object(self, Bucket, Key):
        assert Bucket == BUCKET
        self.reads.append(Key)
        if Key not in self.objects:
            raise KeyError(f"NoSuchKey: {Key}")
        return {"Body": io.BytesIO(self.objects[Key])}

    def upload_fileobj(self, fileobj, bucket, key):
        assert bucket == BUCKET
        self.objects[key] = fileobj.read()

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


class _S3Backend:
    """Swap the process-wide storage for an S3Storage over the fake client,
    and STORAGE_ROOT for a temp dir holding the local fallback seeds."""

    def __enter__(self):
        self.client = _FakeS3Client()
        self.storage = storage_mod.S3Storage.__new__(storage_mod.S3Storage)
        self.storage.s3 = self.client
        self.storage.bucket = BUCKET
        self.storage.s3_prefix = PREFIX
        self.storage.cdn_domain = ""
        self._prev_storage = storage_mod._storage_instance
        storage_mod._storage_instance = self.storage

        self.root = tempfile.mkdtemp(prefix="pe-cal-s3-")
        self._prev_root = settings.STORAGE_ROOT
        settings.STORAGE_ROOT = self.root
        return self

    def __exit__(self, *exc):
        storage_mod._storage_instance = self._prev_storage
        settings.STORAGE_ROOT = self._prev_root
        shutil.rmtree(self.root, ignore_errors=True)

    def seed_local(self, rel_path: str, payload) -> None:
        path = os.path.join(self.root, rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(payload, f)

    def put(self, asset_type: str, name: str, payload) -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.storage.write_calendar_asset(asset_type, name, body)


def _holidays(*names):
    return {"events": [{"date": f"2031-01-{i + 1:02d}", "name": n} for i, n in enumerate(names)]}


def test_s3_read_write_and_delete_share_one_key():
    with _S3Backend() as b:
        for asset_type, name in (("holidays", "en-IN/2031"),
                                 ("calendar_styles", "modern-minimalist"),
                                 ("calendar_palettes/genz", "butter"),
                                 ("fonts", "fonts")):
            key = f"{PREFIX}/ops-config/{asset_type}/{name}.json"
            b.storage.write_calendar_asset(asset_type, name, b"{}")
            assert list(b.client.objects) == [key], b.client.objects
            assert b.storage.read_calendar_asset(asset_type, name) == b"{}"
            b.storage.delete_calendar_asset(asset_type, name)
            assert b.client.objects == {}, (asset_type, b.client.objects)


def test_holiday_edit_reaches_print_and_preview_under_s3():
    with _S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.put("holidays", "en-IN/2031", _holidays("Ops Edit"))

        printed = [ev["name"] for ev in load_holidays_for_year("en-IN", 2031)]
        previewed = [ev["name"] for ev in
                     asset_store.read_asset_json("holidays", "en-IN/2031")["events"]]
        assert printed == ["Ops Edit"], printed
        assert previewed == printed, (previewed, printed)

        b.put("holidays", "en-IN/2031", _holidays("Second Edit"))
        assert [ev["name"] for ev in load_holidays_for_year("en-IN", 2031)] == ["Second Edit"]


def test_theme_style_edit_reaches_print_under_s3():
    with _S3Backend() as b:
        b.seed_local("calendar_styles/modern-minimalist.json", {"colors": {"accent": "#local"}})
        b.put("calendar_styles", "modern-minimalist", {"colors": {"accent": "#s3edit"}})
        style = _resolve_theme_style("modern-minimalist")
        assert style == {"colors": {"accent": "#s3edit"}}, style


def test_genz_palette_reaches_print_under_s3():
    with _S3Backend() as b:
        b.seed_local("calendar_palettes/genz/butter.json", {"background": "#local"})
        b.put("calendar_palettes/genz", "butter", {"background": "#s3edit"})
        palette = _resolve_genz_palette({"defaultGenzPalette": "butter"})
        assert palette == {"background": "#s3edit"}, palette


def test_s3_miss_still_falls_back_to_local_seed():
    with _S3Backend() as b:
        b.seed_local("holidays/en-IN/2031.json", _holidays("Local Seed"))
        b.seed_local("calendar_styles/modern-minimalist.json", {"colors": {}})
        assert [ev["name"] for ev in load_holidays_for_year("en-IN", 2031)] == ["Local Seed"]
        assert _resolve_theme_style("modern-minimalist") == {"colors": {}}


def test_render_readers_never_raise():
    with _S3Backend() as b:
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
    with _S3Backend() as b:
        assert load_holidays_for_year("../etc", 2031) == []
        assert load_holidays_for_year("en-IN/../x", 2031) == []
        assert load_holidays_for_year("en-IN", 3000) == []
        assert _resolve_theme_style("../secrets") is None
        assert _resolve_genz_palette({"defaultGenzPalette": "a/b"}) is None
        assert b.client.reads == [], b.client.reads


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} calendar-assets-s3 tests passed.")
