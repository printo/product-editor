"""
Image overlays must resolve by `fileId` only, never by a server path in `src`.

Overlay dicts reach the renderer verbatim from the client: the render payload
(`EditorRenderView` stores `canvases` as-is in render_state), a book's
`pageOverrides`, and the autosaved editor_state the task falls back to. Until
2026-10-12 `overlay_renderer._resolve_image_path` opened any `src` that existed
on disk, so a crafted `POST /api/editor/render` could name another order's
upload or print and get its pixels composited into its own output.

Every test pairs the path-based overlay with a fileId control, so a blank
result can't pass just because nothing rendered at all.

Run stand-alone:
    cd backend/django && python -m services.tests.test_overlay_src_confinement
"""
from __future__ import annotations

import os
import sys
import tempfile

from PIL import Image

from layout_engine.engine import LayoutEngine
from services.overlay_renderer import _resolve_image_path, render_overlays

RED = (220, 0, 0)      # the other order's file — must never appear
GREEN = (0, 200, 0)    # this order's own upload — must still appear


def _solid(path: str, color: tuple, size: int = 400) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGB", (size, size), color).save(path)
    return path


def _workspace() -> dict:
    """A white photo for this order, plus a red 'victim' file standing in for
    another order's upload under the uploads tree."""
    work = tempfile.mkdtemp(prefix="pe-ovl-src-")
    return {
        "work": work,
        "white": _solid(os.path.join(work, "uploads", "THIS-ORDER", "white.png"), (255, 255, 255)),
        "victim": _solid(os.path.join(work, "uploads", "OTHER-ORDER", "photo.png"), RED),
        "green": _solid(os.path.join(work, "uploads", "THIS-ORDER", "sticker.png"), GREEN),
    }


def _count(img: Image.Image, color: tuple, tol: int = 40) -> int:
    rgb = img.convert("RGB")
    return sum(
        1 for px in rgb.getdata()
        if all(abs(a - b) <= tol for a, b in zip(px, color))
    )


def _image_overlay(**fields) -> dict:
    return {
        "type": "image", "x": 40, "y": 40, "width": 30, "height": 30,
        "rotation": 0, "opacity": 1, **fields,
    }


def _path_overlays(victim: str) -> list[dict]:
    """Every shape of `src` the old resolver would have opened."""
    return [
        _image_overlay(source="clipart", src=victim),                       # absolute
        _image_overlay(source="icon", src=os.path.relpath(victim)),         # relative to the worker's cwd
        _image_overlay(source="local", src=victim, fileId="NOT-IN-MAP"),    # fileId miss must not fall back to src
        _image_overlay(source="local", src=victim, fileId=None),
    ]


# ── _resolve_image_path ─────────────────────────────────────────────────────

def test_resolver_ignores_src_paths():
    ws = _workspace()
    for o in _path_overlays(ws["victim"]):
        got = _resolve_image_path(o, {})
        assert got is None, f"src {o['src']!r} resolved to {got!r}"


def test_resolver_ignores_non_path_src():
    for src in ("https://api.iconify.design/logos/google-icon.svg", "data:image/png;base64,AAAA",
                "blob:https://printo.in/abc", "file:///etc/hosts", ""):
        assert _resolve_image_path(_image_overlay(source="icon", src=src), {}) is None, src


def test_resolver_returns_mapped_upload_for_file_id():
    ws = _workspace()
    o = _image_overlay(source="local", fileId="UP1", src=ws["victim"])
    assert _resolve_image_path(o, {"UP1": ws["green"]}) == ws["green"], \
        "fileId must win and src must not be consulted"


# ── render_overlays ─────────────────────────────────────────────────────────

def test_render_overlays_skips_path_src_and_draws_file_id():
    ws = _workspace()
    canvas = Image.new("RGB", (200, 200), (255, 255, 255))
    overlays = _path_overlays(ws["victim"]) + [
        _image_overlay(source="local", fileId="UP1", x=0, y=0, width=20, height=20),
    ]
    render_overlays(canvas, overlays, 200, 200, {"UP1": ws["green"]})
    assert _count(canvas, RED) == 0, "another order's file was composited from a src path"
    assert _count(canvas, GREEN) > 0, "the fileId overlay should still render"


# ── Customer overlays in the render payload (render_state route) ─────────────

def test_composite_canvas_skips_path_src_in_customer_overlays():
    ws = _workspace()
    surface = {
        "canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
        "frames": [{"x": 0, "y": 0, "width": 300, "height": 300}],
    }
    engine = LayoutEngine(os.path.join(ws["work"], "l"), os.path.join(ws["work"], "e"))

    attack = engine._composite_canvas(
        surface, [ws["white"]], "cover", None, frame_transforms=[{}],
        overlays=_path_overlays(ws["victim"]), uploaded_files={},
    )
    assert _count(attack, RED) == 0, "src path rendered through the compositor"

    control = engine._composite_canvas(
        surface, [ws["white"]], "cover", None, frame_transforms=[{}],
        overlays=[_image_overlay(source="local", fileId="UP1")],
        uploaded_files={"UP1": ws["green"]},
    )
    assert _count(control, GREEN) > 0, "fileId overlay should render through the compositor"


# ── Book pageOverrides (customer-supplied surface overlays) ─────────────────
# These never pass through canvases[].overlays, so stripping that field at
# submit would not have covered them — the resolver is the only choke point.

def _tiny_book() -> dict:
    canvas = {"width": 300, "height": 300, "widthMm": 25.4, "heightMm": 25.4, "dpi": 300}
    return {
        "name": "tiny_book",
        "productType": "book",
        "book": {
            "gutterMm": 0,
            "pageCount": {"min": 2, "max": 2, "step": 2, "default": 2},
            "cover": {"canvas": canvas, "frames": [{"x": 0, "y": 0, "width": 1, "height": 1}]},
            "innerPage": {"canvas": canvas, "frames": [{"x": 0, "y": 0, "width": 1, "height": 1}]},
        },
    }


def _render_book(ws: dict, page_overlays: list[dict], uploaded_files: dict) -> list[str]:
    exports = tempfile.mkdtemp(prefix="pe-ovl-src-exports-", dir=ws["work"])
    engine = LayoutEngine(os.path.join(ws["work"], "l"), exports, layout_definition=_tiny_book())
    return engine.generate(
        "tiny_book",
        [ws["white"]],
        canvases_meta=[{"surface_key": "page_01", "frame_count": 1}],
        uploaded_files=uploaded_files,
        book_state={"page_count": 2, "page_overrides": {"1": {"overlays": page_overlays}}},
    )


def test_book_page_override_skips_path_src():
    ws = _workspace()
    outputs = _render_book(ws, _path_overlays(ws["victim"]), uploaded_files={})
    assert len(outputs) == 4, f"expected cover + 2 pages + back cover, got {outputs}"
    for path in outputs:
        with Image.open(path) as im:
            assert _count(im, RED) == 0, f"src path rendered into {os.path.basename(path)}"


def test_book_page_override_still_draws_file_id():
    ws = _workspace()
    outputs = _render_book(
        ws, [_image_overlay(source="local", fileId="UP1")], uploaded_files={"UP1": ws["green"]},
    )
    page_01 = [p for p in outputs if "Page 01" in os.path.basename(p)]
    assert page_01, f"no Page 01 output among {outputs}"
    with Image.open(page_01[0]) as im:
        assert _count(im, GREEN) > 0, "fileId overlay should render on the overridden page"


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
    print(f"All {len(funcs)} overlay-src-confinement tests passed.")


if __name__ == "__main__":
    _run_all()
