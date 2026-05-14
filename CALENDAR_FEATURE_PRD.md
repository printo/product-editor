# PRD — Calendar Feature for Product Editor

**Status:** Proposal · **Date:** May 14, 2026 · **Owner:** Kanna · **Target:** v1.12 (foundation) → v1.13 (calendar) · **Estimated effort:** ~17.5 engineer-days end-to-end (after design-review additions)

> **Visual mockup:** [`mockups/calendar-feature.html`](mockups/calendar-feature.html) — interactive HTML mockup of all three theme presets, the cell-edit popover, and the holiday auto-populate flow for `en-IN`. Opens in any browser, no build step. Useful for visual review during PRD iteration.

---

## 1. TL;DR for leadership

Add a **Calendar** primitive to the layout system so ops can ship calendar templates (e.g. "Family Calendar 2026 — January" through "December") that the customer fills in with their own photos, then optionally overrides individual date cells with custom text or an uploaded image. Renders at 300 DPI on top of all other artwork in the printed output.

**Why now:** the new corporate-gifting season + family-photo Christmas calendar product line both depend on this. Today the editor has no way to express a date grid as a structured, reservable region on the canvas.

**Two things stand in the way and one of them is bigger than the calendar itself:**

1. **The server-side renderer does not draw any overlays.** Today `backend/django/layout_engine/engine.py` composites customer-uploaded photos into the frame slots and applies the paper mask, but it does no text, no shapes, no overlay images. The existing TextOverlay / ShapeOverlay / ImageOverlay you can add in the editor are **preview-only** — they appear in the dataUrl thumbnail in the dashboard but vanish from the printed PNG/PDF. This is an unrelated pre-existing gap, and the calendar feature can't ship without fixing it.
2. **Calendar is structurally different from a free-floating overlay** — it's a grid of dates with per-cell overrides — so it needs its own data model and renderer.

The PRD scopes both. Foundation phase (server-side text rendering) is ~3-4 days and unblocks **every existing overlay type**, not just the calendar. The calendar itself is ~10 days on top.

---

## 2. Use cases / user stories

| # | As a … | I want to … | So that … |
|---|---|---|---|
| **1** | Catalog ops user | create a layout that includes a pre-positioned monthly calendar grid | the customer doesn't have to compose the grid themselves; they just pick the month and add their photos |
| **2** | Customer (storefront) | pick a year + month and see the calendar auto-populate with the right number of weeks and starting day | I get a correct calendar without manual editing |
| **3** | Customer | override a specific date cell with my own text (e.g. "Mom's birthday") | the printed calendar marks family events |
| **4** | Customer | replace a date cell entirely with a small uploaded image (e.g. a holiday icon, my baby's photo from that day) | the calendar is personalised at a per-day level |
| **5** | Customer | clear/reset an overridden cell back to the plain date number | undo without re-opening the editor |
| **6** | Customer | see the calendar rendered above my uploaded photos in the editor preview AND in the downloaded 300 DPI print | what I see is what I get |
| **7** | Ops user | edit the calendar's position, font, colour, grid style at the **layout** level, not the canvas level | the same family-calendar layout looks consistent across all customers |
| **8** | Customer | NOT be able to move, resize, delete, or restyle the calendar | the layout's design intent is preserved |
| **9** | Catalog ops | clone an existing calendar layout to bootstrap a new variant (different theme, different month range) | scaling to 12-month batches doesn't require 12× the design effort |

**Non-goals (v1):**
- Multi-month calendars on a single canvas (e.g. a "year at a glance"). Each canvas = one month.
- User-uploaded calendars (where the *customer* defines the grid). Ops authors the grid; customer fills it.
- Recurring event support / iCal import. Per-cell overrides are static text/image only.
- Lunar / holiday-localised pre-fills. Cells are populated with date numbers and weekday header, nothing else.
- Right-to-left week ordering or non-Gregorian calendars in v1.

---

## 3. Current state — what we have to work with

### 3.1 Existing layout JSON schema

Layouts live in `backend/django/storage/layouts/*.json`. Shape (taken from `classic_5x7.json`):

```json
{
  "name": "classic_5x7",
  "tags": [],
  "canvas": { "width": 1500, "height": 2100, "widthMm": 127, "heightMm": 177.8, "dpi": 300 },
  "frames": [
    { "id": "...", "x": 0, "y": 0, "width": 1, "height": 1,
      "xMm": 0, "yMm": 0, "widthMm": 127, "heightMm": 177.8, "bleedMm": 0 }
  ],
  "maskUrl": null,
  "maskOnExport": false,
  "metadata": [ ... ]
}
```

**Read by:** `LayoutManagementView` (ops CRUD), `ListLayoutsView` (storefront), `engine.py` (renderer).
**Editable in UI:** at `/editor/layouts` route (ops-only, see CLAUDE.md "Frontend Structure").

### 3.2 Existing overlay system (preview-only today)

`frontend/nextjs/src/app/editor/layout/[name]/types.ts:60-63`:

```ts
export type Overlay =
  | ({ type: 'text'  } & TextOverlay)
  | ({ type: 'shape' } & ShapeOverlay)
  | ({ type: 'image' } & ImageOverlay);
```

**Client renders all three** in `FabricEditor.tsx` (around lines 97-160 for the in-place update path, 820-870 for the full rebuild) and in `fabric-renderer.ts` for the thumbnail.

**Server renders none of them.** `backend/django/layout_engine/engine.py` has zero ImageDraw / ImageFont imports — it only does frame compositing + paper mask. Verified by `grep -rn "ImageDraw|ImageFont|draw_text" backend/django/` returning zero hits.

**Implication for the calendar feature:** if we ship the calendar with the current server, the customer will see it in the preview but the printed file will be blank where the calendar should be. **Server-side overlay rendering is a hard prerequisite.**

### 3.3 Existing z-order conventions (FabricEditor.tsx)

```
bgRect                                  zIndex 0
frames (image + clip)                   1 … frames.length
center guides + grid lines              + guidesCount
safe-zone + bleed-zone outlines         + (frames.length × 2)
paperOverlay (white card with cut-outs) paperOverlayZ
outline rects                           paperOverlayZ + 1
overlays[] (text, shape, image)         overlayZStart + oIdx
mask (if maskOnExport)                  bringToFront — always last
```

**Calendar slot:** above `overlays[]`, below mask. New constant `calendarZ = overlayZStart + overlays.length + 1`.

### 3.4 Existing editor UI

`CanvasEditorModal.tsx` opens when a canvas is clicked. `CanvasEditorSidebar.tsx` (650 LOC) has tabs:

```
ADD_TABS = [
  { key: 'background', label: 'BG'    },
  { key: 'text',       label: 'Text'  },
  { key: 'shape',      label: 'Shape' },
  { key: 'icon',       label: 'Icon'  },
  { key: 'image',      label: 'Image' },
]
```

A new `'calendar'` tab fits naturally (when the active layout declares a calendar).

### 3.5 Existing fonts plumbing

`storage/fonts.json` + `FontsView` (GET/PUT `/api/fonts`) already provide a managed list of font families. Both the editor (text overlay font picker) and a future server-side text renderer can pull from this source.

For server-side rendering we additionally need the actual `.ttf` / `.woff2` files. They're not in the repo today. Either:
- Bundle a small set of approved fonts in the backend image
- Lazy-download from Google Fonts on first use (cache to disk)

### 3.6 Existing canvas state persistence

`CanvasData.editor_state` is a JSON blob stored per `(order_id, api_key)` with the full editor state (frames, overlays, colours, surface states). It's already migration-versioned and read by `render_canvas_task`. **Calendar overrides slot into this exact same JSON** — no schema migration required on the DB.

---

## 4. Proposed design

### 4.0 Design principle — minimal customer-facing controls

Every customisation knob we add to the editor is a chance for a customer to produce an output the design team would not have shipped. The calendar feature deliberately keeps customer-facing controls to the smallest set that still serves the use case:

| Concern | Customer can change | Customer cannot change |
|---|---|---|
| Which month is shown | ✅ Year + Month selectors | — |
| What's in each cell | ✅ Add 1–3 text entries with dot colour, or override the whole cell with an image | Layout's positioning of the calendar; whether holidays auto-load; the holiday list itself |
| Colour scheme on Gen-Z layouts | ✅ Pick one of 4 coordinated palettes | Individual colour roles (background / grid / month / weekday / date / pill) — picking those separately invites ugly combinations |
| Colour scheme on Minimalist / Weekday-highlight layouts | — | Theme is fixed by ops at layout creation |
| Font, font weight, grid stroke, padding, header style, week-start day | — | All locked at layout creation by ops |

If a customer wants something further, they pick a different layout from the catalog (which is the existing surface that already exists for product variation). This is the "templates, not configurators" pattern — costs less to maintain, produces fewer support tickets, and protects print quality.

### 4.1 Architectural shape

The calendar is a **layout-agnostic primitive**: a positioned region inside any canvas, defined by `{x, y, width, height}` percentages of the canvas dimensions. It composes into multiple product types without changes to the primitive itself:

| Product type | Layout JSON shape |
|---|---|
| **Desk calendar** (5×7 portrait) | 1 frame (top ~60%) + 1 calendar region (bottom ~40%) |
| **Full-page calendar** (A4 / A3) | 0 frames + 1 calendar region covering the canvas |
| **Poster calendar** (12×18) | N small photo frames around the edges + 1 calendar region in the middle |
| **Side-by-side calendar** (landscape) | 1 photo frame on the left + 1 calendar region on the right |

The calendar primitive owns **only** the grid, cells, pills, holidays, and per-cell editing. Photo frames, branding, and any other artwork are owned by the **layout** (the existing `layout.frames[]` and `layout.overlays[]` machinery). So the build effort scoped in this PRD covers the primitive once and the four product types come "free" via layout authoring.

The calendar is **layout-authored, customer-overridden**. Two layers of definition:

| Layer | Owned by | Stored in | Frequency |
|---|---|---|---|
| **Calendar template** — position, size, style, default year/month | Ops | Layout JSON (`calendar` property) | Once per layout |
| **Calendar overrides** — year, month, per-cell overrides | Customer | `CanvasData.editor_state.calendar` | Per canvas |

Customer never controls position / size / font of the calendar. Customer controls **what goes in the cells.**

### 4.2 New data types

#### 4.2.1 Layout-level `calendar` (in layout JSON)

```jsonc
{
  "name": "family_calendar_a4_landscape",
  "canvas": {...},
  "frames": [...],

  // NEW — optional. If absent, layout has no calendar.
  "calendar": {
    "x": 0.05, "y": 0.55,              // top-left of grid, % of canvas
    "width": 0.9, "height": 0.4,       // dimensions, % of canvas
    "defaultYear": 2026,               // customer can change at runtime
    "defaultMonth": 1,
    "style": {
      "weekStart": "sunday",           // "sunday" (default, en-IN) | "monday"
      "showWeekdayHeader": true,
      "weekdayFormat": "short",        // "short" | "narrow"  → "Mon" | "M"
      "fontFamily": "Inter",
      "fontSize": 14,                  // pt at canvas DPI; renderer scales
      "fontWeight": 400,
      "headerFontWeight": 600,
      "color": "#000000",
      "headerColor": "#666666",
      "gridColor": "#dddddd",
      "gridStrokeWidth": 0.5,
      "cellPadding": 4,
      "headerBackground": null,        // null = transparent
      "outOfMonthColor": "#cccccc"     // dates from prev/next month
    },
    "locale": "en"                     // ISO 639-1; affects weekday names + ordinal suffixes
  }
}
```

#### 4.2.2 Per-canvas `calendarState` (in `editor_state`)

```ts
// frontend/nextjs/src/app/editor/layout/[name]/types.ts
export interface CalendarState {
  // Customer-controlled (override layout defaults)
  year:  number;   // e.g. 2026
  month: number;   // 1-12

  // Per-cell overrides keyed by ISO date string ("2026-01-15")
  cells: Record<string, CalendarCellOverride>;
}

export type CalendarCellOverride =
  | { type: 'text';  text: string; color?: string; fontSize?: number }
  | { type: 'image'; uploadId: string; opacity?: number }
  | { type: 'hide';  /* hide date number, leave cell empty */ };

export interface CanvasItem {
  // ... existing fields ...
  calendar?: CalendarState;   // only present when layout has a calendar
}
```

Notes:
- **No cell IDs.** Keying by ISO date means month-change re-derives the cell set automatically; old overrides for dates not in the new month simply don't render but stay in the JSON in case the customer flips back.
- **Override is total per cell** — a `text` override completely replaces the date number; a `hide` override leaves the cell empty (useful for "this layout only marks weekends"); the default behaviour (no entry in `cells`) shows the date number per the template style.
- **`uploadId`** points to an existing `UploadedFile.upload_session_id`. Same chunked-upload pipeline as photos. The image is rendered inside the cell, centred, max 90% of the cell's smaller dimension.

### 4.3 Rendering algorithm (client + server, identical math)

Both renderers compute the calendar grid in the same way so the preview matches the print:

1. **Compute grid dimensions:**
   - `firstDay = first day of (year, month)` (e.g. Jan 1, 2026 = Thursday)
   - `daysInMonth = Date.daysInMonth(year, month)`
   - `weekStartIdx = 0 if Sunday else 1`
   - `firstCellOffset = (firstDay.dayOfWeek - weekStartIdx + 7) % 7`
   - `totalCells = ceil((firstCellOffset + daysInMonth) / 7) × 7`  → 28, 35, or 42
   - `rows = totalCells / 7`
2. **Compute cell size:**
   - `usableWidth = calendar.width × canvasW`
   - `usableHeight = calendar.height × canvasH − (showWeekdayHeader ? headerHeight : 0)`
   - `cellW = usableWidth / 7`
   - `cellH = usableHeight / rows`
3. **Draw the weekday header** (if enabled): "MON TUE WED THU FRI SAT SUN" (or "M T W T F S S" for narrow), one label per column.
4. **Draw each cell:**
   - For each of the `totalCells` cells, compute the date it represents (which may be in the previous or next month)
   - Default cell rendering: date number, top-left or centre based on style
   - If a `cells[isoDate]` override exists:
     - `text`: render the override text (truncate / wrap as needed)
     - `image`: render the image fitted to the cell with `cellPadding`
     - `hide`: render nothing
   - Out-of-month cells: render the date number in `outOfMonthColor` (lighter)
5. **Draw grid lines** between cells with `gridColor` + `gridStrokeWidth`.

The whole calendar goes on top of all other artwork (just below the mask).

### 4.4 Library research summary (validated against npm + Pillow ecosystem)

Searches were run for Fabric.js calendar plugins, JS calendar grid utilities, auto-fit-text libraries (both DOM and canvas-targeted), and Pillow text-fitting solutions before this PRD finalised the "build new" list. Findings:

| Need | Library that fits | Source |
|---|---|---|
| Fabric.js calendar plugin | **None exists.** Build with `Rect` + `Line` + `Textbox` + `FabricImage` primitives. | [Fabric.js docs](https://fabricjs.com/), [Fabric.js GitHub](https://github.com/fabricjs/fabric.js) |
| JS month-grid date math | **`date-fns`** — `startOfMonth` + `endOfMonth` + `startOfWeek` + `eachDayOfInterval` give the full 35/42-cell grid in 8 lines. Already a widely-used pattern. | [date-fns](https://date-fns.org/), [calendar-matrix gist](https://gist.github.com/miljan-aleksic/bd70452a3f0cd6a11545db9f6ab57df6) |
| Auto-fit text in a Fabric.js Textbox | **No library fits.** All auto-fit libraries (`auto-text-size`, `fitty`, `react-textfit`, `use-fit-text`, `textFit`, `react-scale-text`) measure DOM via `getBoundingClientRect`; Fabric draws onto `<canvas>` and they can't see it. [Fabric issue #3563](https://github.com/fabricjs/fabric.js/issues/3563) + [discussion #7541](https://github.com/fabricjs/fabric.js/discussions/7541) confirm there's no built-in either. | [fitty](https://github.com/rikschennink/fitty), [auto-text-size](https://www.npmjs.com/package/auto-text-size), [use-fit-text](https://github.com/saltycrane/use-fit-text) |
| Auto-fit text in Pillow | **No library exists**, but `ImageFont.getbbox()` + binary search is the documented community pattern. ~15 LOC. | [Pillow discussion #6891](https://github.com/python-pillow/Pillow/discussions/6891), [issue #5669](https://github.com/python-pillow/Pillow/issues/5669), [Pillow ImageFont docs](https://pillow.readthedocs.io/en/stable/reference/ImageFont.html) |
| Cell-image auto-cover ("always fills") | **100% reuse**: `calculateSmartCropOffsets` (client) + `_composite_canvas` cover-fit math (server) — each cell is a `frameSpec`. Adds zero new logic. | (in-repo) |
| Cell-image auto-orientation | **100% reuse**: v1.11 MediaPipe Pose pipeline already runs on every uploaded file. A sideways photo dropped into a calendar cell gets corrected automatically. | (in-repo) |

**Net change vs the initial draft:**

- `date-fns` becomes a new frontend dep (~6 KB tree-shaken). Saves ~30 LOC of manual date arithmetic + gives locale-aware weekday names via `Intl`.
- Auto-fit text helpers remain "build new" on both sides (~20 LOC client, ~15 LOC server). No library escapes them.
- Cell image handling is **confirmed pure reuse** — no separate cropping/orientation pipeline.

These findings are folded into §4.4 below.

### 4.5 Reuse vs build new

| Concern | Approach | Why |
|---|---|---|
| Layout JSON storage + CRUD | **Reuse** — extend `LayoutManagementView`, no new endpoint | The `calendar` field rides through as just another JSON property |
| Per-canvas state persistence | **Reuse** — `CanvasData.editor_state` JSON already free-form | Same shape as overlays |
| Chunked upload for cell images | **Reuse** — existing `/upload/init` + `/upload/<id>/chunk` + `/upload/<id>/complete` | Identical to frame photo upload |
| File → upload_id mapping | **Reuse** — IDB-cached on the client (B1 pattern) | Refresh restores cell images |
| Auto-orientation on cell images | **Reuse** — already routes through `/api/orientation/detect` in `generateCanvases` | Customer uploads an upside-down photo into a cell → MediaPipe fixes it |
| Z-order positioning | **Reuse** — slot above `overlayZStart + overlays.length` | Already a numeric tower in FabricEditor |
| Frontend overlay editor tabs | **Reuse** — add a 6th tab `'calendar'` to `ADD_TABS` (gated on `layout.calendar` existing) | Mirrors text / shape / image pattern |
| Font picker UI | **Reuse** — same dropdown bound to `/api/fonts` | Already wired up |
| Smart-crop into cell images | **Reuse** — `calculateSmartCropOffsets` accepts arbitrary frame dimensions | Each cell becomes a tiny frame |
| Server-side font loading | **Build new** — `services/fonts.py` loads `.ttf` from disk, caches `PIL.ImageFont` objects per (family, size) | No precedent in repo |
| **Server-side text rendering** | **Build new** — `services/overlay_renderer.py` draws text/shape/image overlays via Pillow `ImageDraw` | Pre-existing gap |
| Server-side calendar rendering | **Build new** — `services/calendar_renderer.py` builds grid + draws each cell | Calendar-specific math |
| Client-side calendar rendering | **Build new** — `fabric-renderer.ts` extended with `buildCalendarGroup` | Uses existing Fabric primitives |
| Editor cell-edit UI (right-click → text / image / hide) | **Build new** — `CalendarEditPanel.tsx` | New interaction model |
| Layout-management UI (calendar editor in `/editor/layouts`) | **Build new** — `CalendarLayoutEditor.tsx` (position, style picker) | Different from frame editor; smaller |
| Locale-aware weekday names + ordinals | **Use stdlib** — `Intl.DateTimeFormat` on client, `babel` (already a dep — actually Python `babel` is NOT yet a dep, would add) on server | One small dep on backend |

### 4.6 UI/UX flows

#### Flow A — Ops creates a calendar layout

1. Ops user navigates to `/editor/layouts` → "Create new layout".
2. Sets canvas dimensions as today.
3. Drops in 1+ frames as today.
4. NEW: clicks "**+ Add calendar**" → an opaque grid placeholder appears on the canvas.
5. Drags + resizes the placeholder (snaps to a few sensible aspect ratios).
6. Opens a `Calendar style` panel — picks font, colour, grid weight, weekday header on/off.
7. Sets `defaultYear` / `defaultMonth` (any month is fine — customer will override).
8. Saves → layout JSON gains a `calendar` property; the layout shows up in the customer-facing list with a "🗓 Calendar" tag.

#### Flow B — Customer uses a calendar layout

1. Customer's order resolves to a calendar layout (via SKU map or direct link).
2. Editor mounts → calendar appears with the layout's default `(year, month)`.
3. Photo upload + frame editing flow is unchanged.
4. NEW: tapping the calendar opens a panel:
   - Year selector (default + ±5)
   - Month selector (1–12)
   - Cell list / grid for overrides (compact view of all cells with current state)
5. Tapping a cell opens cell-level options:
   - "Add note" → small text input
   - "Add photo" → file picker → uploads + replaces date number
   - "Hide date" → leaves the cell blank
   - "Reset" → removes override, falls back to date number
6. All changes flow through the existing `debouncedRender` (80ms) so preview stays in sync.
7. Save & Continue: existing flow; server renderer now picks up the calendar from `editor_state` and draws it at 300 DPI.

#### Flow C — Customer overrides a cell with an image

1. Customer taps cell "2026-01-15".
2. Picks "Add photo" → native file picker.
3. File uploads via the same chunked-upload API used for frames.
4. After upload, the photo is auto-oriented via `/api/orientation/detect` (Apache 2.0 MediaPipe Pose — already shipped in v1.11).
5. Cell now shows a thumbnail of the uploaded photo, scaled to fit the cell with `style.cellPadding`.
6. On submit, the server-side calendar renderer composites the photo into the cell at 300 DPI.

### 4.7 API changes

**New endpoints — none.** Everything rides on existing surfaces:

| Existing endpoint | Existing role | What it carries that's new |
|---|---|---|
| `GET /api/layouts/<name>` | layout fetch | response now includes `calendar: {...}` field for calendar layouts |
| `PUT /api/ops/layouts/<name>` | ops upsert | accepts `calendar: {...}` in body |
| `GET /api/ops/layouts/` | ops list | response items include `hasCalendar: true` flag for the catalog UI badge |
| `PUT /api/canvas-state/<order_id>/` | save editor state | accepts `canvas.calendar` per CanvasItem |
| `POST /api/editor/render` | render kickoff | reads `calendar` per canvas from `editor_state` |
| `POST /upload/init` etc. | chunked upload | reused unchanged for cell-image overrides |
| `POST /api/orientation/detect` | auto-rotation | reused unchanged for cell-image overrides |

**New JSON schema validation:** server-side validator for the `calendar` block (range checks on year, month 1-12, x/y/width/height in [0,1], style fields). Add to `api/validators.py`.

### 4.8 Render pipeline changes

#### 4.8.1 Foundation phase — server-side overlay rendering (v1.12)

**Pre-requisite for calendar.** Build the missing server-side renderer for the existing `TextOverlay | ShapeOverlay | ImageOverlay` types. New module:

```
backend/django/services/
  overlay_renderer.py     ← new: draws overlays onto a PIL Image
  fonts.py                ← new: caches PIL.ImageFont per (family, size)
  fonts_assets/           ← new: bundled .ttf files for the curated fonts
```

`overlay_renderer.py` API (sketch):

```python
from PIL import Image
from typing import List

def render_overlays(
    canvas: Image.Image,
    overlays: list[dict],          # the CanvasItem.overlays array
    canvas_w_px: int, canvas_h_px: int,
    uploaded_files: dict[str, str], # upload_id → file_path map
) -> Image.Image:
    """Mutates `canvas` in place. Returns it for chaining."""
    draw = ImageDraw.Draw(canvas, mode='RGBA')
    for o in overlays:
        if o['type'] == 'text':
            _draw_text(draw, canvas, o, canvas_w_px, canvas_h_px)
        elif o['type'] == 'shape':
            _draw_shape(draw, canvas, o, canvas_w_px, canvas_h_px)
        elif o['type'] == 'image':
            _paste_image(canvas, o, canvas_w_px, canvas_h_px, uploaded_files)
    return canvas
```

`engine.py` plumbs into this from `_composite_canvas` right after the frames are composited and just before the paper mask is applied:

```python
# ── overlays (new) ──
if overlays_for_this_canvas:
    from services.overlay_renderer import render_overlays
    canvas = render_overlays(canvas, overlays_for_this_canvas, canvas_w, canvas_h, upload_map)
```

#### 4.8.2 Calendar phase (v1.13)

Adds calendar rendering on top of the foundation:

```
backend/django/services/
  calendar_renderer.py   ← new: month grid math + cell drawing
```

API:

```python
def render_calendar(
    canvas: Image.Image,
    calendar_template: dict,      # from layout.calendar
    calendar_state: dict,         # CanvasItem.calendar (year, month, cells)
    canvas_w_px: int, canvas_h_px: int,
    uploaded_files: dict[str, str],
    locale: str = 'en',
) -> Image.Image:
    ...
```

`engine.py` calls `render_calendar` AFTER `render_overlays` so the calendar is always on top (matches the client z-order).

Client-side mirror in `fabric-renderer.ts` (new function `buildCalendarFabricGroup`) builds a `fabric.Group` of `Textbox`, `Rect`, and `FabricImage` objects. Lives at `overlayZStart + overlays.length + 1`.

#### 4.8.3 Z-order summary (post-feature)

| zIndex | Layer |
|---|---|
| 0 | Canvas background |
| 1 … N | Frame images + clips |
| N+1 … M | Centre guides, grid (preview only) |
| M+1 … M+(2F) | Bleed + safe zones (preview only, hidden during transform fade) |
| paperOverlayZ | Paper mask (with frame cutouts) |
| paperOverlayZ + 1 | Frame outline rects |
| overlayZStart … | Free-floating overlays (text, shape, image) |
| **overlayZStart + overlays.length + 1** | **Calendar (NEW)** |
| top | Layout mask (if `maskOnExport`) |

---

## 5. Implementation phases

### Phase 1 — Foundation: server-side overlay rendering (v1.12, ~4 days)

Unblocks the calendar AND fixes the pre-existing bug where text/shape/image overlays don't make it into the printed file. Ship-on-its-own valuable.

| Day | Deliverable |
|---|---|
| 1 | `services/fonts.py` — lazy-cached `PIL.ImageFont`. Curated bundled fonts (Inter, Roboto, Playfair Display, Caveat, Lobster — 5 families × 4 weights = ~10 MB) in `backend/django/services/fonts_assets/`. Wire to existing `/api/fonts` so client + server agree on the available list. |
| 2 | `services/overlay_renderer.py` — `render_overlays` with text + shape drawing. Smoke-test by adding a text overlay in dev and rendering at 300 DPI. |
| 3 | Image-overlay path (reuse the chunked-upload pipeline; pull bytes from `upload_id → file_path` map). Engine wires through `editor_state.overlays`. |
| 4 | E2E test: dashboard render with mixed text + shape + image overlays; confirm dataUrl preview ≈ rendered PNG. Doc updates. |

**Success criteria:**
- A canvas with one text overlay ("Hello world") renders the same text in the same position in the downloaded PNG as in the preview.
- All three existing overlay types render server-side.
- No regression on layouts without overlays (pixel-diff < 1% on a baseline set).

### Phase 2 — Calendar template authoring (v1.13, ~3 days)

| Day | Deliverable |
|---|---|
| 1 | Extend layout JSON schema. Server validator (`validators.py`) for the `calendar` block. `LayoutManagementView` accepts the new field round-trip. |
| 2 | `CalendarLayoutEditor.tsx` — UI in `/editor/layouts` for positioning + styling a calendar on a layout. Save → JSON. |
| 3 | "🗓 Calendar" badge in the customer-facing layout list (`ListLayoutsView` returns `hasCalendar` flag). |

### Phase 3 — Calendar runtime (v1.13, ~5 days)

| Day | Deliverable |
|---|---|
| 1 | TypeScript types (`CalendarState`, `CalendarCellOverride`). `editor_state` round-trip. |
| 2 | `fabric-renderer.ts` — `buildCalendarFabricGroup`. Year/month selector on the sidebar. Render basic grid (no per-cell overrides yet) in editor preview. |
| 3 | Cell-edit panel — tap a cell, choose text / image / hide / reset. Wire to `editor_state.cells`. |
| 4 | `services/calendar_renderer.py` — server-side grid math + cell drawing. Wire into engine. |
| 5 | E2E: customer picks Feb 2026, overrides Feb 14 with "Valentine's Day", overrides Feb 29 with their dog's photo. Both render at 300 DPI. |

### Phase 4 — Polish + safeguards (v1.13, ~2 days)

| Day | Deliverable |
|---|---|
| 1 | Cell-image auto-orientation reuses `/api/orientation/detect` (already shipped). Cell-text wrapping + truncation rules. Locale handling for weekday names (start with `en`, support `fr`/`de`/`es` via `Intl`). |
| 2 | Performance pass: a 12-canvas calendar batch (Jan-Dec) renders in the same wall-time envelope as a 12-photo render (~1s overhead per canvas for the grid + cells, tolerable). Doc updates: CLAUDE.md "Calendar" section, PRD.md v1.13 row, .env.example if any new vars. |

**Total: ~14 days** from kick-off to v1.13 ship.

---

## 6. Risks & open questions

### 6.1 Risks (ranked by severity)

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | **Server-side text rendering quality** — Pillow's text rendering is not as crisp as a browser's font hinting. Some font families look noticeably different at 300 DPI between preview and print. | Medium | Pre-render a side-by-side diff during Phase 1; if any family fails QA, drop it from the bundled list. Stick to Inter / Roboto as safe defaults. |
| 2 | **Bundled font licence** — every font we ship needs SIL OFL or similar permissive licence. Misreading a licence is easy to do quietly. | Low–Medium | Build the bundle from Google Fonts only (all SIL OFL or Apache 2.0). Add a `LICENSES.md` next to `fonts_assets/` listing each. |
| 3 | **Calendar cell-image upload races** — customer uploads, leaves the editor before the upload completes, returns later. Cell shows broken image. | Medium | Persist `upload_id` to IDB on file selection (B1 pattern). Re-resolve on editor reload via `upload_id → file_path` map. If file is missing on render, fall back to date number + log. |
| 4 | **Layout has calendar but customer never picks year** — defaults to whatever ops set; could be stale (e.g. 2025 when customer is buying for 2026). | Medium | Ops sets a "rolling default" flag: `defaultYear: "current"` resolves to `new Date().getFullYear()` on editor mount. |
| 5 | **i18n complexity creep** — different locales want different weekday orders, ordinal suffixes, holiday colouring. Easy to scope-creep. | High | Lock v1 to: `weekStart=monday\|sunday` + weekday name from `Intl` + holidays for `en-IN` and `generic` only. Anything else (`en-US`, `en-GB`, etc.) is added by ops upload when needed. |
| 6 | **Z-order conflict with frame outlines** — the calendar might visually clash with the safe-zone / bleed-zone outlines on the preview (not the print). | Low | Hide outlines whenever a calendar overlaps them in the preview, via the existing `isTransforming` opacity dimming. |
| 7 | **Mobile editor UX for cell editing** — 42 tiny tap targets on a phone is painful. | Medium | Cell editor opens as a bottom-sheet list view on narrow viewports (md breakpoint), not the canvas itself. |

### 6.2 Open questions — status

| # | Question | Decision |
|---|---|---|
| 1 | Which fonts? | **TBD** — pending Mohan / Viji sign-off on print-quality. Straw-man: Inter, Roboto, Playfair Display, Lora, Caveat, Lobster, Bebas Neue. |
| 2 | Storefront pre-selects year/month via embed metadata? | **TBD** — defer to ops feedback after first calendar SKU goes live. In-editor selector ships v1.13. |
| 3 | Per-cell pan/scale on image overrides? | **v1 = auto-fit only.** Per-cell pan/scale lands in v2 if ops sees the demand. |
| 4 | Holiday auto-load? | **✅ IN SCOPE for v1.13.** Hybrid maintenance: 5-year seed (`2026–2030`) for `en-IN` + `generic` locales sourced from [Nager.Date](https://date.nager.at/) at build time; ops upload endpoint available for corrections + new locales without a deploy. |
| 5 | Non-Gregorian calendars (Hijri / Shaka / Vikram Samvat)? | **v2 candidate.** v1.13 is Gregorian-only. |
| 6 | Year range? | **`currentYear − 5` to `currentYear + 5`.** Configurable per layout via `calendar.yearRange`. |
| 7 | Ops can lock specific cells to pre-defined text? | **v2 candidate.** v1.13 lets ops define a holiday list; cells aren't otherwise lockable. |
| 8 | **NEW** — Cell entry pill style (post-design-review with mockup) | **✅ Pill design locked.** Date number always visible top-right; entries stack below; cap `MAX_ENTRIES = 3` (configurable per layout via `calendar.style.maxEntriesPerCell`); rounded-rect pill with coloured dot + text; "+N more" overflow indicator. |
| 9 | **NEW** — Three style presets (Modern Minimalist / Modern Gen-Z / Weekday Highlight) | **✅ Locked.** Stored as JSON in `storage/calendar_styles/`; ops picks one when authoring a layout; resolved style fields written to layout JSON; customer cannot switch presets (preserves design intent). |

### 6.3 Confirmed scope additions (post-design-review)

After the first design review the following additions were locked in. They are NOT part of the original v1.13 estimate (~14 days); they add **~3.5 days** for a revised total of **~17.5 days**.

**a. Pill-style cell entries (replaces "override" model)**

- Date number always visible (top-right by default).
- User events stack below as small pill badges: rounded-rect bg + 6 px coloured dot + 9–10 pt auto-fit text.
- Holiday entries from the auto-loaded list co-mingle with user entries.
- Cap = 3 entries per cell (configurable via `calendar.style.maxEntriesPerCell`). Overflow shows "+N more" at the bottom of the cell.
- Image overrides still exist as a mutually-exclusive mode — `imageOverride` blanks the whole cell.

**b. Global holiday auto-load**

Layer | Detail
--- | ---
Storage | `backend/django/storage/holidays/<locale>/<year>.json`
Schema | `{ year, locale, events: [{ date, name, type, color }] }` (see PRD §4.2 for example)
Seed (v1.13 ship) | 5 years (`2026–2030`) × 2 locales (`en-IN`, `generic`) sourced from [Nager.Date](https://date.nager.at/) at backend image build time
Ops endpoints | `GET /api/ops/holidays/`, `PUT /api/ops/holidays/<locale>/<year>` (upload / replace), `DELETE /api/ops/holidays/<locale>/<year>`
Customer endpoint | `GET /api/holidays/<locale>/<year>` (public, cached `Cache-Control: public, max-age=86400, swr=604800`)
Layout opt-in | `calendar.holidaySource = { enabled: true, locale: 'en-IN', showInCells: true }`
Editor behaviour | When customer picks year/month, frontend fetches holidays for that (locale, year) and auto-injects matching cells as `source: 'holiday'` entries. User cannot delete holiday entries (would re-inject); can override the whole cell with an image to hide them.

**c. Three style presets**

Stored as JSON in `backend/django/storage/calendar_styles/`. Endpoints `GET /api/calendar-styles/`, `GET /api/calendar-styles/<name>`, `PUT /api/ops/calendar-styles/<name>`. Ops picks one in the layout editor; the preset's `style` block is copied into the layout JSON's `calendar.style` (and can then be fine-tuned per layout).

| Preset | Look | Hooks |
|---|---|---|
| `modern-minimalist` | white bg · black text · light grey grid (#E5E5E5) · subtle entry pills (#F7F7F7) · Inter 400 | Default |
| `modern-genz` | parameterised by **4 coordinated palettes** (Butter & Purple, Mint & Hot Pink, Lilac & Coral, Sky & Lemon). Each palette sets all 6 colour roles together: page bg, grid colour, month text, weekday header, date number, entry-pill bg. Customer picks one palette swatch in the editor — that's the *only* Gen-Z customisation control. Default palette = Butter & Purple. | Trendy 2026 palettes; new palettes ship as additional JSON files under `storage/calendar_palettes/genz/` — no code change |
| `weekday-highlight` | **Sunday** stands out: light-red cell fill `#FEE2E2` + red date number `#DC2626`. No border (read as a state indicator in v1 review, looked off). No Saturday treatment. All other days neutral. Light grey grid. Single visual cue, easy to read at a glance. | Theme says one thing: "Sundays are different." |

### 6.4 Migration / backwards compatibility

- **Existing layouts without `calendar`:** unaffected. Behaviour unchanged.
- **Existing canvases (already-saved CanvasData):** unaffected. The `calendar` field is optional everywhere.
- **Existing `editor_state` JSON:** new field added at top level of each CanvasItem; old states deserialise cleanly (missing field → undefined → no calendar rendered).
- **Database migrations:** **zero new migrations.** All new data is JSON-shape in existing free-form columns.
- **Server image rebuild:** required (new Python deps + bundled fonts). Ship with `./deploy.sh` standard flow.

---

## 7. Cost / effort summary

| Phase | Effort | Ships independently? | Value if shipped alone |
|---|---|---|---|
| 1 — Server-side overlay rendering | ~4 days | Yes | Fixes a pre-existing gap — text/shape/image overlays start working in print |
| 2 — Calendar template authoring (ops UI + schema) | ~3 days | Yes (no customer-facing change) | Lets ops prep calendar layouts ahead of customer rollout |
| 3 — Calendar runtime (editor + renderer) | ~5 days | Requires Phase 1+2 | The actual feature |
| 4 — Polish, perf, docs | ~2 days | Wraps phase 3 | — |
| **Total** | **~14 days** | — | — |

Two senior engineers in parallel can compress this to ~8 calendar days.

---

## 8. Reuse-vs-build cheat-sheet

**Pure reuse (no changes needed):**
- Chunked-upload API for cell images
- `UploadedFile` model + GC
- IndexedDB file persistence (B1 — file-store.ts)
- Auto-orientation pipeline (v1.11)
- Smartcrop offset calculation for cell images
- Editor's `debouncedRender` (80ms) for preview updates
- `/api/fonts` endpoint + `storage/fonts.json` store
- Canvas state persistence (`CanvasData.editor_state`)
- Layout CRUD endpoints (`LayoutManagementView`)
- Z-order numeric tower in FabricEditor
- Cache invalidation (`layouts_list_all` + `ops_layouts_list_all`)
- Embed-session token resolution

**Extend (minor changes):**
- `Overlay` discriminated union → no, calendar is a separate top-level `CanvasItem.calendar` field
- Layout JSON schema → +1 optional field
- `/api/layouts/<name>` response → +1 optional field
- Layout ops list response → +1 `hasCalendar` boolean

**Build new:**
- `services/fonts.py` (font cache)
- `services/overlay_renderer.py` (foundation — text/shape/image)
- `services/calendar_renderer.py` (calendar grid)
- `fabric-renderer.ts` extension: `buildCalendarFabricGroup`
- `CalendarLayoutEditor.tsx` (ops UI)
- `CalendarEditPanel.tsx` (customer UI)
- `lib/calendar.ts` (shared month-grid math — used by both client renderer + sidebar UI)
- `api/validators.py` extensions for the `calendar` block

---

## 9. What to do next

1. **Confirm the 7 open questions in §6.2 with Viji + Mohan + Manish** — ~30 min meeting.
2. **Lock the bundled font list** — needs Mohan's print-quality sign-off on each.
3. **Kick off Phase 1 (foundation)** — independent of calendar; ships v1.12. ~4 days.
4. **Phase 2 + 3 in parallel** if 2 engineers available; otherwise serial. ~8 days.
5. **Phase 4 polish** — ~2 days.
6. **v1.13 ship target:** ~3 working weeks from kickoff.

---

*— end of PRD —*
