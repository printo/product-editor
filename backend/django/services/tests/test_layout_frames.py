"""A layout with no Print Areas cannot print.

`surfaces_without_frames` is the one rule the layout save and the render
submit share, and it must agree with what the engine refuses. The worker must
fail such a job at once: a retry reads the same layout.

Run: python -m services.tests.test_layout_frames
"""
import os
import sys
import tempfile

os.environ.setdefault("DEBUG", "1")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")

import django  # noqa: E402

django.setup()

from layout_engine.engine import LayoutEngine  # noqa: E402
from services.layout_frames import (  # noqa: E402
    LayoutHasNoFrames, no_frames_message, surfaces_without_frames,
)

CANVAS = {"width": 236, "height": 295, "widthMm": 20, "heightMm": 25, "dpi": 300}
FRAME = {"x": 0, "y": 0, "width": 1, "height": 1}


def test_a_plain_layout_with_no_print_areas_is_named():
    assert surfaces_without_frames({"canvas": CANVAS, "frames": []}) == ["default"]
    assert surfaces_without_frames({"canvas": CANVAS}) == ["default"]


def test_a_plain_layout_with_a_print_area_or_a_grid_passes():
    assert surfaces_without_frames({"canvas": CANVAS, "frames": [FRAME]}) == []
    assert surfaces_without_frames({"canvas": CANVAS, "grid": {"rows": 2, "cols": 2}}) == []
    assert surfaces_without_frames({"canvas": CANVAS, "grid": {"rows": 2}}) == ["default"]


def test_each_empty_side_of_a_product_is_named():
    layout = {"type": "product", "surfaces": [
        {"key": "front", "canvas": CANVAS, "frames": [FRAME]},
        {"key": "back", "canvas": CANVAS, "frames": []},
    ]}
    assert surfaces_without_frames(layout) == ["back"]
    assert "'back'" in no_frames_message(["back"])
    layout["surfaces"][1]["frames"] = [FRAME]
    assert surfaces_without_frames(layout) == []


def test_calendars_books_and_unreadable_layouts_are_not_judged():
    assert surfaces_without_frames({"productType": "calendar", "canvas": CANVAS, "frames": []}) == []
    assert surfaces_without_frames({"productType": "book", "book": {}}) == []
    assert surfaces_without_frames(None) == []
    assert surfaces_without_frames("stamp_size_print") == []


def _engine_refuses(definition):
    with tempfile.TemporaryDirectory() as tmp:
        engine = LayoutEngine(tmp, tmp, layout_definition=definition)
        try:
            engine.generate("t", [""])
        except LayoutHasNoFrames:
            return True
        return False


def test_the_engine_refuses_exactly_what_the_rule_names():
    plain = {"name": "t", "canvas": CANVAS, "frames": []}
    assert surfaces_without_frames(plain) and _engine_refuses(plain)
    product = {"name": "t", "type": "product", "surfaces": [{"key": "front", "canvas": CANVAS, "frames": []}]}
    assert surfaces_without_frames(product) and _engine_refuses(product)
    ok = {"name": "t", "canvas": CANVAS, "frames": [FRAME]}
    assert not surfaces_without_frames(ok) and not _engine_refuses(ok)


def test_the_error_is_still_a_value_error():
    assert issubclass(LayoutHasNoFrames, ValueError)


def test_the_worker_does_not_retry_it():
    """The task must catch LayoutHasNoFrames before the general handler that retries."""
    import inspect
    from api import tasks

    src = inspect.getsource(tasks)
    own = src.index("except LayoutHasNoFrames")
    general = src.index("except Exception as exc:\n        # Determine whether we have retries left.")
    assert own < general
    branch = src[own:src.index("except SoftTimeLimitExceeded")]
    assert "self.retry" not in branch and "return" in branch
    assert "notify_caller_render_failed_task" in branch


if __name__ == "__main__":
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"  OK  {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {fn.__name__}: {exc!r}")
    print(f"\n{len(funcs) - failed}/{len(funcs)} layout-frames tests passed")
    sys.exit(1 if failed else 0)
