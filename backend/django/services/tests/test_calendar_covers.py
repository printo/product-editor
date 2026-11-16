"""
Front and back cover sheets on a calendar: the pure helpers, the validator,
and one end-to-end render through the real engine (order, names, and that each
cover and month gets its own photos).

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_calendar_covers
"""
from __future__ import annotations

import os
import sys
import tempfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.core.exceptions import ValidationError
from PIL import Image

from api.validators import validate_calendar_layout
from layout_engine.engine import LayoutEngine
from services import calendar_covers as cc

RED, GREEN, BLUE, YELLOW, WHITE = (255, 0, 0), (0, 160, 0), (0, 0, 255), (255, 220, 0), (255, 255, 255)


def _near(a, b, tol=14):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b))


def _cover(frames=1, w=400, h=600):
    return {
        "canvas": {"width": w, "height": h, "dpi": 254},
        "frames": [{"x": 0.1, "y": 0.1 + i * 0.4, "width": 0.8, "height": 0.35} for i in range(frames)],
        "overlays": [],
    }


def _calendar(front=True, back=True) -> dict:
    layout = {
        "productType": "calendar",
        "canvas": {"width": 600, "height": 800, "dpi": 254},
        "frames": [{"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.3}],
        "calendars": [{"x": 0.05, "y": 0.45, "width": 0.9, "height": 0.5}],
        "calendar": {"themePreset": "modern-minimalist", "calendarType": "english", "weekStart": "sunday"},
        "monthRange": {"count": 12, "defaultYear": 2026},
    }
    if front:
        layout["frontCover"] = _cover(frames=2)
    if back:
        layout["backCover"] = _cover(frames=1)
    return layout


def _invalid(layout, fragment):
    try:
        validate_calendar_layout(layout)
    except ValidationError as exc:
        assert fragment in exc.messages[0], exc.messages
        return
    raise AssertionError(f"expected a ValidationError mentioning {fragment!r}")


# ── Pure helpers ────────────────────────────────────────────────────────────

def test_covers_present_in_print_order():
    assert cc.cover_keys_present(_calendar()) == ["cover_front", "cover_back"]
    assert cc.cover_keys_present(_calendar(back=False)) == ["cover_front"]
    assert cc.cover_keys_present(_calendar(front=False, back=False)) == []


def test_numbered_label_sorts_in_print_order():
    labels = [cc.numbered_label(i, n) for i, n in enumerate(["Front Cover", "January 2026", "December 2026", "Back Cover"])]
    assert sorted(labels) == labels
    assert labels[0] == "00 Front Cover"


def test_split_payload_takes_covers_out_of_the_month_slicing():
    meta = [
        {"surface_key": "cover_front", "frame_count": 2},
        {"surface_key": "month_01", "frame_count": 1},
        {"surface_key": "cover_back", "frame_count": 1},
    ]
    months, covers = cc.split_payload(meta, ["f0", "f1", "m0", "b0"], None, [[1], [2], [3]], None)
    assert months["images"] == ["m0"] and months["overlays"] == [[2]]
    assert covers["cover_front"]["images"] == ["f0", "f1"]
    assert covers["cover_back"]["images"] == ["b0"] and covers["cover_back"]["overlays"] == [[3]]


def test_sheet_labels_match_the_shared_fixture():
    import json
    from django.conf import settings
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "calendar-cover-order.json")
    for case in json.load(open(path))["cases"]:
        layout = _calendar(front=case["hasFront"], back=case["hasBack"])
        assert cc.sheet_labels(layout, case["months"]) == case["expected"], case["name"]


# ── Validator ───────────────────────────────────────────────────────────────

def test_a_calendar_with_both_covers_validates():
    validate_calendar_layout(_calendar())


def test_a_cover_needs_a_canvas_and_a_frame():
    bad = _calendar(); bad["frontCover"]["canvas"] = {"width": 0, "height": 10}
    _invalid(bad, "frontCover.canvas.width")
    bad = _calendar(); bad["backCover"]["frames"] = []
    _invalid(bad, "backCover.frames")


def test_a_cover_frame_must_stay_on_its_canvas():
    bad = _calendar(); bad["frontCover"]["frames"][0]["width"] = 1.4
    _invalid(bad, "extends past")


def test_a_cover_must_be_an_object():
    bad = _calendar(); bad["backCover"] = "nope"
    _invalid(bad, "backCover must be an object")


# ── Real render ─────────────────────────────────────────────────────────────

def _solid(work, name, color):
    path = os.path.join(work, name)
    Image.new("RGB", (300, 300), color).save(path)
    return path


def _render(layout, work):
    exports = os.path.join(work, "exports", "job")
    os.makedirs(exports, exist_ok=True)
    engine = LayoutEngine(os.path.join(work, "layouts"), exports, layout_definition=layout)
    front_a, front_b = _solid(work, "fa.png", RED), _solid(work, "fb.png", GREEN)
    month = _solid(work, "m.png", BLUE)
    back = _solid(work, "b.png", YELLOW)
    meta = [{"surface_key": "cover_front", "frame_count": 2}, {"surface_key": "month_01", "frame_count": 1}]
    paths = [front_a, front_b, month]
    if "backCover" in layout:
        meta.append({"surface_key": "cover_back", "frame_count": 1})
        paths.append(back)
    outputs = engine.generate("cal_cover_test", paths, canvases_meta=meta,
                              calendar_state={"num_canvases": len(meta)})
    return sorted(os.path.basename(o) for o in outputs), {os.path.basename(o): o for o in outputs}


def test_render_orders_and_names_every_sheet():
    work = tempfile.mkdtemp(prefix="pe-cover-")
    names, _ = _render(_calendar(), work)
    assert len(names) == 14, names
    assert names[0].startswith("00 Front Cover")
    assert names[1].startswith("01 January 2026")
    assert names[-1].startswith("13 Back Cover")


def test_each_sheet_gets_its_own_photos_and_canvas():
    work = tempfile.mkdtemp(prefix="pe-cover-")
    _, by_name = _render(_calendar(), work)
    front = Image.open(next(p for n, p in by_name.items() if "Front Cover" in n)).convert("RGB")
    back = Image.open(next(p for n, p in by_name.items() if "Back Cover" in n)).convert("RGB")
    month = Image.open(next(p for n, p in by_name.items() if "January 2026" in n)).convert("RGB")
    assert front.size == (400, 600) and back.size == (400, 600) and month.size == (600, 800)
    assert _near(front.getpixel((200, 120)), RED) and _near(front.getpixel((200, 360)), GREEN)
    assert _near(back.getpixel((200, 120)), YELLOW)
    assert _near(month.getpixel((300, 120)), BLUE)
    # Month photos never leak onto a cover, nor cover photos onto a month.
    assert not _near(front.getpixel((200, 120)), BLUE)


def test_no_covers_prints_as_before():
    work = tempfile.mkdtemp(prefix="pe-cover-")
    layout = _calendar(front=False, back=False)
    exports = os.path.join(work, "exports", "job")
    os.makedirs(exports, exist_ok=True)
    engine = LayoutEngine(os.path.join(work, "layouts"), exports, layout_definition=layout)
    outputs = engine.generate("cal_cover_test", [_solid(work, "m.png", BLUE)])
    names = sorted(os.path.basename(o) for o in outputs)
    assert len(names) == 12
    assert any(n.startswith("January 2026") for n in names) and not any(n[:2].isdigit() for n in names)


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  OK  {name}")
        except Exception as exc:  # noqa: BLE001
            print(f"  FAIL {name}: {exc!r}")
            failed += 1
    sys.exit(1 if failed else 0)
