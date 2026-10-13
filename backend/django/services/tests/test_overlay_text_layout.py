"""
Pins the print's text overlay layout (services/overlay_renderer.py) to the
Fabric Textbox both previews draw:

  size      `fontSize` is print px, used unscaled. Until 2026-10-13 the print
            multiplied it by `canvas height / 800`, so a 72 px heading on an
            1800 px-tall layout printed 2.25x the size the customer saw.
  wrapping  words split on spaces, greedy, never broken mid-word, inside a
            box of `width` % of the canvas (80 when absent); the box widens
            to a word that does not fit. The previews used to disagree with
            each other too (the thumbnail wrapped at every word).
  lines     `fontSize x 1.13 x 1.16` apart, baseline `fontSize x 1.13 x 0.778`
            below each line's top, the block centred on y.
  anchor    textAlign left / right at x; anything else, including an
            absent textAlign, centred on x (the print used to anchor left).

The pure functions are checked with a monospace measure; the rendered
checks use the bundled Inter (cap height 0.7275 em) and measure ink.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_overlay_text_layout
"""
from __future__ import annotations

from PIL import Image, ImageDraw

from services.google_fonts import get_overlay_font
from services.overlay_renderer import (
    DEFAULT_TEXT_BOX_WIDTH_PCT,
    layout_text,
    render_overlays,
    wrap_text,
)

INTER_CAP_HEIGHT = 0.7275  # Inter's capHeight / unitsPerEm (1490 / 2048)


def _mono(s: str) -> float:
    return 10.0 * len(s)


def _near(a: float, b: float, tol: float, what: str) -> None:
    assert abs(a - b) <= tol, f"{what}: got {a:.2f}, expected {b:.2f} ± {tol}"


# ── wrap_text ───────────────────────────────────────────────────────────────


def test_short_text_stays_on_one_line():
    lines, width = wrap_text("Hello world", _mono, 200)
    assert lines == ["Hello world"]
    assert width == 200


def test_wraps_greedily_at_word_boundaries():
    # "Hello world" is 110 px: exactly the box, which Fabric keeps on one line
    # (it breaks on >, not >=); " foo" takes it to 150 and wraps.
    lines, _ = wrap_text("Hello world foo", _mono, 110)
    assert lines == ["Hello world", "foo"]


def test_a_word_wider_than_the_box_is_never_broken_and_widens_the_box():
    lines, width = wrap_text("Supercalifragilistic is long", _mono, 100)
    assert lines == ["Supercalifragilistic", "is long"]
    assert width == 200, "the box grows to the largest word, as Textbox.dynamicMinWidth does"


def test_hard_line_breaks_and_blank_lines_are_kept():
    lines, _ = wrap_text("one\ntwo\r\n\nfour", _mono, 1000)
    assert lines == ["one", "two", "", "four"]


def test_runs_of_spaces_survive_like_fabric_single_space_splitting():
    lines, _ = wrap_text("a  b", _mono, 1000)
    assert lines == ["a  b"]


# ── layout_text ─────────────────────────────────────────────────────────────


def test_single_line_baseline_sits_0_314_em_below_the_anchor():
    [(_, dx, dy)] = layout_text(["Hi"], 100, 800, "left", _mono)
    _near(dy, 31.4, 0.05, "baseline offset")  # -1.13/2 + 1.13*0.778
    assert dx == 0.0, "left-aligned text starts at x"


def test_alignment_decides_where_the_line_sits_relative_to_x():
    [(_, centre, _)] = layout_text(["Hi"], 100, 800, "center", _mono)
    [(_, right, _)] = layout_text(["Hi"], 100, 800, "right", _mono)
    _near(centre, -10.0, 1e-9, "centred line's left end")   # half of 20 px
    _near(right, -20.0, 1e-9, "right-aligned line's left end")


def test_lines_are_fabric_line_height_apart_and_the_block_is_centred():
    placed = layout_text(["a", "b", "c"], 100, 800, "left", _mono)
    height = 2 * 100 * 1.13 * 1.16 + 100 * 1.13
    first = -height / 2 + 100 * 1.13 * 0.778
    _near(placed[0][2], first, 1e-6, "first baseline")
    _near(placed[1][2] - placed[0][2], 131.08, 1e-6, "line pitch")
    _near(placed[2][2] - placed[1][2], 131.08, 1e-6, "line pitch")


# ── rendered with Inter ─────────────────────────────────────────────────────


def _render(overlay: dict, w: int, h: int) -> Image.Image:
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    render_overlays(canvas, [overlay], w, h)
    return canvas


def _ink_bbox(img: Image.Image):
    return img.getchannel("A").getbbox()


def _ink_row_bands(img: Image.Image) -> int:
    """How many separate vertical runs of ink there are (lines of text)."""
    alpha = img.getchannel("A")
    w, h = alpha.size
    data = alpha.getdata()
    rows = [any(data[y * w + x] for x in range(w)) for y in range(h)]
    return sum(1 for y in range(h) if rows[y] and (y == 0 or not rows[y - 1]))


def _text(**kw) -> dict:
    base = {"type": "text", "text": "H", "x": 50, "y": 50, "fontSize": 100, "color": "#000000", "rotation": 0}
    base.update(kw)
    return base


def test_font_size_is_print_pixels_whatever_the_canvas_height():
    """A capital H at fontSize 100 is ~73 px tall (Inter's cap height) on an
    800 px canvas and on an 1800 px one. Before the fix the second printed
    at 2.25x: a 164 px H."""
    for h in (800, 1800):
        box = _ink_bbox(_render(_text(textAlign="left"), 1000, h))
        cap = box[3] - box[1]
        _near(cap, INTER_CAP_HEIGHT * 100, 3, f"cap height on a {h} px canvas")


def test_glyphs_sit_where_fabric_puts_them_below_the_anchor():
    y = 900
    box = _ink_bbox(_render(_text(textAlign="left", fontSize=100), 1000, 1800))
    # The baseline is 31.4 px below y; the H's bottom pixel is just above it.
    _near(box[3], y + 31.4, 2.5, "bottom of the H")
    _near(box[1], y + 31.4 - INTER_CAP_HEIGHT * 100, 3, "top of the H")


def test_absent_text_align_centres_on_x_like_both_previews():
    box = _ink_bbox(_render(_text(text="HHHH"), 1000, 600))
    _near((box[0] + box[2]) / 2, 500, 2.5, "ink centre of centred text")
    # Left/right anchor the advance box at x, as Fabric does; the ink then sits
    # a side bearing in (9 px for Inter's H at 100 px). Compare with the same
    # string drawn by PIL at x with its own left/right baseline anchors.
    font = get_overlay_font(None, 100)
    for align, anchor, side in (("left", "ls", 0), ("right", "rs", 2)):
        ref = Image.new("RGBA", (1000, 600), (0, 0, 0, 0))
        ImageDraw.Draw(ref).text((500, 300), "HHHH", font=font, fill="#000", anchor=anchor)
        got = _ink_bbox(_render(_text(text="HHHH", textAlign=align), 1000, 600))
        _near(got[side], _ink_bbox(ref)[side], 1.5, f"{align}-aligned text edge")


def test_legacy_overlay_without_width_wraps_at_80_percent_of_the_canvas():
    assert DEFAULT_TEXT_BOX_WIDTH_PCT == 80
    # "HH HH HH" at 60 px is ~220 px wide: one line in an 800 px box ...
    one = _render(_text(text="HH HH HH", fontSize=60), 1000, 600)
    assert _ink_row_bands(one) == 1, "short text must stay on one line"
    # ... and three lines once the box is narrower than two words.
    three = _render(_text(text="HH HH HH", fontSize=60, width=12), 1000, 600)
    assert _ink_row_bands(three) == 3, "a 120 px box takes one HH per line"


def test_wrapped_lines_are_fabric_line_height_apart():
    img = _render(_text(text="HH HH", fontSize=100, width=12, textAlign="left"), 1000, 800)
    assert _ink_row_bands(img) == 2
    alpha = img.getchannel("A")
    w, h = alpha.size
    data = alpha.getdata()
    tops = [y for y in range(h) if any(data[y * w + x] for x in range(w)) and (y == 0 or not any(data[(y - 1) * w + x] for x in range(w)))]
    _near(tops[1] - tops[0], 100 * 1.13 * 1.16, 2.5, "line pitch")


def test_rotated_text_still_draws():
    assert _ink_bbox(_render(_text(text="HH HH", width=12, rotation=30), 1000, 800)) is not None


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} overlay text-layout tests passed.")
