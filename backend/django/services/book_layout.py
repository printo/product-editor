"""
Server-side helpers for the book / booklet / photobook product type
(BOOK_LAYOUT_PRD.md §5).

A book layout is stored as a template holding exactly TWO authored page
templates — a cover and ONE inner page — plus a customer-chosen page count
(PRD D2 / D2a). This module expands that template into concrete per-page
surface dicts the existing multi-surface engine path renders unmodified,
exactly as `services/calendar_layout.py::materialize_surfaces` does for the
12 months of a calendar.

The design decisions this module implements, all settled 2026-08-14:

D1  Flat page list. `materialize_pages` returns one entry per printed SIDE,
    in physical order: front cover, page 1 … page N, back cover. Sheet
    pairing is an imposition concern and deliberately not modelled here —
    the renderer, the ZIP contract and `canvases_meta` all already speak
    "one surface, one file".

D2  Page count is CUSTOMER state, clamped to the template's
    `book.pageCount {min,max,step}`. Covers sit OUTSIDE that count and are
    addressed by role, never by index, so changing the count cannot
    renumber them.

D5  One `book.gutterMm` per template, mirrored by page parity. The ops
    author lays out ONE inner page; a margin baked into that template
    would sit on the wrong edge for half the book. See `gutter_side_for`
    and `apply_gutter` for the exact semantics.

D7  Each role carries its OWN canvas block, so a hardcover wrap larger
    than the block it binds needs no new concept — `_generate_for_surface`
    already reads `surface["canvas"]` per surface.

Explicitly NOT here: a `book_renderer.py`. Unlike a calendar, a book page
is just frames, and `_composite_canvas` already draws those. Page numbers,
if ever wanted, are an overlay.
"""
from __future__ import annotations

import copy
import logging
from typing import Optional

logger = logging.getLogger(__name__)


# ── Roles ───────────────────────────────────────────────────────────────────

ROLE_COVER = "cover"
ROLE_INNER = "inner"
ROLE_BACK_COVER = "backCover"

#: Template key under `book` for each role that the ops author authors.
_ROLE_TEMPLATE_KEY = {
    ROLE_COVER: "cover",
    ROLE_INNER: "innerPage",
    ROLE_BACK_COVER: "backCover",
}

#: Human-readable role labels used in `displayLabel` (PRD U6 — collation
#: must be mechanical, so these also carry a numeric ordinal prefix).
_ROLE_LABEL = {
    ROLE_COVER: "Front Cover",
    ROLE_BACK_COVER: "Back Cover",
}

_DEFAULT_PAGE_COUNT = 24
_DEFAULT_STEP = 4


# ── Page count resolution (D2) ──────────────────────────────────────────────

def page_count_bounds(layout: dict) -> tuple[int, int, int, int]:
    """
    Return `(min, max, step, default)` for a book layout's page count.

    Falls back to a 4-step book of `_DEFAULT_PAGE_COUNT` pages when the
    template omits the block — defensive only; `validate_book_layout`
    requires it at save time.
    """
    book = layout.get("book") or {}
    spec = book.get("pageCount") or {}
    step = int(spec.get("step") or _DEFAULT_STEP)
    if step < 1:
        step = 1
    lo = int(spec.get("min") or step)
    hi = int(spec.get("max") or max(lo, _DEFAULT_PAGE_COUNT))
    default = int(spec.get("default") or lo)
    if hi < lo:
        lo, hi = hi, lo
    return lo, hi, step, default


def resolve_page_count(layout: dict, requested: Optional[int] = None) -> int:
    """
    Clamp a customer-requested page count onto the template's allowed grid.

    Books step in multiples of `step` (usually 4, because of how signatures
    fold), so a request of 26 on a step-4 template resolves to 28 — rounding
    UP, never down, so the customer never silently loses a page they asked
    for. `None` resolves to the template default.

    The clamp lives here rather than in the view because BOTH the render
    path and the editor need the identical answer: a book that previews as
    28 pages must print 28 pages.
    """
    lo, hi, step, default = page_count_bounds(layout)

    if requested is None:
        value = default
    else:
        try:
            value = int(requested)
        except (TypeError, ValueError):
            logger.warning(
                "Non-integer page count %r — falling back to template default %d",
                requested, default,
            )
            value = default

    if value < lo:
        value = lo
    if value > hi:
        value = hi

    # Snap UP to the step grid, anchored at `lo` so a min of 20 with step 4
    # yields 20, 24, 28 … rather than 20, 22, 26.
    offset = value - lo
    if offset % step:
        value = lo + ((offset // step) + 1) * step
    if value > hi:
        # Snapping up overshot the ceiling — the ceiling itself is the only
        # honest answer left (an ops template with max not on the grid).
        value = hi
    return value


# ── Page parity / gutter side (D5) ──────────────────────────────────────────

def gutter_side_for(page_index: int) -> str:
    """
    Which edge of this page is bound into the spine.

    Page 1 is a recto — the right-hand page of a spread — so its bound edge
    is on the LEFT. Page 2 is its verso, the left-hand page of the next
    spread, bound on the RIGHT. Odd pages therefore bind left, even pages
    bind right, and the two pages facing each other across a spread are
    mirror-symmetric about the spine.

    Getting this backwards pushes every photo INTO the fold and only shows
    up in print, which is why it is a named function with parity tests on
    both sides of the language boundary rather than an inline `% 2`.
    """
    return "left" if page_index % 2 == 1 else "right"


def _canvas_width_mm(canvas: dict) -> Optional[float]:
    """
    Physical width of a canvas in mm, derived from `dpi` when `widthMm` is
    absent. Returns None when neither is available — callers then skip the
    gutter shift rather than guess (a wrong shift prints wrong; no shift
    merely prints the template as authored).
    """
    width_mm = canvas.get("widthMm")
    if isinstance(width_mm, (int, float)) and width_mm > 0:
        return float(width_mm)
    width_px = canvas.get("width")
    dpi = canvas.get("dpi")
    if (
        isinstance(width_px, (int, float)) and width_px > 0
        and isinstance(dpi, (int, float)) and dpi > 0
    ):
        return float(width_px) / float(dpi) * 25.4
    return None


def gutter_shift_fraction(
    frames: list,
    overlays: list,
    gutter_mm: float,
    canvas_width_mm: Optional[float],
    gutter_side: str,
) -> float:
    """
    Resolve the horizontal shift to apply to one page, as a fraction of
    canvas width. Positive shifts right, negative shifts left.

    Semantics of `book.gutterMm` (the definition ops is typing a number
    into): it is the TOTAL extra separation opened up between the two pages
    of a spread. Each page therefore moves `gutterMm / 2` AWAY from its own
    bound edge, which keeps the spread mirror-symmetric and leaves the
    authored design untouched apart from its position.

    The shift is UNIFORM across the whole page and reduced — never applied
    per-frame — so a collage never distorts internally. If the tightest
    frame or overlay can only absorb part of the shift, every element moves
    by that smaller amount together. A page whose content already touches
    the outer edge therefore simply does not move.
    """
    if not gutter_mm or gutter_mm <= 0:
        return 0.0
    if not canvas_width_mm or canvas_width_mm <= 0:
        return 0.0

    desired = (gutter_mm / 2.0) / canvas_width_mm
    direction = 1.0 if gutter_side == "left" else -1.0

    # Headroom is the smallest distance to the edge we are shifting toward,
    # across every positioned element on the page.
    headroom = 1.0
    for f in frames or []:
        if not isinstance(f, dict):
            continue
        x = _as_float(f.get("x"))
        w = _as_float(f.get("width"))
        if x is None or w is None:
            continue
        room = (1.0 - (x + w)) if direction > 0 else x
        headroom = min(headroom, max(0.0, room))
    for o in overlays or []:
        if not isinstance(o, dict):
            continue
        # Overlays use PERCENT coords (0-100), not 0..1 fractions — see the
        # overlay contract enforced in api/validators.py.
        x = _as_float(o.get("x"))
        w = _as_float(o.get("width"))
        if x is None:
            continue
        x /= 100.0
        w = (w / 100.0) if w is not None else 0.0
        room = (1.0 - (x + w)) if direction > 0 else x
        headroom = min(headroom, max(0.0, room))

    return direction * min(desired, headroom)


def apply_gutter(
    frames: list,
    overlays: list,
    gutter_mm: float,
    canvas: dict,
    gutter_side: str,
) -> tuple[list, list]:
    """
    Return `(frames, overlays)` shifted away from the bound edge.

    Both the fractional (`x`) and millimetre (`xMm`) representations are
    moved, because the engine normalizes from the fraction while the ops
    authoring UI reads the mm — leaving one behind would make the print and
    the preview disagree, which is the exact drift class this codebase
    guards against (CLAUDE.md, "Three frame renderers").
    """
    canvas_width_mm = _canvas_width_mm(canvas or {})
    dx = gutter_shift_fraction(frames, overlays, gutter_mm, canvas_width_mm, gutter_side)
    if not dx:
        return frames, overlays

    dx_mm = dx * canvas_width_mm if canvas_width_mm else 0.0

    shifted_frames = []
    for f in frames or []:
        if not isinstance(f, dict):
            shifted_frames.append(f)
            continue
        out = dict(f)
        x = _as_float(f.get("x"))
        if x is not None:
            out["x"] = x + dx
        x_mm = _as_float(f.get("xMm"))
        if x_mm is not None:
            out["xMm"] = x_mm + dx_mm
        shifted_frames.append(out)

    shifted_overlays = []
    for o in overlays or []:
        if not isinstance(o, dict):
            shifted_overlays.append(o)
            continue
        out = dict(o)
        x = _as_float(o.get("x"))
        if x is not None:
            out["x"] = x + dx * 100.0
        shifted_overlays.append(out)

    return shifted_frames, shifted_overlays


def _as_float(value) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


# ── Spine width (D4 / R2) ───────────────────────────────────────────────────

def spine_width_mm(
    page_count: int,
    paper_thickness_mm: float,
    cover_thickness_mm: float = 0.0,
) -> float:
    """
    Spine width for a book of `page_count` printed SIDES.

    `paper_thickness_mm` is the thickness of ONE LEAF of paper — one sheet
    with two printed sides. A 24-page book is therefore 12 leaves thick,
    not 24, and the formula is:

        spine = (page_count / 2) × paper_thickness_mm
                + 2 × cover_thickness_mm

    ⚠️ This differs from the formula sketched in BOOK_LAYOUT_PRD.md §4 D4
    (`pageCount × paperThicknessMm`), which double-counts by treating every
    printed side as its own sheet. The definition above is the physically
    correct one, but WHICH definition ops means by "paper thickness" has not
    been confirmed with Catalog Ops — a paper spec quoted per-side rather
    than per-leaf would halve the answer. R2 in the PRD calls a wrong spine
    an unusable cover, so this stays parity-tested on both sides of the
    language boundary and must be signed off against a real printed sample
    before any cover ships.
    """
    if page_count <= 0 or paper_thickness_mm <= 0:
        return max(0.0, 2.0 * cover_thickness_mm)
    return (page_count / 2.0) * paper_thickness_mm + 2.0 * cover_thickness_mm


# ── Display labels (U6 — mechanical collation) ───────────────────────────────

def display_label_for(role: str, page_index: Optional[int], ordinal: int, total: int) -> str:
    """
    Filename stem for one printed side, e.g. `"01 Front Cover"`,
    `"02 Page 01"`, `"26 Back Cover"`.

    The leading ordinal is the physical output position, zero-padded to the
    width of the total output count, so a plain alphabetical listing of the
    ZIP is already collation order — print ops should never have to reason
    about page order (PRD U6). The role or page number follows so a single
    file is still self-describing out of context.

    Engine-side `_sanitize_for_filename` keeps spaces, so these read
    naturally as filenames (same convention as "January 2026.png").
    """
    width = max(2, len(str(max(1, total))))
    prefix = str(ordinal).zfill(width)
    if role in _ROLE_LABEL:
        return f"{prefix} {_ROLE_LABEL[role]}"
    page_width = max(2, len(str(max(1, total))))
    return f"{prefix} Page {str(page_index or 0).zfill(page_width)}"


# ── Spread grouping (D6 — edit single pages, preview spreads) ────────────────

def pages_to_spreads(pages: list) -> list[list]:
    """
    Group a flat page list into how the bound book reads.

    Covers stand alone. Page 1 is a recto with nothing modelled facing it
    (the inside-front-cover is not a surface), so it stands alone too; inner
    pages then pair up (2,3), (4,5) …; a trailing verso stands alone.

    Purely a DISPLAY concern — the renderer never sees spreads. Kept here so
    the customer preview and any future ops proof read identically, and
    parity-tested against the TS twin.
    """
    covers_front = [p for p in pages if p.get("role") == ROLE_COVER]
    covers_back = [p for p in pages if p.get("role") == ROLE_BACK_COVER]
    inner = [p for p in pages if p.get("role") == ROLE_INNER]

    spreads: list[list] = [[c] for c in covers_front]
    if inner:
        spreads.append([inner[0]])
        rest = inner[1:]
        for i in range(0, len(rest), 2):
            spreads.append(rest[i:i + 2])
    spreads.extend([c] for c in covers_back)
    return spreads


# ── Materialization (§5.2) ──────────────────────────────────────────────────

def materialize_pages(
    layout: dict,
    *,
    page_count: Optional[int] = None,
    overrides: Optional[dict] = None,
) -> list[dict]:
    """
    Expand a book template into concrete per-page surface dicts.

    Mirrors `services/calendar_layout.py::materialize_surfaces` — same
    contract, same override semantics, same auto-derived `displayLabel`.
    The returned list is renderable by the existing engine per-surface loop
    with no renderer changes.

    Args:
        layout: parsed layout JSON for a `productType == 'book'` layout.
            Must already pass `validate_book_layout()`.
        page_count: the CUSTOMER's page count (D2). Clamped onto the
            template's min/max/step grid. `None` uses the template default.
        overrides: per-page ops overrides, keyed by page index as a string
            (`{"3": {"frames": [...]}}`). Merged on top of `layout`'s own
            `pageOverrides`, so a caller can layer without mutating.

    Returns:
        Surfaces in physical print order — front cover, page 1 … page N,
        back cover — each carrying:
            key:          "cover" | "page_07" | "back_cover"
            role:         "cover" | "inner" | "backCover"
            pageIndex:    1-based page number; None for covers
            displayLabel: "02 Page 01"  (U6)
            gutterSide:   "left" | "right" | None (None on covers)
            canvas:       the ROLE's canvas (D7) — covers may differ in size
            frames:       role template, gutter-shifted, or a page override
            overlays:     role template overlays, gutter-shifted
            spineWidthMm: resolved spine, on cover surfaces only (D4)
            pageCount:    the resolved count, echoed for downstream callers
    """
    if layout.get("productType") != "book":
        raise ValueError("materialize_pages() requires productType == 'book'")

    book = layout.get("book") or {}
    if not book:
        raise ValueError("book layout has no `book` block")

    resolved_count = resolve_page_count(layout, page_count)
    gutter_mm = float(book.get("gutterMm") or 0)
    default_bleed = book.get("bleedMm")

    merged_overrides = dict(layout.get("pageOverrides") or {})
    if overrides:
        merged_overrides.update(overrides)

    # Front cover, N inner pages, back cover — covers always present and
    # outside the customer's count (D2 / D4).
    plan: list[tuple[str, Optional[int]]] = [(ROLE_COVER, None)]
    plan.extend((ROLE_INNER, i) for i in range(1, resolved_count + 1))
    plan.append((ROLE_BACK_COVER, None))
    total_outputs = len(plan)

    spine = spine_width_mm(
        resolved_count,
        float(book.get("paperThicknessMm") or 0),
        float(book.get("coverThicknessMm") or 0),
    )

    surfaces: list[dict] = []
    for ordinal, (role, page_index) in enumerate(plan, start=1):
        template = book.get(_ROLE_TEMPLATE_KEY[role])
        if not isinstance(template, dict):
            # A back cover is legitimately allowed to be absent-but-blank in
            # a template that only authors a front; fall back to the front
            # cover's canvas so the side still prints at the right size.
            if role == ROLE_BACK_COVER:
                template = {"canvas": (book.get("cover") or {}).get("canvas") or {}, "frames": []}
            else:
                raise ValueError(f"book layout is missing the `{_ROLE_TEMPLATE_KEY[role]}` template")

        canvas = copy.deepcopy(template.get("canvas") or {})
        if default_bleed is not None and canvas.get("bleedMm") is None:
            canvas["bleedMm"] = default_bleed

        key = (
            "cover" if role == ROLE_COVER
            else "back_cover" if role == ROLE_BACK_COVER
            else f"page_{page_index:02d}"
        )

        override = merged_overrides.get(str(page_index)) if page_index is not None else None
        override = override if isinstance(override, dict) else {}

        frames = copy.deepcopy(override.get("frames", template.get("frames") or []))
        overlays = copy.deepcopy(override.get("overlays", template.get("overlays") or []))

        # Gutter mirroring applies to INNER pages only. Covers were settled
        # as sharing the template's single gutter figure (D5 option a, not
        # the per-role variant), and a wrap cover's fold sits mid-canvas
        # rather than at an edge, so shifting one would be actively wrong.
        gutter_side = gutter_side_for(page_index) if role == ROLE_INNER else None
        if gutter_side:
            frames, overlays = apply_gutter(frames, overlays, gutter_mm, canvas, gutter_side)

        surface = {
            "key": key,
            "role": role,
            "pageIndex": page_index,
            "displayLabel": display_label_for(role, page_index, ordinal, total_outputs),
            "gutterSide": gutter_side,
            "canvas": canvas,
            "frames": frames,
            "overlays": overlays,
            "maskUrl": template.get("maskUrl") or layout.get("maskUrl"),
            "maskOnExport": bool(
                template.get("maskOnExport", layout.get("maskOnExport", False))
            ),
            "pageCount": resolved_count,
        }
        if role in (ROLE_COVER, ROLE_BACK_COVER):
            surface["spineWidthMm"] = spine

        surfaces.append(surface)

    return surfaces
