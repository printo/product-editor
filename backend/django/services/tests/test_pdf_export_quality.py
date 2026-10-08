"""
PDF export must not re-compress the print canvas as a default-quality JPEG.

Pillow writes an RGB image into a PDF as a JPEG stream. Left at its defaults
that is quality 75 with 4:2:0 chroma subsampling, and the engine's canvas is
RGB, so every export_format='pdf' job shipped a lossy print file while the PNG
next to it is lossless. 4:2:0 halves the colour resolution, which shows as
fringing on fine colour detail and text edges.

These write a real PDF through the engine's own writer and read the JPEG back
out of it.

Run stand-alone:
    cd backend/django && python -m services.tests.test_pdf_export_quality
"""
from __future__ import annotations

import io
import os
import re
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageStat, JpegImagePlugin

from layout_engine.engine import LayoutEngine

# Quality 75 (Pillow's default) has a largest luminance quantisation step of
# 61; quality 90 has 24 and quality 95 has 12. Anything above 16 is a
# quality regression.
MAX_QUANT_STEP = 16
MAX_MEAN_ERROR = 2.0


def _print_canvas(w: int = 600, h: int = 900) -> Image.Image:
    """Fine, saturated colour detail — what chroma subsampling destroys first."""
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    for x in range(0, w, 2):
        d.line([(x, 0), (x, h // 2 - 1)], fill=(255, 0, 0))
        d.line([(x + 1, 0), (x + 1, h // 2 - 1)], fill=(0, 0, 255))
    for y in range(h // 2, h, 4):
        d.line([(0, y), (w - 1, y)], fill=(0, 200, 0))
        d.line([(0, y + 1), (w - 1, y + 1)], fill=(255, 0, 255))
    return img


def _write_pdf(img: Image.Image) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "print.pdf")
        LayoutEngine(tmp, tmp)._write_output_atomic(img, out)
        with open(out, "rb") as f:
            return f.read()


def _embedded_jpeg(pdf: bytes) -> Image.Image:
    at = pdf.index(b"/DCTDecode")
    length = int(re.search(rb"/Length (\d+)", pdf[at:at + 400]).group(1))
    start = pdf.index(b"stream", at) + len(b"stream")
    while pdf[start:start + 1] in (b"\r", b"\n"):
        start += 1
    jpeg = Image.open(io.BytesIO(pdf[start:start + length]))
    jpeg.load()
    return jpeg


def test_pdf_embeds_a_near_lossless_jpeg():
    jpeg = _embedded_jpeg(_write_pdf(_print_canvas()))
    step = max(jpeg.quantization[0])
    assert step <= MAX_QUANT_STEP, (
        f"PDF's JPEG is too coarse: largest quantisation step {step} "
        f"(limit {MAX_QUANT_STEP}; Pillow's default quality 75 gives 61)"
    )


def test_pdf_keeps_full_chroma_resolution():
    jpeg = _embedded_jpeg(_write_pdf(_print_canvas()))
    assert JpegImagePlugin.get_sampling(jpeg) == 0, (
        "PDF's JPEG is chroma-subsampled (expected 4:4:4)"
    )


def test_pdf_round_trip_error_is_negligible_on_fine_colour_detail():
    canvas = _print_canvas()
    jpeg = _embedded_jpeg(_write_pdf(canvas)).convert("RGB")
    mean = ImageStat.Stat(ImageChops.difference(canvas, jpeg)).mean
    error = sum(mean) / 3
    assert error < MAX_MEAN_ERROR, (
        f"image inside the PDF differs from the print canvas by {error:.2f} "
        f"levels on average (limit {MAX_MEAN_ERROR})"
    )


def test_pdf_page_size_still_matches_300_dpi():
    pdf = _write_pdf(_print_canvas(600, 900))
    box = re.search(rb"/MediaBox \[ *0 0 ([\d.]+) ([\d.]+) *\]", pdf)
    assert box, "no /MediaBox in the PDF"
    width_pt, height_pt = float(box.group(1)), float(box.group(2))
    assert (width_pt, height_pt) == (144.0, 216.0), (width_pt, height_pt)


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
    print(f"All {len(funcs)} pdf-export-quality tests passed.")


if __name__ == "__main__":
    _run_all()
