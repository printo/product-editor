# PRD — Book / Booklet / Photobook Layout Creator

**Scope note:** "book" here means any **bound, page-ordered product** — photobook, booklet, brochure, notebook, catalogue. The page model below is deliberately product-agnostic; "photobook" is the first SKU family, not the boundary.

**Status:** 🟡 **Phases 0–4 built (backend only): schema, validator, materializer, engine dispatch, TS↔Python parity tests.** No UI exists yet — ops authoring route, customer page editor/page-count control, and spread preview (Phases 5–7) are unstarted. Written 2026-07-26; re-verified 2026-08-14 against `main` @ `79104d0` before Phase 0 opened. The `API_SURFACE_SEPARATION_PRD.md` cleanup this is meant to land on top of has also not started, so §5.4's touch list is unchanged.

**Updated 2026-08-14 (product direction):** D2 and D4 answered (customer-entered page count auto-populating inner pages; author only a cover template and a single inner-page template); D7 (per-role page size) added and answered same day.

**Updated 2026-08-14 (D1/D3/D5/D6/D7 closed, Phase 0–4 built):** all remaining open decisions answered by Kanna — **D1 flat page list** (as recommended), **D3 flow-in-order / blanks stay blank / warn-and-offer-extend on overflow** (as recommended), **D5 one `gutterMm` figure mirrored by page parity** (as recommended), **D6 edit single pages, preview spreads** (as recommended), **D7(b) one ZIP with covers named to sort first**, no separate archive part. Implementation: `backend/django/services/book_layout.py` (materializer), `api/validators.py::validate_book_layout`, `layout_engine/engine.py` dispatch + `GenerateLayoutView` guard (books require `canvases_meta`, unsupported via the direct partner sync endpoint), `api/tasks.py::_extract_book_state`, TS twin `frontend/nextjs/src/lib/book-layout.ts`. See CLAUDE.md § "Book / booklet / photobook product type" for the full rundown, including one unresolved item: the spine-width formula implemented (`pageCount/2 leaves × paperThicknessMm`) differs from this PRD's §4 D4 sketch (`pageCount × paperThicknessMm`, which double-counts) — needs Catalog Ops sign-off on which convention their paper spec uses. R1 (customer-variable surface count) remains open on the frontend; nothing in `page.tsx`/`canvas-merge.ts`/autosave has been touched.
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

### D1 — Page model: leaves or sides? ← *highest impact* — ✅ **ANSWERED 2026-08-14**

**Decision: (a) flat page list**, as recommended below. Implemented in `services/book_layout.py::materialize_pages()` — returns pages in physical print order (front cover, page 1 … page N, back cover), one entry per printed side.

Two candidate models:

- **(a) Flat page list.** `pages[]`, each entry one printed side. Simple, maps 1:1 to output files, matches how the render pipeline already thinks (one surface = one file).
- **(b) Leaf/sheet list.** `sheets[]`, each with `front` and `back`. Matches physical production and makes duplex imposition natural, but adds a translation layer before the renderer.

**Recommendation: (a) flat page list, with spread grouping derived for display.** The renderer, the ZIP contract and `canvases_meta` all already speak "one surface, one file". Physical sheet pairing is an imposition concern and `zip-utils` / the imposition sheet flow already exists for that. Deriving spreads for the *preview* is cheap; deriving pages from sheets for the *renderer* is a permanent tax.

### D2 — Is page count fixed by the template or chosen by the customer? — ✅ **ANSWERED 2026-08-14**

**Decision: customer-entered, within a template-declared range.** The customer types a page count; the inner pages are then **auto-populated** from the single inner-page template, and the front and back covers are always present and never part of that count. This makes books the first product where the **surface count is customer state** — see R1, which this decision promotes from a risk to a certainty that Phase 1 must design for.

Template declares `pageCount: { min, max, step, default }`. Do not ship an unbounded count; books step in multiples of 4 because of how signatures fold.

**Consequences to design for:**
- Covers are addressed by role, never by index, so changing the page count cannot renumber them.
- Per-page overrides key off page index, so lowering the count must decide between discarding overrides on removed pages or holding them (recommend: hold, and restore if the count goes back up — this mirrors how the calendar keeps Feb 29 entries through a non-leap year, PRD §11.8).
- The autosave/restore path must survive a page-count change mid-session without losing edits on surviving pages — extend `canvas-merge.ts` identity reuse to pages.

### D2a — What does the ops author actually author? — ✅ **ANSWERED 2026-08-14**

**Decision: exactly two page templates — a cover and ONE inner page.** Everything else is derived. The author does not lay out page 7; they lay out "an inner page", and the materializer stamps it N times.

This is deliberately narrower than the `roles` map sketched in §5.1. Keep `pageOverrides` as the escape hatch for the occasional bespoke page, but the authoring UI's happy path is two canvases, not a page list.

### D3 — Photo → page mapping — ✅ **ANSWERED 2026-08-14**

**Decision: the recommendation below, as stated.** Auto-flow in upload order, one photo per frame; short-fill leaves genuinely blank pages; overflow warns and offers to extend to the next valid page count. Warn-and-proceed, never block. **Not yet implemented** — this is customer-editor logic (Phase 6), not part of the Phase 0–4 backend build.

The calendar settled on "12 outputs, month *i* gets photo-canvas *(i mod N)*". Books need an explicit answer for:
- fewer photos than pages (blank pages? repeat? refuse to submit?)
- more photos than pages (auto-extend page count up to `max`? drop? warn?)

**Recommendation:** auto-flow in upload order, one photo per frame; short-fill leaves genuinely blank pages (a real product need — people leave pages for writing); overflow warns and offers to extend to the next valid page count. Warn-and-proceed, never block — consistent with `submit-guards.ts`.

### D4 — Cover treatment — ✅ **ANSWERED 2026-08-14**

**Decision: front and back covers are authored separately from the inner page, and are always present.** They sit outside the customer's page count (see D2) and are addressed by role, not index.

They stay entries in the one ordered page list with `role: "cover" | "backCover"` — one list keeps the renderer, the ZIP contract and `canvases_meta` all speaking "one surface, one file". What changes versus the original recommendation is that a cover carries **its own canvas size**, not just its own frame template — see D7.

Spine width still depends on page count × paper thickness — a **computed** dimension needing a formula in the template (`spineWidthMm = pageCount * paperThicknessMm`), which is a genuinely new concept for this codebase. With D2 answered, the spine is now recomputed whenever the customer changes the page count, so it cannot be resolved once at author time.

### D7 — Per-role page size (cover ≠ inner) — ✅ **ANSWERED 2026-08-14**

**Decision: (a) `trim`/canvas per role**, as recommended. Each of `book.cover` / `book.innerPage` / `book.backCover` carries its own `canvas` block; `backCover` may omit it to inherit the cover's canvas. Implemented and validated (`validate_book_layout` requires a positive width/height on `cover` and `innerPage`; `backCover`'s canvas, if present, must be complete).

The mixed-size delivery question below is also answered: **one ZIP, covers named so they sort first** (no separate archive part). See D1/D4 note above.

**Sometimes the cover and the inner pages share a trim size; sometimes they do not.** A hardcover wrap is larger than the block it binds; a booklet cover is often identical to its inners. The §5.1 schema sketch assumes ONE book-level `trim`, which cannot express this.

Options:

- **(a) `trim` per role.** Each role declares its own `{ widthMm, heightMm, bleedMm }`, defaulting to the book-level value when absent. Simple, explicit, and matches how multi-surface layouts already work today — each surface carries its own `canvas` block, so the engine needs no change at all.
- **(b) One `trim` plus a cover `oversizeMm` delta.** Compact, and expresses the common "cover is 3 mm bigger all round" case, but cannot express a cover with a genuinely different aspect.

**Recommendation: (a).** It costs nothing at the engine — `_generate_for_surface` already reads `surface["canvas"]` per surface, so differing sizes fall out for free. (b) is a special case of (a) and can be sugar in the authoring UI rather than a schema concept.

**Resolved 2026-08-14:** one ZIP with differing page dimensions, covers named so they sort first (option chosen over a separate archive part — no partner webhook payload change needed, and printo.in hasn't built the current contract yet).

### D5 — Gutter / safe area on inner edges — ✅ **ANSWERED 2026-08-14**

**Decision: one `book.gutterMm` figure per template, auto-mirrored by page parity** (odd pages bind left, even pages bind right) — necessary because a single authored inner-page template is stamped onto both sides of every spread. Implemented in `services/book_layout.py::gutter_side_for` / `gutter_shift_fraction` / `apply_gutter`, parity-tested against the TS twin. The shift is half the gutter figure, applied uniformly across a page's frames/overlays and capped by the tightest element's headroom, so a collage page's elements move together rather than distorting. Covers are never shifted.

Bound edges lose content into the spine. Needs an inner-margin concept that flips per page parity (left page's gutter is on its right edge and vice versa). This has no equivalent in any existing product type.

### D6 — Does the customer editor show single pages or spreads? — ✅ **ANSWERED 2026-08-14**

**Decision: edit single pages, preview spreads**, as recommended. `services/book_layout.py::pages_to_spreads()` / `lib/book-layout.ts::pagesToSpreads()` group the flat page list for a read-only spread preview — page 1 alone, then facing pairs, trailing verso alone, covers always alone. **The spread preview UI itself is not built** (Phase 7); only the grouping function exists so far.

Spreads read like the real book but double the canvas width and complicate per-frame editing. Single pages are simpler and reuse the existing canvas-card grid almost unchanged.

**Recommendation:** edit single pages, preview spreads. A read-only spread preview is much cheaper than a spread-native editor.

---

## 5. Proposed architecture (assuming the recommendations above)

### 5.1 Schema sketch

Reflecting D2 / D2a / D4 / D7: the author supplies **one cover template and one inner-page template**, each with its own canvas size, and the customer's page count stamps the inner template N times.

```jsonc
{
  "name": "softcover_a4_landscape",          // = filename stem, authoritative
  "productType": "book",
  "tags": ["Photobook"],
  "book": {
    "bleedMm":    3,                          // default; a role may override
    "gutterMm":   12,                         // inner margin, mirrored by parity
    "pageCount":  { "min": 20, "max": 60, "step": 4, "default": 24 },
    "paperThicknessMm": 0.12,                 // → spine width, recomputed on count change

    // D2a — exactly two authored templates. Each carries its OWN canvas (D7),
    // so a cover larger than the block needs no extra concept: the engine
    // already reads canvas per surface.
    "cover": {
      "canvas": { "widthMm": 303, "heightMm": 216, "bleedMm": 3 },
      "spine":  true,
      "frames": [ /* … */ ]
    },
    "innerPage": {
      "canvas": { "widthMm": 297, "heightMm": 210 },
      // 1 frame = one photo per page; N frames = a collage page. This is the
      // ONLY thing that distinguishes the two layout styles — no flag needed.
      "frames": [ /* 1 frame, or N for a collage … */ ]
    },
    "backCover": { "canvas": { "$ref": "cover.canvas" }, "frames": [] }
  },
  "pageOverrides": {                          // ops escape hatch, same shape as calendar surfaceOverrides
    "3": { "frames": [ /* a one-off bespoke page */ ] }
  }
}
```

**Collage vs single-photo inner pages need no schema flag.** A collage page is simply an inner-page template with more than one frame, exactly as a multi-surface product works today. The materializer stamps whatever frame set it is given; the renderer already composites N frames per surface.

⚠️ **Prerequisite, now landed:** until 2026-08-14 the editor allocated exactly ONE photo per surface regardless of that surface's frame count, so any surface with more than one frame received one photo which the slot planner's modulo then repeated into every frame — a collage page would have printed the same photo in every cell. Fixed in `surface-allocation.ts` (`allocateFilesToSurfaces` / `planFrameSlots`). A book build **depends on that fix**; do not re-introduce a one-photo-per-surface assumption.

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

**All of D1–D7 are answered as of 2026-08-14 (see §4). Phases 0–4 are built** — schema, `services/book_layout.py` materializer, `api/validators.py::validate_book_layout`, `layout_engine/engine.py` dispatch, `api/tasks.py::_extract_book_state`, the TS twin `lib/book-layout.ts`, and parity/unit tests on both sides. See CLAUDE.md's book section for the full rundown.

Still open:

1. **Confirm the spine-width convention with Catalog Ops** before any cover ships — the implemented formula (`pageCount/2 leaves × paperThicknessMm`) differs from this PRD's §4 D4 sketch (`pageCount × paperThicknessMm`, which double-counts printed sides as sheets). A wrong answer here prints an unusable cover (R2).
2. Confirm the real product spec with Catalog Ops: actual trim sizes for **both** cover and inner block, page ranges, paper thickness, cover types, and which SKUs are collage-style vs one-photo-per-page.
3. **Open Phase 5** — the ops authoring UI (`/editor/layouts/book/[name]`). Nothing in the frontend has been touched yet.
4. **Open Phase 6** — the customer page editor, page-count control, and D3's photo→page auto-flow logic. This is where R1 (customer-variable surface count) has to actually be solved in `page.tsx` / `canvas-merge.ts` / autosave — the backend materializer doesn't touch any of that.
5. **Open Phase 7** — the read-only spread preview (`pagesToSpreads` already exists on both sides; only the UI is missing).
6. **Open Phase 9** — `scripts/smoke-test-book.sh`, mirroring `smoke-test-calendar.sh`.

### Phasing impact of the 2026-08-14 answers

| Phase | Change |
|---|---|
| 0 | Shorter — three decisions already closed, but D7 was added. Net ≈ unchanged. |
| 1 | **Grows.** Customer-variable page count (D2) is now certain rather than possible, so the payload/autosave shape must handle a changing surface count from day one. |
| 5 | **Shrinks.** Authoring two templates (D2a) is a much smaller UI than a per-page role editor. |
| 8 | **Grows slightly.** Spine width is recomputed on every page-count change, not resolved once at author time. |
