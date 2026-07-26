"""
Contract tests for DPDP erasure — see docs/DPDP_ERASURE_GAP_PRD.md.

Two defects motivated these:

  1. CanvasStateView.put passed `image_paths` in update_or_create's `defaults`.
     The editor autosaves every 2s sending only {layout_name, editor_state}, so
     `image_paths` arrived absent -> [] and was written over the recorded paths.
     Within seconds of opening the editor the only pointer to a customer's files
     was gone.

  2. purge_order_data() located uploads solely through CanvasData.image_paths /
     render_state['image_paths']. Combined with (1) — and for uploads never
     placed in a canvas at all — it deleted the rows, reported files_deleted: 0,
     and left the photographs on disk.

These are DB-free: they assert the shape of the fix (which fields are written,
which linkage exists, what the response reports) rather than exercising Django's
ORM, so they run in the same standalone harness as the rest of services/tests.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_erasure_contract
"""
from __future__ import annotations

import inspect
import re


def _canvas_state_put_source() -> str:
    from api.views import CanvasStateView
    return inspect.getsource(CanvasStateView.put)


def _purge_source() -> str:
    from api import purge
    return inspect.getsource(purge.purge_order_data)


# ── Defect 1: autosave must not blank image_paths ────────────────────────────

def test_autosave_does_not_put_image_paths_in_unconditional_defaults():
    src = _canvas_state_put_source()
    # The regression: `image_paths=image_paths or []` inside defaults(...) —
    # written on every autosave regardless of whether the caller sent paths.
    assert "image_paths=image_paths or []" not in src, (
        "image_paths is back in the unconditional defaults: every autosave will "
        "blank the recorded paths and break DPDP erasure again"
    )


def test_autosave_writes_image_paths_only_when_supplied():
    src = _canvas_state_put_source()
    assert re.search(r"if image_paths:\s*\n\s*defaults\[['\"]image_paths['\"]\]", src), (
        "expected image_paths to be added to defaults only when the caller "
        "actually supplied it"
    )


# ── Defect 2: the purge must have an order-based route to files ──────────────

def test_uploadedfile_has_an_order_linkage():
    from api.models import UploadedFile
    field = UploadedFile._meta.get_field("order_id")
    assert field is not None
    # Indexed: the purge filters on it per order.
    assert field.db_index, "order_id must be indexed — purge filters on it"
    # Blank rather than null: direct-API uploads have no order context.
    assert field.blank and field.default == "", (
        "order_id should default to blank so uploads without order context "
        "still insert cleanly"
    )


def test_purge_queries_uploads_by_order_id():
    src = _purge_source()
    assert "UploadedFile.objects.filter(order_id=order_id)" in src, (
        "purge_order_data must find uploads via the order linkage, not only via "
        "CanvasData.image_paths — that field is blanked by autosave"
    )


def test_purge_still_respects_shared_originals():
    src = _purge_source()
    # The order-linked branch must honour keep_paths, or purging one order could
    # delete an original still referenced by a surviving order.
    assert "keep_paths" in src
    assert re.search(r"linked_paths\s*=\s*\[[\s\S]{0,200}keep_paths", src), (
        "the order-linked delete must filter against keep_paths"
    )


# ── Reporting: a rows-only purge must not read as success ────────────────────

def test_purge_reports_whether_erasure_was_complete():
    src = _purge_source()
    for key in ("unlocated_upload_rows", "erasure_complete"):
        assert f"'{key}'" in src, (
            f"purge_order_data must return {key}: files_deleted: 0 alone is "
            "indistinguishable from an order that had no files"
        )


def test_purge_warns_when_erasure_is_incomplete():
    src = _purge_source()
    assert "INCOMPLETE" in src, (
        "an incomplete erasure must log a warning — silence looks identical to "
        "success"
    )


# ── Phase 4: the verification sweep ──────────────────────────────────────────

def test_purge_tracks_every_path_it_attempts_to_delete():
    src = _purge_source()
    assert "attempted_paths" in src and "attempted_dirs" in src, (
        "the sweep needs the set of paths the purge tried to remove, or it has "
        "nothing to verify against"
    )


def test_purge_verifies_and_reports_survivors():
    src = _purge_source()
    for key in ("residual_files", "residual_dirs"):
        assert f"'{key}'" in src, f"purge_order_data must return {key}"
    # A path that still exists after the delete pass must be recorded, not
    # silently ignored — an rmtree can fail on a permission error and previously
    # that passed as success.
    assert re.search(r"residual_files\.append", src), (
        "survivors must be collected, not just counted"
    )


def test_survivors_make_erasure_incomplete():
    src = _purge_source()
    # erasure_complete must depend on the sweep, not only on row counts.
    m = re.search(r"erasure_complete\s*=\s*\(([\s\S]{0,300}?)\)", src)
    assert m, "expected an erasure_complete expression"
    expr = m.group(1)
    for term in ("unlocated_rows", "residual_files", "residual_dirs", "errors"):
        assert term in expr, (
            f"erasure_complete must account for {term} — otherwise a file that "
            "survived the purge still reports as a completed erasure"
        )


# ── Per-order upload layout: traversal safety ────────────────────────────────
#
# These exist because the first draft was NOT safe. order_id permits '.' as a
# character, so '..' matched the validation regex — and the purge rmtree's the
# directory this resolves to, i.e. the parent of UPLOADS_DIR. Every dot-shaped
# input below was a live path-traversal vector.

def test_dot_shaped_order_ids_never_become_directories():
    from services.storage import NO_ORDER_BUCKET, upload_subdir
    for evil in ("..", ".", "...", "./", "../..", ".hidden"):
        assert upload_subdir(evil) == NO_ORDER_BUCKET, (
            f"{evil!r} must not be used as a directory name — it escapes or "
            "hides the uploads root"
        )


def test_separator_and_oversized_order_ids_are_rejected():
    from services.storage import NO_ORDER_BUCKET, upload_subdir
    for evil in ("a/b", "a\\b", "../../etc/passwd", "", "   ", "x" * 65):
        assert upload_subdir(evil) == NO_ORDER_BUCKET


def test_well_formed_order_ids_keep_their_own_directory():
    from services.storage import upload_subdir
    for ok in ("PE-JOB_1.2", "EXT-123", "A" * 64, "order.1-2_3"):
        assert upload_subdir(ok) == ok


def test_resolved_upload_dir_always_stays_inside_uploads_root():
    import os
    from django.conf import settings
    from services.storage import order_upload_dir

    root = os.path.realpath(settings.UPLOADS_DIR)
    for candidate in ("..", ".", "../../etc", "a/b", "", "PE-OK", "x" * 65):
        resolved = order_upload_dir(candidate)
        assert resolved == root or resolved.startswith(root + os.sep), (
            f"{candidate!r} resolved to {resolved!r}, outside {root!r} — the "
            "purge deletes this path"
        )


# ── Discovery: the purge deletes what is there, not just what rows describe ──

def test_purge_removes_the_orders_upload_directory():
    src = _purge_source()
    assert "order_upload_dir" in src, (
        "the purge must resolve the order's upload directory to do a discovery "
        "pass — without it, a file whose row was lost is unreachable"
    )
    assert "NO_ORDER_BUCKET" in src, (
        "the shared no-order bucket must be excluded from the directory delete "
        "— it holds direct-API uploads belonging to no single order"
    )


def test_uploads_are_written_per_order():
    import inspect
    from services.storage import LocalStorage
    src = inspect.getsource(LocalStorage.save_upload)
    assert "order_upload_dir" in src, (
        "save_upload must write into the order's directory, or ownership is "
        "not visible in the path and discovery cannot work"
    )


if __name__ == "__main__":
    import os
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
    django.setup()

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} erasure-contract tests passed.")
