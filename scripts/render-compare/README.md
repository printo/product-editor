# Render comparison for image-library bumps

`backend/django/requirements.txt` pins Pillow, pillow-heif and (through them) FreeType,
libheif and libjpeg. A bump can change print pixels without any test failing, because the
test suites check structure and a few sampled pixels, not whole files.

1. Build the image before the bump and after it (`docker build -f backend/django/Dockerfile`).
2. Run `run.py` in each against the same `/photos` folder (see its header). It renders about
   36 cases through the real `LayoutEngine`: every photo with cover fill, fit with a blurred
   and with a border fill, pan/zoom/turn, HEIC decode and render, an 80 MP JPEG, SVG and PNG
   masks, text, shapes and a sticker, and a PDF.
3. Run `compare.py before after`. Read anything not marked `identical bytes` or `same pixels`.

Result of the 2026-11-19 move to Pillow 13.0.0 / pillow-heif 1.3.0: every case identical
except 117 pixels on the edge of one `→` glyph (FreeType 2.13.2 to 2.14.3) and the PDF header.
