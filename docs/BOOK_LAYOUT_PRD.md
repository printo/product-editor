# PRD — Book / Photobook Layout Creator

**Status:** Draft, not scheduled. Written 2026-07-26 so the design decisions are captured while the calendar precedent is fresh.
**Author:** Kanna Perumal (with Claude Code)
**Related:** [`CALENDAR_FEATURE_PRD.md`](CALENDAR_FEATURE_PRD.md) — the calendar product is the closest precedent and this PRD deliberately mirrors its architecture. [`API_SURFACE_SEPARATION_PRD.md`](API_SURFACE_SEPARATION_PRD.md) — the render-submission cleanup this feature should land on top of, not around.

---

## 1. TL;DR

A photobook is a multi-page product: N leaves, each with a front and back, bound together. Today Product Editor models a product as either a **single canvas** or a **multi-surface product** with a small fixed set of named surfaces (`front`, `back`, …). Neither shape expresses "24 pages, laid out as 12 spreads, where page count is chosen by the customer."

This PRD proposes `productType: "book"` as a **third product type**, following the exact pattern the calendar product established: one authored template + a server-side materializer that expands it into concrete surfaces at render time.

**The single most important design claim:** a book should reuse the calendar's *materialize* architecture, not the calendar's *renderer*. `materialize_surfaces()` expanding one template into 12 month-surfaces is structurally the same problem as expanding one template into N page-surfaces. The month-grid drawing code is not reusable and should not be forced.

**Why this is a separate creator UI, not a checkbox on the existing one:** page-count is customer-variable, pages come in ordered pairs, and the ops author needs to think in spreads rather than a flat surface list. That is a different mental model and a different screen — the same reasoning that gave the calendar its own route at `/editor/layouts/calendar/[name]`.

---

## 2. Use cases

| # | Actor | Story |
|---|---|---|
| U1 | Ops | Author a book template once — trim size, page count range, bleed, gutter, cover treatment — and publish it as a SKU-mappable layout. |
| U2 | Ops | Define per-page-role templates (cover, inside-cover, standard page, last page) without hand-authoring every page. |
| U3 | Customer | Upload photos, see them auto-flowed across pages, reorder and swap, and preview facing pages as a spread the way the printed book will read. |
| U4 | Customer | Add or remove pages within the allowed range and see the price/page-count implication (price is out of scope here; the count is not). |
| U5 | Partner backend | Create an embed session against a book SKU and receive the same signed-webhook ZIP contract as any other product. |
| U6 | Print ops | Receive print files whose page order, orientation and bleed are unambiguous — one file per printed side, named so collation is mechanical. |

---

## 3. Current state — what we build on

Facts verified against the codebase at commit `4105f66`; re-verify before implementing.

### 3.1 Product types today

- **Single canvas** — `layout.canvas` + `layout.frames[]`.
- **Multi-surface** — `layout.surfaces[]`, each with its own frames. `_generate_for_surface` renders each independently; `canvases_meta` slices photos/transforms/overlays per surface so an omitted side prints blank rather than duplicating another side (see CLAUDE.md, "Per-surface render grouping").
- **Calendar** — `productType: "calendar"`, expanded by `services/calendar_layout.py::materialize_surfaces()` into 12 surfaces at render time, with per-surface overrides and auto-derived `displayLabel`.

### 3.2 What already generalises

| Capability | Where | Reusable for books? |
|---|---|---|
| Template → N surfaces expansion | `calendar_layout.py::materialize_surfaces()` | **Yes — the core pattern.** Not the month logic. |
| Per-surface render slicing | `tasks.py::_extract_canvases_meta` → `engine.generate(canvases_meta=…)` | Yes, directly |
| `displayLabel` → output filename | `engine.py` (P7.1) | Yes — becomes `Page 07.png` |
| Partial-failure cleanup | `engine.py` (P7.2) | Yes, unchanged |
| Per-surface overrides | `calendar_layout.py` §10.2.1 | Yes — per-page overrides are the same shape |
| Server-side overlay rendering | `services/overlay_renderer.py` | Yes |
| Colour-managed image load | `services/image_loader.py` | Yes — mandatory, never bypass |
| Chunked upload + IDB persistence | `upload-utils.ts`, `file-store.ts` | Yes, unchanged |
| Ops authoring route pattern | `/editor/layouts/calendar/[name]` | Yes — clone the shape, not the content |
| Month-grid maths | `calendar.ts` ↔ `calendar_renderer.py` | **No.** Irrelevant to books. |

### 3.3 Constraints that must hold

- **Access-mode invariant** (CLAUDE.md): dashboard and embed flows must produce identical print output for the same inputs.
- **Three frame renderers**: FabricEditor (live), fabric-renderer (thumbnail), engine.py (print). Any new page-level drawing must land in all three or be pushed into a shared module. Prefer extending `frame-fill.ts` / a new shared module over a fourth parallel implementation.
- **TS↔Python parity tests** are the house pattern for any maths duplicated across the language boundary (`caption-layout`, `calendar`). Page/spread geometry will need the same treatment.
- **Layout identity is the filename**, never the JSON `name` field.

---

## 4. Open design decisions

**These need answers before implementation. They are the reason this PRD exists rather than a ticket.**

### D1 — Page model: leaves or sides? ← *highest impact*

Two candidate models:

- **(a) Flat page list.** `pages[]`, each entry one printed side. Simple, maps 1:1 to output files, matches how the render pipeline already thinks (one surface = one file).
- **(b) Leaf/sheet list.** `sheets[]`, each with `front` and `back`. Matches physical production and makes duplex imposition natural, but adds a translation layer before the renderer.

**Recommendation: (a) flat page list, with spread grouping derived for display.** The renderer, the ZIP contract and `canvases_meta` all already speak "one surface, one file". Physical sheet pairing is an imposition concern and `zip-utils` / the imposition sheet flow already exists for that. Deriving spreads for the *preview* is cheap; deriving pages from sheets for the *renderer* is a permanent tax.

### D2 — Is page count fixed by the template or chosen by the customer?

If customer-chosen, it becomes the first product where the **surface count is customer state**, which touches validation, autosave, the render payload, and pricing. Needs a range (`minPages`, `maxPages`, `pageStep` — books usually step in multiples of 4 because of how signatures fold).

**Recommendation:** template declares `pageCount: { min, max, step, default }`; customer picks within it. Do not ship an unbounded count.

### D3 — Photo → page mapping

The calendar settled on "12 outputs, month *i* gets photo-canvas *(i mod N)*". Books need an explicit answer for:
- fewer photos than pages (blank pages? repeat? refuse to submit?)
- more photos than pages (auto-extend page count up to `max`? drop? warn?)

**Recommendation:** auto-flow in upload order, one photo per frame; short-fill leaves genuinely blank pages (a real product need — people leave pages for writing); overflow warns and offers to extend to the next valid page count. Warn-and-proceed, never block — consistent with `submit-guards.ts`.

### D4 — Cover treatment

Covers usually differ: different trim (wrap + spine), different material, sometimes a different bleed. Is the cover:
- a page in the same list with a `role: "cover"` override, or
- a separate surface authored independently?

**Recommendation:** `role` on the page entry, with a per-role template block. Keeps one ordered list. Spine width depends on page count × paper thickness — that is a **computed** dimension and needs a formula in the template (`spineWidthMm = pageCount * paperThicknessMm`), which is a genuinely new concept for this codebase.

### D5 — Gutter / safe area on inner edges

Bound edges lose content into the spine. Needs an inner-margin concept that flips per page parity (left page's gutter is on its right edge and vice versa). This has no equivalent in any existing product type.

### D6 — Does the customer editor show single pages or spreads?

Spreads read like the real book but double the canvas width and complicate per-frame editing. Single pages are simpler and reuse the existing canvas-card grid almost unchanged.

**Recommendation:** edit single pages, preview spreads. A read-only spread preview is much cheaper than a spread-native editor.

---

## 5. Proposed architecture (assuming the recommendations above)

### 5.1 Schema sketch

```jsonc
{
  "name": "softcover_a4_landscape",          // = filename stem, authoritative
  "productType": "book",
  "tags": ["Photobook"],
  "book": {
    "trim":       { "widthMm": 297, "heightMm": 210 },
    "bleedMm":    3,
    "gutterMm":   12,                         // inner margin, mirrored by parity
    "pageCount":  { "min": 20, "max": 60, "step": 4, "default": 24 },
    "paperThicknessMm": 0.12,                 // → spine width
    "roles": {
      "cover":       { "template": "cover",       "spine": true },
      "insideCover": { "template": "blank" },
      "page":        { "template": "single-photo" },
      "backCover":   { "template": "blank" }
    },
    "templates": {
      "single-photo": { "frames": [ /* … as today, in mm … */ ] },
      "two-up":       { "frames": [ /* … */ ] },
      "blank":        { "frames": [] },
      "cover":        { "frames": [ /* … */ ] }
    }
  },
  "pageOverrides": {                          // ops escape hatch, same shape as calendar surfaceOverrides
    "3": { "template": "two-up" }
  }
}
```

### 5.2 New server module

`backend/django/services/book_layout.py`

```python
def materialize_pages(layout: dict, *, page_count: int | None = None,
                      overrides: dict | None = None) -> list[dict]:
    """Expand a book template into concrete per-page surface dicts.

    Mirrors services/calendar_layout.py::materialize_surfaces — same contract,
    same override semantics, same auto-derived displayLabel. Returns surfaces
    the existing engine can render unmodified.
    """
```

Each returned surface carries `displayLabel` (`"Page 07"`, `"Cover"`), `role`, `pageIndex`, and a `gutterSide` of `"left" | "right" | null` so the renderer can mirror the inner margin without re-deriving parity.

**Explicitly not needed:** a `book_renderer.py`. Unlike a calendar, a book page is just frames — the existing `_composite_canvas` path already draws it. If a page ever needs page numbers, that is an overlay, not a renderer.

### 5.3 Shared geometry (parity-tested)

`frontend/nextjs/src/lib/book-layout.ts` ↔ `services/book_layout.py`, pinned by parity suites on both sides, following `caption-layout` / `calendar`:

- `resolvePageGeometry(trim, bleed, gutter, pageIndex)` → the frame rect after gutter mirroring
- `spineWidthMm(pageCount, paperThicknessMm)`
- `pagesToSpreads(pages)` → display grouping (page 1 alone, then pairs, last alone)

### 5.4 Touch list

| Area | Change |
|---|---|
| `api/validators.py` | `validate_book_layout` mirroring `validate_calendar_layout` |
| `layout_engine/engine.py` | detect `productType == "book"` → `materialize_pages()`; no renderer change |
| `api/tasks.py` | `_extract_book_state` (page count + per-page overrides), alongside `_extract_calendar_state` |
| `api/views.py` | no new endpoint if the book template is served by the existing layout endpoints |
| Embed proxy allowlist | **no new prefixes** if the above holds — verify, since adding one is a security-review item |
| `/editor/layouts/book/[name]` | new ops authoring route |
| `BookProductPreview.tsx` | customer spread preview |
| `page.tsx` (editor) | page-count control; auto-flow; reuse existing canvas cards |

---

## 6. Phasing

Sized against the calendar build, which ran ~10 phases / ~25 days.

| Phase | Scope | Est. |
|---|---|---|
| 0 | **Resolve D1–D6.** No code. | 1 d |
| 1 | Schema + `validate_book_layout` + fixtures | 2 d |
| 2 | `book_layout.py::materialize_pages` + Python parity tests | 3 d |
| 3 | `book-layout.ts` + TS parity suite (`pnpm test:parity`) | 2 d |
| 4 | Engine integration, per-page filenames, partial-failure path | 2 d |
| 5 | Ops authoring UI `/editor/layouts/book/[name]` | 4 d |
| 6 | Customer page editor + auto-flow + page-count control | 4 d |
| 7 | Spread preview | 2 d |
| 8 | Cover + spine (depends on D4) | 3 d |
| 9 | Smoke test `scripts/smoke-test-book.sh`, docs, CLAUDE.md | 2 d |

**~25 days**, excluding pricing integration, which is out of scope.

---

## 7. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Customer-variable surface count is new; autosave/restore/render-payload all assume a fixed set | High | Phase 1 must nail the payload shape; extend `canvas-merge.ts` identity logic to pages |
| R2 | Spine width is computed from page count — a wrong formula prints an unusable cover | High | Parity-test the formula; require an ops preview showing the resolved spine before publish |
| R3 | Gutter parity mirroring is easy to get backwards and only shows up in print | High | Parity tests + a preview that labels left/right pages explicitly |
| R4 | 60-page books × 300 DPI could blow the render time/memory budget (calendar's 12 surfaces take ~1.8 s) | Medium | Benchmark at `max` early; the engine already closes images and GCs per canvas |
| R5 | A fourth frame renderer sneaks in | Medium | Route all new drawing through shared modules; call it out in review |
| R6 | ZIP with 60 files strains the Next.js proxy's full-buffer download | Medium | Known limitation (CLAUDE.md); may force the streaming fix this product's scale finally justifies |

---

## 8. Out of scope

- Pricing / page-count → price
- Spine text or barcode generation
- PDF imposition for the printer (existing imposition flow is separate)
- Auto-layout intelligence (face-aware placement, story ordering)
- Collaborative editing

---

## 9. What to do next

1. Answer **D1–D6**. D1 and D2 gate everything else.
2. Confirm the real product spec with Catalog Ops: actual trim sizes, page ranges, paper thickness, cover types.
3. Re-verify §3 against `HEAD` — this PRD was written against `4105f66`.
4. Only then open Phase 1.
