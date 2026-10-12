"""
Which Gen-Z palette the print uses when the customer never picked one.

The editor preview starts on the layout's `defaultGenzPalette` when that
palette exists, else on the style's `defaultPalette` (butter) — see
useCalendarDefaults. `_resolve_genz_palette` must land on the same palette,
including when the named one can no longer be read: until 2026-10-12 a
deleted palette printed plain theme defaults while the preview showed butter.

DB-free: the asset read is patched out.

Run with:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_genz_palette_default
"""
from __future__ import annotations

import sys
from unittest.mock import patch

from services import calendar_layout
from services.calendar_layout import FALLBACK_GENZ_PALETTE, _resolve_genz_palette

PALETTES = {"butter": {"name": "butter"}, "lilac": {"name": "lilac"}}


def _resolve(style, palettes=PALETTES):
    reads = []

    def fake_read(asset_type, name, what):
        assert asset_type == "calendar_palettes/genz", asset_type
        reads.append(name)
        return palettes.get(name)

    with patch.object(calendar_layout, "_read_calendar_asset", side_effect=fake_read):
        return _resolve_genz_palette(style), reads


def test_the_layout_default_is_printed_when_the_customer_never_picked():
    palette, reads = _resolve({"defaultGenzPalette": "lilac"})
    assert palette == {"name": "lilac"}, palette
    assert reads == ["lilac"], reads


def test_no_layout_default_prints_the_fallback_the_preview_starts_on():
    assert FALLBACK_GENZ_PALETTE == "butter"
    palette, reads = _resolve({})
    assert palette == {"name": "butter"}, palette
    assert reads == ["butter"], reads


def test_a_palette_that_no_longer_exists_prints_the_fallback():
    palette, reads = _resolve({"defaultGenzPalette": "deleted"})
    assert palette == {"name": "butter"}, palette
    assert reads == ["deleted", "butter"], reads


def test_a_missing_fallback_is_read_once_and_gives_theme_defaults():
    palette, reads = _resolve({}, palettes={})
    assert palette is None
    assert reads == ["butter"], reads


def test_a_bogus_name_never_reaches_storage():
    palette, reads = _resolve({"defaultGenzPalette": "../etc"})
    assert palette is None
    assert reads == [], reads


if __name__ == "__main__":
    failed = 0
    tests = [(n, fn) for n, fn in sorted(globals().items())
             if n.startswith("test_") and callable(fn)]
    print(f"Running {len(tests)} Gen-Z palette default tests …")
    for name, fn in tests:
        try:
            fn()
            print(f"  OK  {name}")
        except Exception as e:
            print(f"  FAIL {name}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed} test(s) FAILED")
        sys.exit(1)
    print(f"\nAll {len(tests)} Gen-Z palette default tests passed.")
