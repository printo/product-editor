"""
Tests for where an ops mask upload lands (api/views/layout_admin.py
`_store_uploaded_masks`).

`mask` is the layout-wide mask (single-canvas and calendar layouts);
`mask_<target>` is one surface's mask on a multi-surface product, or one role's
on a book. The generic editor has always sent `mask_<surface key>`, but only
`mask` was read, so a multi-surface product's new side mask was silently
dropped. Every target is validated before any file is written.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_mask_uploads
"""
from __future__ import annotations

import os
import tempfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile

from api.views.layout_admin import _store_uploaded_masks
from services import storage as storage_mod
from services.tests.fake_s3 import S3Backend

PNG = b"\x89PNG\r\n\x1a\nfake"


def _png(name="frame.png", body=PNG):
    return SimpleUploadedFile(name, body, content_type="image/png")


class _LocalStore:
    """Swap in a LocalStorage whose masks dir is a temp dir."""

    def __enter__(self):
        self.root = tempfile.mkdtemp(prefix="pe-maskup-")
        self._prev_dir = settings.LAYOUTS_DIR
        settings.LAYOUTS_DIR = os.path.join(self.root, "layouts")
        self._prev = storage_mod._storage_instance
        storage_mod._storage_instance = storage_mod.LocalStorage()
        return self

    def __exit__(self, *exc):
        storage_mod._storage_instance = self._prev
        settings.LAYOUTS_DIR = self._prev_dir

    def masks(self):
        return sorted(os.listdir(os.path.join(self.root, "masks")))


def _raises(fn, needle):
    try:
        fn()
    except ValueError as exc:
        assert needle in str(exc), f"{needle!r} not in {exc!r}"
    else:
        raise AssertionError("expected ValueError")


def test_layout_wide_mask_sets_root_mask_url():
    layout = {"canvas": {"width": 10, "height": 10}}
    with _LocalStore() as st:
        _store_uploaded_masks({"mask": _png()}, "a4_frame", layout)
        assert st.masks() == ["a4_frame_mask.png"]
    assert layout["maskUrl"] == "/api/layouts/masks/a4_frame_mask.png"


def test_surface_mask_sets_that_surface_only():
    layout = {"type": "product", "surfaces": [{"key": "front"}, {"key": "back"}]}
    with _LocalStore() as st:
        _store_uploaded_masks({"mask_back": _png()}, "sleeve", layout)
        assert st.masks() == ["sleeve_back_mask.png"]
    assert layout["surfaces"][1]["maskUrl"] == "/api/layouts/masks/sleeve_back_mask.png"
    assert "maskUrl" not in layout["surfaces"][0]
    assert "maskUrl" not in layout


def test_book_role_masks_set_each_role():
    layout = {"productType": "book", "book": {"cover": {}, "innerPage": {}, "backCover": {}}}
    with _LocalStore():
        _store_uploaded_masks({"mask_cover": _png(), "mask_innerPage": _png()}, "photobook", layout)
    assert layout["book"]["cover"]["maskUrl"] == "/api/layouts/masks/photobook_cover_mask.png"
    assert layout["book"]["innerPage"]["maskUrl"] == "/api/layouts/masks/photobook_innerPage_mask.png"
    assert "maskUrl" not in layout["book"]["backCover"]


def test_book_without_a_back_cover_rejects_its_mask():
    layout = {"productType": "book", "book": {"cover": {}, "innerPage": {}}}
    with _LocalStore() as st:
        _raises(lambda: _store_uploaded_masks({"mask_backCover": _png()}, "photobook", layout),
                "cover, innerPage only")
        assert not os.path.exists(os.path.join(st.root, "masks")) or st.masks() == []


def test_unknown_surface_is_rejected_not_dropped():
    layout = {"type": "product", "surfaces": [{"key": "front"}]}
    with _LocalStore():
        _raises(lambda: _store_uploaded_masks({"mask_side": _png()}, "sleeve", layout),
                "no surface with that key")


def test_a_bad_target_writes_nothing_even_after_a_good_one():
    layout = {"type": "product", "surfaces": [{"key": "front"}]}
    with _LocalStore() as st:
        files = {"mask_front": _png(), "mask_nope": _png()}
        _raises(lambda: _store_uploaded_masks(files, "sleeve", layout), "no surface")
        assert not os.path.exists(os.path.join(st.root, "masks")) or st.masks() == []
    assert "maskUrl" not in layout["surfaces"][0]


def test_non_png_is_rejected():
    layout = {"canvas": {"width": 10, "height": 10}}
    with _LocalStore():
        _raises(lambda: _store_uploaded_masks({"mask": _png("frame.jpg")}, "a4", layout), "PNG")


def test_odd_field_names_are_rejected():
    layout = {"type": "product", "surfaces": [{"key": "front"}]}
    with _LocalStore():
        _raises(lambda: _store_uploaded_masks({"mask_../x": _png()}, "a4", layout), "Invalid mask field")


def test_other_upload_fields_are_ignored():
    layout = {"canvas": {"width": 10, "height": 10}}
    with _LocalStore():
        _store_uploaded_masks({"thumbnail": _png()}, "a4", layout)
    assert "maskUrl" not in layout


def test_s3_upload_uses_the_key_the_preview_and_print_read():
    layout = {"productType": "book", "book": {"cover": {}, "innerPage": {}}}
    with S3Backend() as s3:
        _store_uploaded_masks({"mask_cover": _png()}, "photobook", layout)
        assert s3.client.objects["product-editor/masks/photobook_cover_mask.png"] == PNG
    assert layout["book"]["cover"]["maskUrl"] == "/api/layouts/masks/photobook_cover_mask.png"


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
