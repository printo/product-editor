"""Render a fixed set of cases through the real LayoutEngine and write the files to /out.

Before a Pillow, pillow-heif or libheif bump, run this in the image BEFORE and AFTER the
bump, then diff the two output folders with compare.py (see README.md here):

    docker run --rm -w /app -e PYTHONPATH=/app -e DEBUG=1 -e SENTRY_DSN= \\
      -v "$PWD/scripts/render-compare:/h:ro" -v /path/to/photos:/photos:ro -v /path/to/out_before:/out \\
      --entrypoint /opt/venv/bin/python <image> /h/run.py

/photos holds real customer-style photos (JPEG, PNG, at least one .HEIC, optionally an
80 MP JPEG named big80mp.jpg). Never commit them.
"""
import glob
import json
import os
import shutil
import sys
import tempfile
import traceback

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
import django

django.setup()

import PIL
from PIL import Image

from layout_engine.engine import LayoutEngine

OUT = "/out"
PHOTOS = "/photos"
os.makedirs(OUT, exist_ok=True)

W, H = 1200, 1800  # 4x6 in at 300 dpi
CANVAS = {"width": W, "height": H, "widthMm": 101.6, "heightMm": 152.4, "dpi": 300}
results = {"pillow": PIL.__version__, "cases": {}}


def layout(name, frames=None, **extra):
    return {
        "name": name,
        "canvas": dict(CANVAS),
        "frames": frames or [{"id": "f0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}],
        **extra,
    }


def render(case, definition, photos, **kw):
    work = tempfile.mkdtemp()
    try:
        exports = os.path.join(work, "exports")
        os.makedirs(exports)
        os.makedirs(os.path.join(work, "layouts"), exist_ok=True)
        os.makedirs(os.path.join(work, "masks"), exist_ok=True)
        extra = kw.pop("_prepare", None)
        if extra:
            extra(work, definition)
        eng = LayoutEngine(os.path.join(work, "layouts"), exports, layout_definition=definition)
        outs = eng.generate(definition["name"], photos, **kw)
        for p in outs:
            dest = os.path.join(OUT, f"{case}__{os.path.basename(p)}")
            shutil.copy(p, dest)
        for p in glob.glob(os.path.join(exports, "*_preview.jpg")):
            shutil.copy(p, os.path.join(OUT, f"{case}__{os.path.basename(p)}"))
        results["cases"][case] = "ok"
    except Exception:
        results["cases"][case] = "ERROR " + traceback.format_exc().splitlines()[-1]
        traceback.print_exc()
    finally:
        shutil.rmtree(work, ignore_errors=True)


photos = sorted(
    p for p in glob.glob(os.path.join(PHOTOS, "*"))
    if p.lower().endswith((".jpg", ".jpeg", ".png")) and "big80" not in p
)

# 1. every real photo, cover fill
for p in photos:
    render("cover_" + os.path.splitext(os.path.basename(p))[0][:24], layout("t_cover"), [p], fit_mode="cover")

# 2. fit with a blurred fill and with a border, then pan / zoom / turn
for p in photos[:4]:
    stem = os.path.splitext(os.path.basename(p))[0][:20]
    render("blur_" + stem, layout("t_blur"), [p], fit_mode="contain",
           frame_transforms=[{"fit_mode": "contain", "fill_style": "blur"}])
    render("border_" + stem, layout("t_border"), [p], fit_mode="contain",
           frame_transforms=[{"fit_mode": "contain", "fill_style": "border"}])
    render("xform_" + stem, layout("t_xform"), [p], fit_mode="cover",
           frame_transforms=[{"offset_x": -40, "offset_y": 25, "scale": 1.4, "rotation": 90, "fit_mode": "cover"}])

# 3. HEIC: the server decode on its own, then the decoded JPEG through the engine
from services.heic import decode_heic_to_jpeg

for p in sorted(glob.glob(os.path.join(PHOTOS, "*.HEIC")) + glob.glob(os.path.join(PHOTOS, "*.heic"))):
    stem = os.path.splitext(os.path.basename(p))[0]
    try:
        data, w, h = decode_heic_to_jpeg(open(p, "rb").read())
        jp = os.path.join(OUT, f"heicdecode_{stem}.jpg")
        open(jp, "wb").write(data)
        results["cases"]["heicdecode_" + stem] = f"ok {w}x{h}"
        render("heicrender_" + stem, layout("t_heic"), [jp], fit_mode="cover")
    except Exception:
        results["cases"]["heicdecode_" + stem] = "ERROR " + traceback.format_exc().splitlines()[-1]
        traceback.print_exc()

# 4. the 80 MP JPEG (decoded at reduced size)
big = os.path.join(PHOTOS, "big80mp.jpg")
if os.path.exists(big):
    render("big80mp_cover", layout("t_big"), [big], fit_mode="cover")
    render("big80mp_fit", layout("t_bigfit"), [big], fit_mode="contain",
           frame_transforms=[{"fit_mode": "contain", "fill_style": "blur"}])

# 5. SVG mask (resvg) and a raster mask over a photo
SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1800">'
       '<path fill="#fff" fill-rule="evenodd" d="M0 0H1200V1800H0Z M600 300 C 900 300 1000 600 1000 900 '
       'C 1000 1300 700 1500 600 1500 C 500 1500 200 1300 200 900 C 200 600 300 300 600 300Z"/></svg>')


def prep_svg(work, definition):
    open(os.path.join(work, "masks", "heart.svg"), "w").write(SVG)


def prep_png_mask(work, definition):
    img = Image.new("RGBA", (W, H), (30, 60, 200, 255))
    hole = Image.new("RGBA", (800, 1300), (0, 0, 0, 0))
    img.paste(hole, (200, 250))
    img.save(os.path.join(work, "masks", "m.png"))


if photos:
    render("svgmask", layout("t_svg", maskUrl="/api/layouts/masks/heart.svg", maskOnExport=True),
           [photos[0]], fit_mode="cover", _prepare=prep_svg)
    render("pngmask", layout("t_png", maskUrl="/api/layouts/masks/m.png", maskOnExport=True),
           [photos[0]], fit_mode="cover", _prepare=prep_png_mask)

# 6. text, shapes, rotated text and an image sticker over a photo
if photos:
    sticker = os.path.join(tempfile.gettempdir(), "sticker.png")
    st = Image.new("RGBA", (200, 200), (255, 100, 100, 200))
    from PIL import ImageDraw
    ImageDraw.Draw(st).ellipse((10, 10, 190, 190), fill=(255, 200, 50, 230), outline=(150, 0, 0, 255), width=4)
    st.save(sticker)
    overlays = [[
        {"type": "text", "text": "Happy Birthday Anika", "x": 50, "y": 12, "fontSize": 96, "color": "#ffffff",
         "fontFamily": "Inter", "fontWeight": 700, "textAlign": "center", "rotation": 0},
        {"type": "text", "text": "Quick brown fox AVATAR To You 0123456789", "x": 50, "y": 88, "fontSize": 54,
         "color": "#222222", "fontFamily": "Inter", "textAlign": "center", "rotation": -8, "width": 70},
        {"type": "text", "text": "★ ♥ → ✓ small caption text for kerning", "x": 50, "y": 70, "fontSize": 40,
         "color": "#1E88E5", "fontFamily": "Inter", "textAlign": "left", "rotation": 0, "width": 60},
        {"type": "shape", "shapeType": "rect", "x": 10, "y": 30, "width": 30, "height": 8, "rotation": 0,
         "fill": "rgba(255, 99, 71, 0.65)", "stroke": "#222", "strokeWidth": 4, "opacity": 1.0},
        {"type": "shape", "shapeType": "ellipse", "x": 55, "y": 40, "width": 30, "height": 12, "rotation": 12,
         "fill": "#FFD54F", "stroke": "#5D4037", "strokeWidth": 6, "opacity": 0.9},
        {"type": "image", "fileId": "stk", "src": sticker, "x": 70, "y": 55, "width": 20, "height": 14,
         "rotation": 20, "opacity": 0.9, "source": "local"},
    ]]
    render("overlays", layout("t_ov"), [photos[0]], fit_mode="cover", overlays_per_canvas=overlays,
           uploaded_files={"stk": sticker})

# 7. PDF export
if photos:
    render("pdf", layout("t_pdf"), [photos[0]], fit_mode="cover", export_format="pdf")

json.dump(results, open(os.path.join(OUT, "_results.json"), "w"), indent=1)
print(json.dumps(results, indent=1))
