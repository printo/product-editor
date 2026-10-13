"""
Pins the print's shape overlays (services/overlay_renderer.py) to what
`createShapeFromOverlay` (lib/fabric-utils.ts) draws in both previews:

  stroke    `strokeWidth` is print px (unscaled); the stroke is centred on
            the geometry's edge and (x, y) is the corner of the box
            INCLUDING the stroke, as Fabric places a stroked object. The
            print used to draw the stroke inside the box.
  circle    radius min(w, h) / 2, centred in its box. The print used to fill
            the whole box with an ellipse.
  ellipse   fills the box.
  triangle  apex top-centre, base along the bottom (Fabric Triangle).
  polygons  the catalogue points, placed by their own bounds.
  paths     the catalogue SVG path (or the overlay's svgPath), scaled from
            its 100-unit space by (w/100, h/100) and placed by its bounds,
            so a star fills 94% x 88% of its box exactly as in the preview.
            An unknown key previews as the rectangle path, so it prints as
            one (with a warning); a path the flattener can't draw (arcs) is
            skipped with a warning, never replaced by a rectangle.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_overlay_shape_geometry
"""
from __future__ import annotations

import logging

from PIL import Image

from services.overlay_renderer import render_overlays, shape_geometry

W = H = 1000


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record):
        self.messages.append(record.getMessage())


def _render(overlay: dict):
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    log = logging.getLogger("services.overlay_renderer")
    cap = _Capture()
    log.addHandler(cap)
    try:
        render_overlays(canvas, [overlay], W, H)
    finally:
        log.removeHandler(cap)
    return canvas, cap.messages


def _shape(shape_type: str, **kw) -> dict:
    base = {
        "type": "shape", "shapeType": shape_type,
        "x": 40, "y": 30, "width": 30, "height": 10,   # box: (400, 300) 300 x 100 px
        "fill": "#ff0000", "stroke": "#0000ff", "strokeWidth": 0, "opacity": 1, "rotation": 0,
    }
    base.update(kw)
    return base


def _bbox(img):
    return img.getchannel("A").getbbox()


def _near_box(got, want, tol, what):
    assert got is not None, f"{what}: nothing drawn"
    for g, w_, side in zip(got, want, ("left", "top", "right", "bottom")):
        assert abs(g - w_) <= tol, f"{what} {side}: got {g}, expected {w_} ± {tol} (bbox {got})"


# ── shape_geometry ──────────────────────────────────────────────────────────


def test_rect_geometry_is_inset_by_half_the_stroke():
    g = shape_geometry("rect", None, 100, 100, 200, 50, 10)
    assert g["kind"] == "rect"
    assert g["box"] == (105, 105, 305, 155)
    assert g["stroke_w"] == 10 and g["radius"] == 0


def test_rounded_rect_radius_is_15_percent_of_the_shorter_side():
    assert shape_geometry("rounded-rect", None, 0, 0, 200, 50, 0)["radius"] == 7.5


def test_circle_uses_the_shorter_side_centred_in_its_box():
    g = shape_geometry("circle", None, 400, 300, 300, 100, 0)
    assert g == {"kind": "ellipse", "box": (500, 300, 600, 400), "stroke_w": 0}


def test_ellipse_fills_its_box():
    assert shape_geometry("ellipse", None, 400, 300, 300, 100, 0)["box"] == (400, 300, 700, 400)


def test_triangle_points_up_from_its_base():
    g = shape_geometry("triangle", None, 400, 300, 300, 100, 0)
    assert g["polys"] == [[(550, 300), (700, 400), (400, 400)]]


def test_hexagon_is_placed_by_its_point_bounds():
    g = shape_geometry("hexagon", None, 400, 300, 300, 100, 0)
    xs = [p[0] for p in g["polys"][0]]
    ys = [p[1] for p in g["polys"][0]]
    assert min(xs) == 400 and max(xs) == 400 + 0.86 * 300
    assert min(ys) == 300 and max(ys) == 400


def test_path_scales_its_stroke_with_the_box():
    g = shape_geometry("star", None, 400, 300, 300, 100, 10)
    assert g["kind"] == "polygon"
    assert abs(g["stroke_w"] - 10 * (3 + 1) / 2) < 1e-9
    xs = [p[0] for p in g["polys"][0]]
    assert abs(min(xs) - (400 + 10 * 3 / 2)) < 1e-9, "path bounds start half a (scaled) stroke in"


# ── rendered ────────────────────────────────────────────────────────────────


def test_rect_stroke_is_centred_on_the_edge_and_the_box_includes_it():
    img, _ = _render(_shape("rect", strokeWidth=10))
    _near_box(_bbox(img), (400, 300, 710, 410), 1, "stroked rect")
    assert img.getpixel((403, 350))[:3] == (0, 0, 255), "stroke along the left edge"
    assert img.getpixel((550, 350))[:3] == (255, 0, 0), "fill inside"
    assert img.getpixel((707, 350))[:3] == (0, 0, 255), "stroke along the right edge"


def test_unfilled_rect_leaves_the_inside_clear():
    img, _ = _render(_shape("rect", fill="transparent", strokeWidth=20))
    assert img.getpixel((410, 350))[3] == 255, "stroke"
    assert img.getpixel((450, 350))[3] == 0, "inside the stroke is clear"
    assert img.getpixel((715, 350))[3] == 255, "outer edge of the right stroke"


def test_circle_prints_as_the_preview_draws_it_not_as_a_box_filling_ellipse():
    img, _ = _render(_shape("circle"))
    _near_box(_bbox(img), (500, 300, 600, 400), 1, "circle in a 300x100 box")


def test_ellipse_fills_its_box_in_the_print():
    img, _ = _render(_shape("ellipse"))
    _near_box(_bbox(img), (400, 300, 700, 400), 1, "ellipse")


def test_triangle_apex_is_top_centre():
    img, _ = _render(_shape("triangle"))
    _near_box(_bbox(img), (400, 300, 700, 400), 1, "triangle")
    assert img.getpixel((550, 303))[3] == 255, "apex at the top centre"
    assert img.getpixel((410, 303))[3] == 0, "top corners are empty"


def test_star_fills_94_by_88_percent_of_its_box_like_the_fabric_path():
    # Fabric places a Path by its own bounds (x 3–97, y 5–93 of the catalogue
    # square) at the box corner, so the star starts at (x, y) and is 94% x 88%.
    img, _ = _render(_shape("star"))
    _near_box(_bbox(img), (400, 300, 400 + 0.94 * 300, 300 + 0.88 * 100), 1.5, "star")


def test_curved_catalogue_shapes_draw():
    for key in ("heart", "cloud", "speech-bubble", "rounded-rect"):
        img, msgs = _render(_shape(key))
        assert _bbox(img) is not None, f"{key} drew nothing"
        assert not msgs, f"{key}: unexpected warning {msgs}"


def test_unknown_shape_type_prints_the_rectangle_path_the_preview_shows_and_warns():
    img, msgs = _render(_shape("line"))
    # The rectangle path spans 5–95: a 90% x 90% rectangle placed at the box corner.
    _near_box(_bbox(img), (400, 300, 400 + 0.9 * 300, 300 + 0.9 * 100), 1.5, "unknown shape")
    assert any("Unknown shapeType" in m for m in msgs), msgs


def test_overlay_svg_path_wins_over_the_catalogue():
    img, _ = _render(_shape("star", svgPath="M 0 0 H 100 V 100 H 0 Z"))
    _near_box(_bbox(img), (400, 300, 700, 400), 1, "custom path")


def test_a_path_with_arcs_is_skipped_with_a_warning_not_drawn_as_a_rectangle():
    img, msgs = _render(_shape("blob", svgPath="M 50 5 A 45 45 0 1 1 50 95 Z"))
    assert _bbox(img) is None, "nothing must be drawn for a path the print can't flatten"
    assert any("can't draw" in m for m in msgs), msgs


def test_absent_fill_is_transparent_as_in_the_previews():
    img, _ = _render({**_shape("rect", strokeWidth=4), "fill": None})
    assert img.getpixel((550, 350))[3] == 0, "no fill when the overlay has none"
    assert img.getpixel((401, 350))[3] == 255, "but the stroke is there"


def test_opacity_applies_to_fill_and_stroke():
    img, _ = _render(_shape("rect", strokeWidth=10, opacity=0.5))
    assert 120 <= img.getpixel((550, 350))[3] <= 130
    assert 120 <= img.getpixel((403, 350))[3] <= 130


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} overlay shape-geometry tests passed.")
