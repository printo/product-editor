"""SVG layout masks: validation on upload, and a sharp raster at print size.

An SVG mask is drawn at the canvas's exact pixel size instead of being a
fixed bitmap stretched to it, so a thin edge is as crisp on a large canvas as
on a small one. Upload refuses anything that runs code or reaches outside the
file.

Run stand-alone:
    cd backend/django && DJANGO_SETTINGS_MODULE=product_editor.settings DEBUG=1 \
        python -m services.tests.test_svg_mask
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
from services import storage as storage_mod
from services.svg_mask import normalize_svg_mask, rasterize_svg_mask, validate_svg_mask
from services.tests.fake_s3 import S3Backend

# A brown frame, 10% border, with a transparent window (even-odd cutout).
FRAME_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150">'
    b'<path fill="#784624" fill-rule="evenodd" '
    b'd="M0 0H100V150H0Z M10 10V140H90V10Z"/></svg>'
)


def _refused(svg: bytes, needle: str) -> None:
    try:
        validate_svg_mask(svg)
    except ValueError as exc:
        assert needle in str(exc), f"{exc!r} should mention {needle!r}"
    else:
        raise AssertionError(f"should have refused: {svg[:60]!r}")


def test_a_plain_svg_passes():
    validate_svg_mask(FRAME_SVG)


def test_scripts_and_event_handlers_are_refused():
    _refused(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>x()</script></svg>', "scripts")
    _refused(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect onload="x()" width="1" height="1"/></svg>', "scripts")
    _refused(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><foreignObject/></svg>', "scripts")


def test_external_links_and_entities_are_refused():
    _refused(b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><image href="http://x/y.png"/></svg>', "outside")
    _refused(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:url(http://x/g)"/></svg>', "outside")
    _refused(b'<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', "DOCTYPE")


def test_internal_references_and_embedded_images_are_allowed():
    validate_svg_mask(
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g">'
        b'<stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>'
    )


def test_not_an_svg_or_no_size_is_refused():
    _refused(b"\x89PNG\r\n\x1a\n", "not a valid SVG")
    _refused(b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', "viewBox")


def test_it_draws_at_exactly_the_canvas_size_with_a_clear_window():
    img = rasterize_svg_mask(FRAME_SVG, 600, 900)
    assert img.mode == "RGBA" and img.size == (600, 900)
    assert img.getpixel((10, 10))[:3] == (120, 70, 36) and img.getpixel((10, 10))[3] == 255
    assert img.getpixel((300, 450))[3] == 0, "the window must stay transparent"


def test_the_artwork_is_stretched_to_the_canvas_like_the_preview():
    # A canvas twice as wide as the viewBox: the 10% border scales with it.
    img = rasterize_svg_mask(FRAME_SVG, 200, 150)
    assert img.getpixel((15, 75))[3] == 255, "left border 10% of 200px"
    assert img.getpixel((30, 75))[3] == 0


def test_an_edge_is_crisp_at_print_size():
    # Hairline window edge: a PNG scaled up would smear it over several pixels.
    img = rasterize_svg_mask(FRAME_SVG, 2400, 3600)
    row = [img.getpixel((x, 1800))[3] for x in range(230, 250)]
    soft = [a for a in row if 0 < a < 255]
    assert len(soft) <= 1, f"edge should be one pixel wide, got {row}"


def test_a_viewbox_only_svg_gets_a_pixel_size_for_the_preview():
    out = normalize_svg_mask(FRAME_SVG)
    assert b'width="100"' in out and b'height="150"' in out and b"viewBox" in out
    validate_svg_mask(out)
    img = rasterize_svg_mask(out, 200, 300)
    assert img.size == (200, 300) and img.getpixel((100, 150))[3] == 0


def test_normalising_keeps_an_existing_size_and_is_idempotent():
    sized = b'<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="80mm" viewBox="0 0 50 80"><rect width="50" height="80"/></svg>'
    assert normalize_svg_mask(sized) == sized
    once = normalize_svg_mask(FRAME_SVG)
    assert normalize_svg_mask(once) == once


def test_the_print_loads_an_svg_from_s3_at_canvas_size():
    work = tempfile.mkdtemp(prefix="pe-svgmask-")
    with S3Backend() as s3:
        s3.client.put_object(Bucket=s3.storage.bucket, Key="product-editor/masks/f_mask_ab.svg", Body=FRAME_SVG)
        eng = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"))
        mask = eng._load_mask("/api/layouts/masks/f_mask_ab.svg", (1200, 1800))
    assert mask.size == (1200, 1800) and mask.getpixel((600, 900))[3] == 0


def test_an_svg_mask_is_printed_over_the_photo_end_to_end():
    work = tempfile.mkdtemp(prefix="pe-svgmask-")
    photo = os.path.join(work, "red.png")
    Image.new("RGB", (400, 600), (255, 0, 0)).save(photo)
    layout = {
        "name": "svg_test",
        "canvas": {"width": 300, "height": 450, "dpi": 300},
        "frames": [{"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}],
        "maskUrl": "/api/layouts/masks/svg_test_mask_ab.svg",
        "maskOnExport": True,
    }
    with S3Backend() as s3:
        s3.client.put_object(Bucket=s3.storage.bucket, Key="product-editor/masks/svg_test_mask_ab.svg", Body=FRAME_SVG)
        engine = LayoutEngine(os.path.join(work, "layouts"), os.path.join(work, "exports"), layout_definition=layout)
        outputs = engine.generate("svg_test", [photo])
    with Image.open(outputs[0]) as out:
        rgb = out.convert("RGB")
        assert rgb.getpixel((5, 5)) == (120, 70, 36), rgb.getpixel((5, 5))
        assert rgb.getpixel((150, 225)) == (255, 0, 0), rgb.getpixel((150, 225))


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
