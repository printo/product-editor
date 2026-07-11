"""
Tests for the editor_state / render_state split (Phase 2 — "submit must not
overwrite the auto-saved design", deferred Phase 1 step 3).

Background — the bug this guards against:
    Autosave (CanvasStateView) and submit (EditorRenderView) used to share
    CanvasData.editor_state with incompatible shapes ({surfaces,...} vs
    {canvases,...}), last-writer-wins. A submit blanked the customer's
    restore state; a post-submit autosave stripped the render payload out
    from under a queued Celery job (silent wrong-print vector).

The fix gives the render pipeline its own snapshot field (render_state,
migration 0008) resolved via _resolve_render_inputs with a legacy fallback.

Run stand-alone:
    cd backend/django && python -m services.tests.test_submit_preserves_autosave
"""
from __future__ import annotations

import sys
from types import SimpleNamespace

from api.tasks import (
    _extract_backgrounds_per_canvas,
    _extract_calendar_state,
    _extract_frame_transforms,
    _extract_overlays_per_canvas,
    _resolve_render_inputs,
)


SUBMIT_SHAPE = {
    'canvases': [
        {
            'canvas_index': 0,
            'surface_key': 'front',
            'bg_color': '#112233',
            'paper_color': None,
            'frames': [
                {'frame_index': 0, 'upload_id': 'u-1', 'offset_x': -12.5,
                 'offset_y': 3.0, 'scale': 1.2, 'rotation': 90, 'fit_mode': 'cover'},
            ],
            'overlays': [{'type': 'text', 'text': 'hi', 'x': 10, 'y': 10}],
            'calendar': {'themePreset': 'modern-genz', 'calendarType': 'english',
                         'genzPalette': 'sunset', 'cells': {'2026-05-10': [{'type': 'text', 'text': 'x'}]}},
        },
    ],
    'image_paths': ['/uploads/a.png'],
    'format_version': 1,
}

AUTOSAVE_SHAPE = {
    'surfaces': [{'key': 'front', 'canvases': [{'frames': [{'fileId': 'f-1'}]}], 'globalFitMode': 'cover'}],
    'activeSurfaceKey': 'front',
    'layoutName': 'classic_4x6',
}


def test_extractors_read_submit_shape():
    tx = _extract_frame_transforms(SUBMIT_SHAPE)
    assert tx and tx[0]['scale'] == 1.2 and tx[0]['rotation'] == 90.0

    ov = _extract_overlays_per_canvas(SUBMIT_SHAPE)
    assert ov and ov[0][0]['type'] == 'text'

    bg = _extract_backgrounds_per_canvas(SUBMIT_SHAPE)
    assert bg and bg[0]['bg'] == '#112233'

    cal = _extract_calendar_state(SUBMIT_SHAPE)
    assert cal and cal['theme_preset'] == 'modern-genz'


def test_extractors_return_none_for_autosave_shape():
    """The autosave blob must never be mistaken for a render contract."""
    assert _extract_frame_transforms(AUTOSAVE_SHAPE) is None
    assert _extract_overlays_per_canvas(AUTOSAVE_SHAPE) is None
    assert _extract_backgrounds_per_canvas(AUTOSAVE_SHAPE) is None
    assert _extract_calendar_state(AUTOSAVE_SHAPE) is None


def test_render_state_wins_over_editor_state():
    """A queued job renders from the submit snapshot even after autosaves."""
    canvas = SimpleNamespace(
        render_state=SUBMIT_SHAPE,
        editor_state=AUTOSAVE_SHAPE,   # autosave landed after submit
        image_paths=[],                # autosave reset the row's paths
    )
    source, paths = _resolve_render_inputs(canvas)
    assert source is SUBMIT_SHAPE
    assert paths == ['/uploads/a.png'], "image_paths must come from the snapshot"


def test_legacy_job_falls_back_to_editor_state():
    """Jobs enqueued before the 0008 deploy hold the payload in editor_state."""
    legacy_payload = {'canvases': SUBMIT_SHAPE['canvases'], 'format_version': 1}
    canvas = SimpleNamespace(
        render_state=None,
        editor_state=legacy_payload,
        image_paths=['/uploads/legacy.png'],
    )
    source, paths = _resolve_render_inputs(canvas)
    assert source is legacy_payload
    assert paths == ['/uploads/legacy.png']
    assert _extract_frame_transforms(source)[0]['scale'] == 1.2


def test_snapshot_without_image_paths_uses_row():
    """Old render_state rows written without image_paths degrade gracefully."""
    canvas = SimpleNamespace(
        render_state={'canvases': [], 'format_version': 1},
        editor_state=None,
        image_paths=['/uploads/row.png'],
    )
    _, paths = _resolve_render_inputs(canvas)
    assert paths == ['/uploads/row.png']


def test_direct_api_caller_with_neither_field():
    """GenerateLayoutView rows have neither blob — engine falls back to fit_mode."""
    canvas = SimpleNamespace(render_state=None, editor_state=None, image_paths=['/u/x.png'])
    source, paths = _resolve_render_inputs(canvas)
    assert source is None
    assert paths == ['/u/x.png']
    assert _extract_frame_transforms(source) is None


# ─── Test runner ─────────────────────────────────────────────────────────────

def _run_all():
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"  OK  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print()
    if failed:
        print(f"{failed} test(s) failed.")
        sys.exit(1)
    print(f"All {len(funcs)} submit-preserves-autosave tests passed.")


if __name__ == "__main__":
    _run_all()
