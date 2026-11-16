"""
Front and back cover sheets for the calendar product type.

A calendar layout may carry `frontCover` and/or `backCover`, each a plain
generic-layout block (`canvas`, `frames`, `overlays`, mask fields). A cover is
always its own sheet, printed ahead of the months (front) or after them
(back); the unprinted inside of a cover is not a surface and is never shown.

Pure and DB-free. TS twin: `lib/calendar-covers.ts`, pinned by
storage/parity-fixtures/calendar-cover-order.json.
"""
from __future__ import annotations

import copy
from typing import Optional

COVER_FRONT = "cover_front"
COVER_BACK = "cover_back"
COVER_KEYS = (COVER_FRONT, COVER_BACK)

#: layout key holding each cover's block
LAYOUT_KEY = {COVER_FRONT: "frontCover", COVER_BACK: "backCover"}
LABEL = {COVER_FRONT: "Front Cover", COVER_BACK: "Back Cover"}


def is_cover_key(key) -> bool:
    return key in COVER_KEYS


def cover_block(layout: dict, key: str) -> Optional[dict]:
    """The authored block for a cover, or None when the layout has none."""
    block = (layout or {}).get(LAYOUT_KEY[key])
    return block if isinstance(block, dict) and isinstance(block.get("canvas"), dict) else None


def cover_keys_present(layout: dict) -> list[str]:
    """Cover keys this layout carries, in print order (front, back)."""
    return [k for k in COVER_KEYS if cover_block(layout, k)]


def cover_surface(layout: dict, key: str) -> dict:
    """A cover as an ordinary surface the engine renders with no calendar grid."""
    block = cover_block(layout, key)
    if block is None:
        raise ValueError(f"layout has no {LAYOUT_KEY[key]}")
    return {
        "key": key,
        "displayLabel": LABEL[key],
        "canvas": copy.deepcopy(block["canvas"]),
        "frames": copy.deepcopy(block.get("frames") or []),
        "overlays": copy.deepcopy(block.get("overlays") or []),
        "maskUrl": block.get("maskUrl"),
        "maskOnExport": bool(block.get("maskOnExport", False)),
    }


def numbered_label(position: int, label: str) -> str:
    """`00 Front Cover`: a numeric prefix so an alphabetical ZIP listing is print order."""
    return f"{position:02d} {label}"


def split_payload(canvases_meta, image_paths, frame_transforms, overlays, backgrounds):
    """
    Separate cover canvases from month canvases in a render payload.

    `canvases_meta` is [{'surface_key', 'frame_count'}, ...] in canvas order;
    `image_paths` and `frame_transforms` run per FRAME, `overlays` and
    `backgrounds` per CANVAS. Returns (months, covers): `months` is one bundle,
    `covers` maps a cover key to its bundle. A bundle is a dict of `meta`,
    `images`, `transforms`, `overlays`, `backgrounds`; an input that was empty
    stays empty so the engine's "absent" paths still apply.
    """
    def bundle():
        return {"meta": [], "images": [], "transforms": [], "overlays": [], "backgrounds": []}

    months, covers = bundle(), {k: bundle() for k in COVER_KEYS}
    pos = 0
    for i, m in enumerate(canvases_meta):
        count = max(0, int(m.get("frame_count") or 0))
        lo, hi = pos, pos + count
        pos = hi
        b = covers[m.get("surface_key")] if m.get("surface_key") in covers else months
        b["meta"].append(m)
        b["images"].extend((image_paths or [])[lo:hi])
        if frame_transforms:
            b["transforms"].extend(frame_transforms[lo:hi])
        if overlays:
            b["overlays"].append(overlays[i] if i < len(overlays) else [])
        if backgrounds:
            b["backgrounds"].append(backgrounds[i] if i < len(backgrounds) else {})
    return months, covers


def sheet_labels(layout: dict, month_labels: list[str]) -> list[dict]:
    """
    Every printed sheet of an order in print order with its file label:
    front cover, the months, back cover. Numbered only when a cover exists,
    so a calendar without covers keeps its plain month names.

    TS twin: `sheetLabels` in lib/calendar-covers.ts, pinned by
    storage/parity-fixtures/calendar-cover-order.json.
    """
    present = cover_keys_present(layout)
    sheets = []
    if COVER_FRONT in present:
        sheets.append({"key": COVER_FRONT, "label": LABEL[COVER_FRONT]})
    sheets.extend({"key": f"month_{i + 1:02d}", "label": m} for i, m in enumerate(month_labels))
    if COVER_BACK in present:
        sheets.append({"key": COVER_BACK, "label": LABEL[COVER_BACK]})
    if not present:
        return sheets
    return [{"key": s["key"], "label": numbered_label(i, s["label"])} for i, s in enumerate(sheets)]
