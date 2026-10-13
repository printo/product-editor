"""
Shape catalogue parity (services/shape_catalog.py <-> lib/shape-catalog.ts),
held to storage/parity-fixtures/shape-catalog.json, the same fixture
src/lib/__tests__/shape-catalog.parity.test.ts checks the editor side
against. Plus the SVG path flattener the print draws catalogue paths with.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_shape_catalog_parity
"""
from __future__ import annotations

import json
import os

import django
from django.conf import settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
django.setup()

from services.shape_catalog import (  # noqa: E402
    SHAPE_CATALOG,
    UnsupportedPath,
    flatten_path,
    path_bbox,
    shape_def,
    shape_path,
)


def _fixture() -> list[dict]:
    path = os.path.join(settings.STORAGE_ROOT, "parity-fixtures", "shape-catalog.json")
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Parity fixture missing at {path}. Both this module and "
            "frontend/nextjs/src/lib/__tests__/shape-catalog.parity.test.ts load from it."
        )
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["shapes"]


def test_catalogue_matches_the_fixture_the_editor_is_held_to():
    assert SHAPE_CATALOG == _fixture()


def test_lookups_mirror_the_editor_helpers():
    assert shape_def("circle")["fabricType"] == "circle"
    assert shape_def("no-such-shape") is None
    assert shape_path("star") == shape_def("star")["svgPath"]
    assert shape_path("no-such-shape") == SHAPE_CATALOG[0]["svgPath"], "unknown keys fall back to the rectangle"
    assert shape_path("star", "M 0 0 L 1 1 Z") == "M 0 0 L 1 1 Z", "an overlay's own path wins"


def test_flattens_absolute_and_relative_straight_commands():
    assert flatten_path("M 0 0 H 10 V 10 H 0 Z") == [[(0, 0), (10, 0), (10, 10), (0, 10)]]
    assert flatten_path("m 1 1 l 2 0 l 0 2 z") == [[(1, 1), (3, 1), (3, 3)]]
    assert flatten_path("M 0 0 10 0 10 10 Z") == [[(0, 0), (10, 0), (10, 10)]], "implicit linetos after a moveto"


def test_curves_end_at_their_end_point_and_stay_inside_the_control_hull():
    [poly] = flatten_path("M 0 0 Q 50 100 100 0 Z")
    assert poly[-1] == (100, 0)
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    assert 0 <= min(xs) and max(xs) <= 100 and max(ys) <= 50 + 1e-9  # a quadratic peaks at half its control height
    [poly] = flatten_path("M 0 0 C 0 100 100 100 100 0 Z")
    assert poly[-1] == (100, 0) and max(p[1] for p in poly) <= 75 + 1e-9


def test_every_catalogue_path_without_arcs_flattens_inside_its_100_unit_box():
    for s in SHAPE_CATALOG:
        if s.get("fabricType") in ("circle", "ellipse"):
            continue  # drawn natively; their svgPaths use arcs
        polys = flatten_path(s["svgPath"])
        l, t, r, b = path_bbox(polys)
        assert 0 <= l < r <= 100 and 0 <= t < b <= 100, (s["key"], (l, t, r, b))


def test_arcs_and_garbage_are_refused_not_guessed():
    for bad in ("M 50 5 A 45 45 0 1 1 50 95 Z", "", "10 10 20 20", "M 0 0 X 1 1", "M 0 0 L 1"):
        try:
            flatten_path(bad)
        except UnsupportedPath:
            continue
        raise AssertionError(f"{bad!r} should have been refused")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} shape-catalogue parity tests passed.")
