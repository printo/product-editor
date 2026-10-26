"""
The print follows the layout's bleed area, and the one mask with a "Mask on
Export" switch became two placement slots (services/print_sheet.py).

Catalog Ops, 2026-10-26: a physical photo frame needs a print of the bleed
area only (the visible window grown by the strip hidden under the frame),
while the customer preview and the storefront mock still show the frame
picture. Everything here is pinned end to end through the real engine with
Pillow: pixel sizes, which pixels carry the photo, which carry a mask, and
that a layout nobody touched prints byte for byte as before.

Needs Pillow and Django settings (run in the backend container):
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend \
        -m services.tests.test_print_sheet
"""
from __future__ import annotations

import os
import tempfile

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from PIL import Image

from layout_engine.engine import LayoutEngine
from services.layout_orientation import apply_orientation
from services.print_sheet import (
    normalize_mask_slots, resolve_mask_slots, resolve_print_box, validate_print_sheet,
    with_legacy_mask_fields,
)

RED, BLUE, WHITE = (255, 0, 0), (0, 0, 255), (255, 255, 255)
BROWN = (120, 70, 36)     # the wooden frame picture
GOLD = (212, 175, 55)     # printed artwork around the window

# A 100 x 150 mm canvas at 10 px/mm, so mm and px read easily.
CANVAS = {"width": 1000, "height": 1500, "widthMm": 100, "heightMm": 150, "dpi": 254}


def _near(a, b, tol=10):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b))


def _frame(x_mm, y_mm, w_mm, h_mm, bleed_mm, fid="a"):
    """A frame as the ops editor stores it: the fraction rect is the window
    grown by its bleed on every side (page.tsx `_mapFrames`)."""
    return {
        "id": fid,
        "x": (x_mm - bleed_mm) / 100, "y": (y_mm - bleed_mm) / 150,
        "width": (w_mm + 2 * bleed_mm) / 100, "height": (h_mm + 2 * bleed_mm) / 150,
        "xMm": x_mm, "yMm": y_mm, "widthMm": w_mm, "heightMm": h_mm, "bleedMm": bleed_mm,
    }


def _solid(path, color, size=(300, 450)):
    Image.new("RGB", size, color).save(path)
    return path


def _save_mask(work, name, size, paint):
    """`paint(draw-target RGBA image)`; saved under <work>/masks so the engine
    finds it on local disk."""
    os.makedirs(os.path.join(work, "masks"), exist_ok=True)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    paint(img)
    img.save(os.path.join(work, "masks", name))
    return f"/api/layouts/masks/{name}"


def _frame_picture(work, name="frame_picture.png"):
    """A brown frame covering everything but the 10..90 x 15..135 mm window,
    so its pixels overlap the bleed ring of a window at 20..80 x 30..120."""
    def paint(img):
        img.paste(BROWN + (255,), (0, 0, 1000, 1500))
        img.paste((0, 0, 0, 0), (100, 150, 900, 1350))
    return _save_mask(work, name, (1000, 1500), paint)


def _artwork(work, name="artwork.png"):
    """Gold artwork in the bleed ring with a clear hole over the window."""
    def paint(img):
        img.paste(GOLD + (255,), (150, 250, 850, 1250))
        img.paste((0, 0, 0, 0), (200, 300, 800, 1200))
    return _save_mask(work, name, (1000, 1500), paint)


def _render(work, definition, photos=None, name="sheet_test", **kwargs):
    exports = os.path.join(work, "exports", definition.get("name", name))
    os.makedirs(exports, exist_ok=True)
    engine = LayoutEngine(os.path.join(work, "layouts"), exports, layout_definition=definition)
    photos = photos or [_solid(os.path.join(work, "red.png"), RED)]
    return engine.generate(definition.get("name", name), photos, **kwargs)


def _mock_path(print_path):
    return os.path.splitext(print_path)[0] + "_preview.jpg"


def _one_window(bleed=3, **extra):
    return {
        "name": "one_window",
        "canvas": dict(CANVAS),
        "frames": [_frame(20, 30, 60, 90, bleed)],
        **extra,
    }


# ── Slot resolution ─────────────────────────────────────────────────────────

def test_legacy_pair_maps_to_the_right_slot():
    assert resolve_mask_slots({"maskUrl": "/m.png", "maskOnExport": True}) == (None, "/m.png")
    assert resolve_mask_slots({"maskUrl": "/m.png", "maskOnExport": False}) == ("/m.png", None)
    assert resolve_mask_slots({"maskUrl": "/m.png"}) == ("/m.png", None)
    assert resolve_mask_slots({}) == (None, None)
    assert resolve_mask_slots({"frameMaskUrl": "/f.png", "artworkMaskUrl": "/a.png"}) == ("/f.png", "/a.png")
    # Two empty new keys next to a legacy mask (every read adds them) never hide it.
    assert resolve_mask_slots({"frameMaskUrl": None, "artworkMaskUrl": None, "maskUrl": "/m.png", "maskOnExport": True}) == (None, "/m.png")


def test_normalising_stores_the_slots_and_drops_the_legacy_pair():
    block = {"maskUrl": "/m.png", "maskOnExport": True, "canvas": {}}
    normalize_mask_slots(block)
    assert block == {"frameMaskUrl": None, "artworkMaskUrl": "/m.png", "canvas": {}}


def test_every_response_carries_both_slots_and_the_derived_legacy_pair():
    out = with_legacy_mask_fields({"name": "x", "maskUrl": "/m.png", "maskOnExport": True})
    assert (out["frameMaskUrl"], out["artworkMaskUrl"]) == (None, "/m.png")
    assert (out["maskUrl"], out["maskOnExport"]) == ("/m.png", True)
    both = with_legacy_mask_fields({"frameMaskUrl": "/f.png", "artworkMaskUrl": "/a.png"})
    # The legacy pair can name one URL: the frame picture every preview shows on top.
    assert (both["maskUrl"], both["maskOnExport"]) == ("/f.png", False)
    surf = with_legacy_mask_fields({"type": "product", "surfaces": [{"key": "front", "maskUrl": "/s.png"}]})
    assert surf["surfaces"][0]["frameMaskUrl"] == "/s.png" and surf["surfaces"][0]["maskOnExport"] is False
    src = {"book": {"cover": {"maskUrl": "/c.png", "maskOnExport": True}}}
    out = with_legacy_mask_fields(src)
    assert out["book"]["cover"]["artworkMaskUrl"] == "/c.png"
    assert "frameMaskUrl" not in src["book"]["cover"], "the cached input must not be touched"


# ── Validation ──────────────────────────────────────────────────────────────

def test_print_sheet_validation():
    canvas = dict(CANVAS)
    assert validate_print_sheet({}, canvas) is None
    assert validate_print_sheet({"printSheet": {"mode": "canvas"}}, canvas) == {"mode": "canvas"}
    assert validate_print_sheet({"printSheet": {"mode": "bleed"}}, canvas) == {"mode": "bleed"}
    typed = validate_print_sheet({"printSheet": {"mode": "bleed", "xMm": 10, "yMm": 10, "widthMm": 80, "heightMm": 130, "bleedMm": 2}}, canvas)
    assert typed == {"mode": "bleed", "xMm": 10.0, "yMm": 10.0, "widthMm": 80.0, "heightMm": 130.0, "bleedMm": 2.0}
    for bad, needle in (
        ({"mode": "window"}, "mode"),
        ({"mode": "bleed", "xMm": 1, "yMm": 1, "widthMm": 10}, "all of"),
        ({"mode": "bleed", "xMm": "1", "yMm": 1, "widthMm": 10, "heightMm": 10}, "number"),
        ({"mode": "bleed", "xMm": 1, "yMm": 1, "widthMm": 0, "heightMm": 10}, "positive"),
        ({"mode": "bleed", "xMm": 1, "yMm": 1, "widthMm": 10, "heightMm": 10, "bleedMm": -1}, "bleedMm"),
        ({"mode": "bleed", "xMm": 1, "yMm": 1, "widthMm": 10, "heightMm": 10, "bleedMm": 2}, "outside"),
        ({"mode": "bleed", "xMm": 50, "yMm": 10, "widthMm": 60, "heightMm": 10}, "outside"),
        ("bleed", "object"),
    ):
        try:
            validate_print_sheet({"printSheet": bad}, canvas)
        except ValueError as exc:
            assert needle in str(exc), (bad, exc)
        else:
            raise AssertionError(f"{bad!r} should be refused")


def test_the_print_box_is_the_windows_bleed_area_in_pixels():
    frames = LayoutEngine._normalize_frames(_one_window(bleed=3)["frames"], 1000, 1500)
    assert resolve_print_box({"canvas": dict(CANVAS), "frames": frames, "printSheet": {"mode": "bleed"}}) == (170, 270, 830, 1230)
    assert resolve_print_box({"canvas": dict(CANVAS), "frames": frames}) is None
    assert resolve_print_box({"canvas": dict(CANVAS), "frames": frames, "printSheet": {"mode": "canvas"}}) is None
    typed = {"mode": "bleed", "xMm": 10, "yMm": 20, "widthMm": 80, "heightMm": 110, "bleedMm": 2}
    assert resolve_print_box({"canvas": dict(CANVAS), "frames": frames, "printSheet": typed}) == (80, 180, 920, 1320)
    # A window filling the whole canvas prints the whole canvas.
    full = LayoutEngine._normalize_frames([_frame(0, 0, 100, 150, 0)], 1000, 1500)
    assert resolve_print_box({"canvas": dict(CANVAS), "frames": full, "printSheet": {"mode": "bleed"}}) is None


# ── The print ───────────────────────────────────────────────────────────────

def test_one_window_prints_its_bleed_area_without_the_frame_picture():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = _one_window(bleed=3, printSheet={"mode": "bleed"}, frameMaskUrl=_frame_picture(work))
    (out,) = _render(work, layout)
    with Image.open(out) as img:
        # 60 x 90 mm window + 3 mm bleed each side = 66 x 96 mm = 660 x 960 px
        assert img.size == (660, 960), img.size
        rgb = img.convert("RGB")
        assert _near(rgb.getpixel((330, 480)), RED), "the photo fills the window"
        # The frame picture overlaps the bleed ring (its window is 10..90 mm
        # wide, the sheet 17..83) and must still be absent from every corner.
        for px in ((2, 2), (657, 2), (2, 957), (657, 957)):
            assert _near(rgb.getpixel(px), RED), f"frame picture leaked into the print at {px}: {rgb.getpixel(px)}"
    with Image.open(_mock_path(out)) as mock:
        # The mock is the customer preview: the full canvas with the frame on it.
        assert mock.size == (400, 600), mock.size
        assert _near(mock.getpixel((10, 10)), BROWN), mock.getpixel((10, 10))
        assert _near(mock.getpixel((200, 300)), RED)


def test_two_windows_print_on_one_sheet_spanning_both():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = {
        "name": "two_windows",
        "canvas": dict(CANVAS),
        "frames": [_frame(10, 20, 35, 50, 2, "a"), _frame(55, 80, 35, 50, 2, "b")],
        "printSheet": {"mode": "bleed"},
        "frameMaskUrl": _frame_picture(work),
    }
    photos = [_solid(os.path.join(work, "red.png"), RED), _solid(os.path.join(work, "blue.png"), BLUE)]
    (out,) = _render(work, layout, photos)
    with Image.open(out) as img:
        # From (8, 18) mm to (92, 132) mm: 84 x 114 mm
        assert img.size == (840, 1140), img.size
        rgb = img.convert("RGB")
        # window a at 10..45 x 20..70 mm → sheet-relative (20..370, 20..520)
        assert _near(rgb.getpixel((190, 270)), RED), rgb.getpixel((190, 270))
        # window b at 55..90 x 80..130 mm → sheet-relative (470..820, 620..1120)
        assert _near(rgb.getpixel((640, 870)), BLUE), rgb.getpixel((640, 870))
        # between the windows: the canvas colour, not the frame picture
        assert _near(rgb.getpixel((420, 570)), WHITE), rgb.getpixel((420, 570))


def test_a_typed_bleed_area_prints_the_artwork_inside_it_and_never_the_frame():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = _one_window(
        bleed=0,
        printSheet={"mode": "bleed", "xMm": 15, "yMm": 25, "widthMm": 70, "heightMm": 100, "bleedMm": 0},
        artworkMaskUrl=_artwork(work),
        frameMaskUrl=_frame_picture(work),
    )
    (out,) = _render(work, layout)
    with Image.open(out) as img:
        assert img.size == (700, 1000), img.size
        rgb = img.convert("RGB")
        assert _near(rgb.getpixel((20, 20)), GOLD), f"artwork should print in the ring: {rgb.getpixel((20, 20))}"
        assert _near(rgb.getpixel((350, 500)), RED), "the photo shows through the artwork's hole"
        assert not _near(rgb.getpixel((2, 2)), BROWN), "the frame picture never prints"
    with Image.open(_mock_path(out)) as mock:
        assert mock.size == (400, 600)
        assert _near(mock.getpixel((10, 10)), BROWN), "the mock keeps the frame picture"
        assert _near(mock.getpixel((70, 110)), GOLD), f"the mock keeps the artwork: {mock.getpixel((70, 110))}"


def test_a_legacy_mask_on_export_layout_prints_byte_identically():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    mask_url = _artwork(work)
    legacy = _one_window(bleed=0, maskUrl=mask_url, maskOnExport=True)
    legacy["name"] = "legacy_on"
    converted = _one_window(bleed=0, artworkMaskUrl=mask_url, printSheet={"mode": "canvas"})
    converted["name"] = "converted_on"
    (a,) = _render(work, legacy)
    (b,) = _render(work, converted)
    with open(a, "rb") as fa, open(b, "rb") as fb:
        assert fa.read() == fb.read(), "the same artwork on the whole canvas must be the same file"
    with open(_mock_path(a), "rb") as fa, open(_mock_path(b), "rb") as fb:
        assert fa.read() == fb.read()
    with Image.open(a) as img:
        assert img.size == (1000, 1500)
        assert _near(img.convert("RGB").getpixel((160, 260)), GOLD)


def test_a_legacy_preview_only_mask_is_absent_from_the_print_and_present_in_the_mock():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = _one_window(bleed=0, maskUrl=_frame_picture(work), maskOnExport=False)
    (out,) = _render(work, layout)
    with Image.open(out) as img:
        assert img.size == (1000, 1500)
        rgb = img.convert("RGB")
        assert _near(rgb.getpixel((10, 10)), WHITE), rgb.getpixel((10, 10))
        assert _near(rgb.getpixel((500, 750)), RED)
    with Image.open(_mock_path(out)) as mock:
        assert _near(mock.getpixel((10, 10)), BROWN), mock.getpixel((10, 10))


def test_the_mock_of_a_cropped_layout_keeps_the_full_canvas_and_both_masks():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = _one_window(bleed=3, printSheet={"mode": "bleed"}, frameMaskUrl=_frame_picture(work), artworkMaskUrl=_artwork(work))
    (out,) = _render(work, layout)
    with Image.open(out) as img:
        assert img.size == (660, 960)
    with Image.open(_mock_path(out)) as mock:
        assert mock.size == (400, 600), "600 px long edge at the canvas's 2:3 aspect"
        assert mock.format == "JPEG"
        assert _near(mock.getpixel((10, 10)), BROWN), "frame picture"
        assert _near(mock.getpixel((70, 110)), GOLD), f"artwork: {mock.getpixel((70, 110))}"
        assert _near(mock.getpixel((200, 300)), RED), "photo"


def test_a_turned_typed_layout_crops_the_turned_rectangle():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = _one_window(bleed=0, printSheet={"mode": "bleed", "xMm": 10, "yMm": 20, "widthMm": 60, "heightMm": 100, "bleedMm": 2})
    turned, report = apply_orientation(layout, "landscape")
    assert report["applied"] is True
    sheet = turned["printSheet"]
    # (x, y, w, h) → (H - y - h, x, h, w) with H = 150 mm
    assert (sheet["xMm"], sheet["yMm"], sheet["widthMm"], sheet["heightMm"], sheet["bleedMm"]) == (30, 10, 100, 60, 2)
    (out,) = _render(work, turned)
    with Image.open(out) as img:
        # 104 x 64 mm with the bleed, on a 150 x 100 mm turned canvas
        assert img.size == (1040, 640), img.size
        rgb = img.convert("RGB")
        assert _near(rgb.getpixel((520, 320)), RED)
    # From the photo windows there is nothing to turn: the box follows the frames.
    from_windows, _ = apply_orientation(_one_window(bleed=3, printSheet={"mode": "bleed"}), "landscape")
    assert from_windows["printSheet"] == {"mode": "bleed"}
    (out2,) = _render(work, {**from_windows, "name": "turned_windows"})
    with Image.open(out2) as img:
        assert img.size == (960, 660), img.size


def test_a_multi_surface_product_gets_its_own_bleed_area_per_surface():
    work = tempfile.mkdtemp(prefix="pe-sheet-")
    layout = {
        "name": "two_sided",
        "type": "product",
        "surfaces": [
            {"key": "front", "label": "Front", "canvas": dict(CANVAS),
             "frames": [_frame(20, 30, 60, 90, 3)], "printSheet": {"mode": "bleed"},
             "frameMaskUrl": _frame_picture(work)},
            {"key": "back", "label": "Back", "canvas": dict(CANVAS),
             "frames": [_frame(10, 10, 80, 130, 0)],
             "printSheet": {"mode": "bleed", "xMm": 5, "yMm": 5, "widthMm": 90, "heightMm": 140, "bleedMm": 0}},
        ],
    }
    # One canvas per side, grouped by surface key as the editor submits it.
    outputs = _render(
        work, layout, [_solid(os.path.join(work, "red.png"), RED), _solid(os.path.join(work, "blue.png"), BLUE)],
        canvases_meta=[{"surface_key": "front", "frame_count": 1}, {"surface_key": "back", "frame_count": 1}],
    )
    assert len(outputs) == 2, outputs
    sizes = {os.path.basename(p): Image.open(p).size for p in outputs}
    assert sizes == {"two_sided_front_1.png": (660, 960), "two_sided_back_1.png": (900, 1400)}, sizes
    with Image.open(outputs[0]) as front, Image.open(outputs[1]) as back:
        assert _near(front.convert("RGB").getpixel((330, 480)), RED)
        assert _near(back.convert("RGB").getpixel((450, 700)), BLUE)
        assert not _near(front.convert("RGB").getpixel((2, 2)), BROWN), "the front's frame picture never prints"


def test_a_calendar_keeps_its_single_mask_and_ignores_the_print_sheet():
    """Calendars are materialised from their template: the one legacy mask
    reaches each month as before and a `printSheet` on the template is not
    copied, so every month page prints whole."""
    from services.calendar_layout import materialize_surfaces
    layout = {
        "name": "cal", "productType": "calendar",
        "canvas": dict(CANVAS), "frames": [_frame(20, 30, 60, 90, 3)],
        "monthRange": {"count": 12, "defaultYear": 2026},
        "calendars": [{"x": 0.1, "y": 0.75, "width": 0.8, "height": 0.2, "monthOffset": 0}],
        "maskUrl": "/api/layouts/masks/cal_mask.png", "maskOnExport": True,
        "printSheet": {"mode": "bleed"},
    }
    surfaces = materialize_surfaces(layout)
    assert len(surfaces) == 12
    assert all("printSheet" not in s for s in surfaces)
    assert resolve_mask_slots(surfaces[0]) == (None, "/api/layouts/masks/cal_mask.png")
    assert resolve_print_box({**surfaces[0], "frames": LayoutEngine._normalize_frames(surfaces[0]["frames"], 1000, 1500)}) is None


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
