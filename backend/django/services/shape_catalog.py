"""
Python twin of `frontend/nextjs/src/lib/shape-catalog.ts`.

The two previews build a shape overlay from this catalogue
(`createShapeFromOverlay` in `lib/fabric-utils.ts`): a key with a
`fabricType` becomes a native Fabric Rect / Circle / Ellipse / Triangle /
Polygon, anything else becomes a Fabric Path from its `svgPath` (or the
overlay's own `svgPath`), and an unknown key previews as the rectangle path.
The print (`services/overlay_renderer._draw_shape`) resolves the same way,
so the two lists must stay identical — pinned against
`storage/parity-fixtures/shape-catalog.json` by
`services/tests/test_shape_catalog_parity.py` (this side) and
`src/lib/__tests__/shape-catalog.parity.test.ts` (the editor side).

`flatten_path` turns an SVG path into polygons for Pillow. It understands
the commands the catalogue uses (M L H V C Q S T Z, absolute and relative)
and refuses arcs (`A`) with `UnsupportedPath`, which the renderer turns into
a logged skip rather than a stand-in rectangle.
"""
from __future__ import annotations

import re
from typing import Optional


class UnsupportedPath(ValueError):
    """An SVG path command the flattener does not implement."""


SHAPE_CATALOG: list[dict] = [
    {"key": "rect", "svgPath": "M 5 5 H 95 V 95 H 5 Z", "fabricType": "rect"},
    {
        "key": "rounded-rect",
        "svgPath": "M 15 5 H 85 Q 95 5 95 15 V 85 Q 95 95 85 95 H 15 Q 5 95 5 85 V 15 Q 5 5 15 5 Z",
        "fabricType": "rect",
    },
    {"key": "circle", "svgPath": "M 50 5 A 45 45 0 1 1 50 95 A 45 45 0 1 1 50 5 Z", "fabricType": "circle"},
    {"key": "ellipse", "svgPath": "M 50 15 A 45 35 0 1 1 50 85 A 45 35 0 1 1 50 15 Z", "fabricType": "ellipse"},
    {"key": "triangle", "svgPath": "M 50 5 L 95 95 L 5 95 Z", "fabricType": "triangle"},
    {
        "key": "diamond",
        "svgPath": "M 50 5 L 95 50 L 50 95 L 5 50 Z",
        "fabricType": "polygon",
        "polygonPoints": [{"x": 50, "y": 0}, {"x": 100, "y": 50}, {"x": 50, "y": 100}, {"x": 0, "y": 50}],
    },
    {
        "key": "hexagon",
        "svgPath": "M 50 5 L 93 27.5 L 93 72.5 L 50 95 L 7 72.5 L 7 27.5 Z",
        "fabricType": "polygon",
        "polygonPoints": [
            {"x": 50, "y": 0}, {"x": 93, "y": 25}, {"x": 93, "y": 75},
            {"x": 50, "y": 100}, {"x": 7, "y": 75}, {"x": 7, "y": 25},
        ],
    },
    {
        "key": "pentagon",
        "svgPath": "M 50 5 L 97 38 L 79 95 L 21 95 L 3 38 Z",
        "fabricType": "polygon",
        "polygonPoints": [
            {"x": 50, "y": 0}, {"x": 100, "y": 35}, {"x": 81, "y": 100}, {"x": 19, "y": 100}, {"x": 0, "y": 35},
        ],
    },
    {"key": "arrow-right", "svgPath": "M 5 35 H 60 V 15 L 95 50 L 60 85 V 65 H 5 Z"},
    {"key": "arrow-left", "svgPath": "M 95 35 H 40 V 15 L 5 50 L 40 85 V 65 H 95 Z"},
    {"key": "arrow-up", "svgPath": "M 35 95 V 40 H 15 L 50 5 L 85 40 H 65 V 95 Z"},
    {"key": "arrow-down", "svgPath": "M 35 5 V 60 H 15 L 50 95 L 85 60 H 65 V 5 Z"},
    {"key": "chevron-right", "svgPath": "M 25 5 L 75 50 L 25 95 L 15 85 L 55 50 L 15 15 Z"},
    {"key": "star", "svgPath": "M 50 5 L 61 38 L 97 38 L 68 60 L 79 93 L 50 72 L 21 93 L 32 60 L 3 38 L 39 38 Z"},
    {
        "key": "heart",
        "svgPath": (
            "M 50 88 C 20 65 5 50 5 33 C 5 18 17 8 30 8 C 38 8 46 13 50 20 "
            "C 54 13 62 8 70 8 C 83 8 95 18 95 33 C 95 50 80 65 50 88 Z"
        ),
    },
    {"key": "cross", "svgPath": "M 35 5 H 65 V 35 H 95 V 65 H 65 V 95 H 35 V 65 H 5 V 35 H 35 Z"},
    {"key": "plus", "svgPath": "M 40 10 H 60 V 40 H 90 V 60 H 60 V 90 H 40 V 60 H 10 V 40 H 40 Z"},
    {
        "key": "badge",
        "svgPath": (
            "M 50 5 L 62 15 L 78 10 L 80 27 L 95 37 L 88 52 L 95 67 L 80 77 L 78 94 L 62 89 "
            "L 50 99 L 38 89 L 22 94 L 20 77 L 5 67 L 12 52 L 5 37 L 20 27 L 22 10 L 38 15 Z"
        ),
    },
    {
        "key": "speech-bubble",
        "svgPath": (
            "M 15 10 H 85 Q 95 10 95 20 V 60 Q 95 70 85 70 H 40 L 20 90 L 25 70 H 15 "
            "Q 5 70 5 60 V 20 Q 5 10 15 10 Z"
        ),
    },
    {
        "key": "cloud",
        "svgPath": (
            "M 25 80 C 10 80 5 68 10 58 C 5 48 12 38 24 38 C 24 22 40 15 52 22 "
            "C 58 12 75 10 82 22 C 95 22 100 35 92 48 C 100 58 95 72 82 75 C 80 82 65 85 55 80 Z"
        ),
    },
]

_BY_KEY = {s["key"]: s for s in SHAPE_CATALOG}


def shape_def(shape_type: str) -> Optional[dict]:
    """`getShapeDef`: the catalogue entry, or None for an unknown key."""
    return _BY_KEY.get(shape_type)


def shape_path(shape_type: str, svg_path: Optional[str] = None) -> str:
    """`getShapePath`: the overlay's own path, else the catalogue's, else the rectangle."""
    if svg_path:
        return svg_path
    d = _BY_KEY.get(shape_type)
    return d["svgPath"] if d else SHAPE_CATALOG[0]["svgPath"]


def polygon_bbox_fraction(points: list[dict]) -> tuple[float, float]:
    """Width and height of a polygon's points as a fraction of its box (0..1).

    Fabric's Polygon width is the points' bounding box, not the box the
    overlay was given, so the hexagon (x from 7 to 93) is 0.86 of its box wide.
    """
    xs = [float(p["x"]) for p in points]
    ys = [float(p["y"]) for p in points]
    return (max(xs) - min(xs)) / 100.0, (max(ys) - min(ys)) / 100.0


# ── SVG path flattening ─────────────────────────────────────────────────────

_TOKEN = re.compile(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")

CURVE_SEGMENTS = 24


def flatten_path(d: str, segments: int = CURVE_SEGMENTS) -> list[list[tuple[float, float]]]:
    """Flatten an SVG path `d` into closed polygons (one per subpath).

    Curves are sampled `segments` times. Raises UnsupportedPath for arcs or
    a malformed string; never guesses a shape.
    """
    tokens = _TOKEN.findall(d or "")
    if not tokens:
        raise UnsupportedPath("empty path")

    polys: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    x = y = 0.0
    start = (0.0, 0.0)
    last_ctrl: Optional[tuple[float, float]] = None  # for S / T reflection
    last_cmd = ""
    i = 0

    def take(n: int) -> list[float]:
        nonlocal i
        if i + n > len(tokens):
            raise UnsupportedPath(f"truncated path near token {i}")
        vals = []
        for t in tokens[i:i + n]:
            try:
                vals.append(float(t))
            except ValueError as exc:
                raise UnsupportedPath(f"expected a number, got {t!r}") from exc
        i += n
        return vals

    def close():
        nonlocal current, x, y
        if current:
            polys.append(current)
        current = []
        x, y = start

    cmd = ""
    while i < len(tokens):
        t = tokens[i]
        if t.isalpha():
            cmd = t
            i += 1
        elif not cmd:
            raise UnsupportedPath("path does not start with a command")
        elif cmd in "Mm":
            # Further pairs after a moveto are implicit linetos.
            cmd = "L" if cmd == "M" else "l"
        rel = cmd.islower()
        c = cmd.upper()

        if c == "Z":
            close()
            last_ctrl = None
        elif c == "M":
            nx, ny = take(2)
            if rel:
                nx, ny = x + nx, y + ny
            if current:
                polys.append(current)
            current = [(nx, ny)]
            x, y = nx, ny
            start = (nx, ny)
            last_ctrl = None
        elif c == "L":
            nx, ny = take(2)
            if rel:
                nx, ny = x + nx, y + ny
            current.append((nx, ny))
            x, y = nx, ny
            last_ctrl = None
        elif c == "H":
            (nx,) = take(1)
            x = x + nx if rel else nx
            current.append((x, y))
            last_ctrl = None
        elif c == "V":
            (ny,) = take(1)
            y = y + ny if rel else ny
            current.append((x, y))
            last_ctrl = None
        elif c in ("C", "S"):
            if c == "C":
                x1, y1, x2, y2, nx, ny = take(6)
                if rel:
                    x1, y1, x2, y2, nx, ny = x + x1, y + y1, x + x2, y + y2, x + nx, y + ny
            else:
                x2, y2, nx, ny = take(4)
                if rel:
                    x2, y2, nx, ny = x + x2, y + y2, x + nx, y + ny
                if last_cmd in ("C", "S") and last_ctrl:
                    x1, y1 = 2 * x - last_ctrl[0], 2 * y - last_ctrl[1]
                else:
                    x1, y1 = x, y
            for k in range(1, segments + 1):
                t_ = k / segments
                u = 1 - t_
                current.append((
                    u * u * u * x + 3 * u * u * t_ * x1 + 3 * u * t_ * t_ * x2 + t_ * t_ * t_ * nx,
                    u * u * u * y + 3 * u * u * t_ * y1 + 3 * u * t_ * t_ * y2 + t_ * t_ * t_ * ny,
                ))
            last_ctrl = (x2, y2)
            x, y = nx, ny
        elif c in ("Q", "T"):
            if c == "Q":
                x1, y1, nx, ny = take(4)
                if rel:
                    x1, y1, nx, ny = x + x1, y + y1, x + nx, y + ny
            else:
                nx, ny = take(2)
                if rel:
                    nx, ny = x + nx, y + ny
                if last_cmd in ("Q", "T") and last_ctrl:
                    x1, y1 = 2 * x - last_ctrl[0], 2 * y - last_ctrl[1]
                else:
                    x1, y1 = x, y
            for k in range(1, segments + 1):
                t_ = k / segments
                u = 1 - t_
                current.append((
                    u * u * x + 2 * u * t_ * x1 + t_ * t_ * nx,
                    u * u * y + 2 * u * t_ * y1 + t_ * t_ * ny,
                ))
            last_ctrl = (x1, y1)
            x, y = nx, ny
        elif c == "A":
            raise UnsupportedPath("arc commands are not supported")
        else:
            raise UnsupportedPath(f"unknown path command {cmd!r}")
        last_cmd = c

    if current:
        polys.append(current)
    polys = [p for p in polys if len(p) >= 2]
    if not polys:
        raise UnsupportedPath("path has no drawable segments")
    return polys


def path_bbox(polys: list[list[tuple[float, float]]]) -> tuple[float, float, float, float]:
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    return min(xs), min(ys), max(xs), max(ys)
