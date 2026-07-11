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

`storage/fonts.json` + `FontsView` (GET/PUT `/api/fonts`) already provide a managed list of font families used by the text-overlay font picker in the editor. **The calendar feature reuses this exact list as its single source of truth** — no separate "calendar fonts" bundle, no parallel approval workflow, no risk of drift between what the editor shows and what the server can render. When ops adds a new font through the existing header UI, the calendar's `style.fontFamily` picker gains it for free.

For server-side rendering (a new requirement — see §3.2) we additionally need the actual `.ttf`/`.woff2` files on disk. Convention: a file named `<FontFamily>-Variable.ttf` (or weight-specific variants like `<FontFamily>-Regular.ttf`, `<FontFamily>-Bold.ttf`) lives under `backend/django/services/fonts_assets/`. Ops adding a font does two things: (a) append the name to `storage/fonts.json` via the existing UI, (b) drop the matching `.ttf` into `services/fonts_assets/`. A small startup check warns when a font name in `fonts.json` has no matching `.ttf` so misconfiguration is loud rather than silent.

For server-side rendering we additionally need the actual `.ttf` / `.woff2` files. They're not in the repo today. Either:
- Bundle a small set of approved fonts in the backend image
- Lazy-download from Google Fonts on first use (cache to disk)

### 3.6 Existing canvas state persistence

`CanvasData.editor_state` is a JSON blob stored per `(order_id, api_key)` with the full editor state (frames, overlays, colours, surface states). It's already migration-versioned and read by `render_canvas_task`. **Calendar overrides slot into this exact same JSON** — no schema migration required on the DB.

---

## 4. Proposed design

> **⚠ Amended on May 21, 2026 — see §10.** The "minimal customer-facing controls" rule below stands for week-start and aspect ratio (still ops-locked), but **Theme preset** and **Calendar type** are now genuine customer choices on the preview page (the "custom-printing" concept). Year selection is replaced with auto-population from today's date + the customer's calendar type. The updated control matrix lives in §10.3.

### 4.0 Design principle — minimal customer-facing controls

Every customisation knob we add to the editor is a chance for a customer to produce an output the design team would not have shipped. The calendar feature deliberately keeps customer-facing controls to the smallest set that still serves the use case:

| Concern | Customer can change | Customer cannot change |
|---|---|---|
| Which month is shown | ✅ Year + Month selectors | — |
| What's in each cell | ✅ Add 1–3 text entries (text only — dot colour auto-rotates through the theme's 3-slot cycle by entry index), or override the whole cell with an image | Dot colour (auto-rotates per entry), pill background (single theme value); layout's positioning of the calendar; whether holidays auto-load; the holiday list itself |
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

> **⚠ Schema amended on May 21, 2026 — see §11.** Two changes: (a) `calendar` (singular) is replaced by `calendars: []` (plural array) to support poster-style "year-on-one-page" layouts with 12 mini-calendars (§11.1). (b) Font fields (`fontFamily`, `fontWeight`, `headerFontWeight`) are removed — renderer uses a single bundled default font (§11.7).

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

// User entries are intentionally text-only. The dot colour rotates
// through a per-theme 3-slot cycle by entry index (1st = slot 0,
// 2nd = slot 1, 3rd = slot 2) so multi-entry cells stay visually
// distinguishable without giving the customer a picker. The pill
// background is a single theme-wide colour (consistent across all
// user entries). On Gen-Z the rotation comes from the active
// palette's `dotCycle` field; on Minimalist + Weekday-Highlight it
// comes from a hard-coded theme-appropriate cycle. Per §4.0:
// minimal-controls — picking dot colours individually opens the
// door to ugly off-brand pills.
export type CalendarCellOverride =
  | { type: 'text';  text: string }                        // colour auto-fills from theme cycle
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

**Replan locked May 21, 2026.** Absorbs all decisions from §10 (calendar product type, single-template authoring, per-surface overrides) and §11 (16 edge-case resolutions). Dependency-ordered; critical path = ~18 days; serial single-engineer = ~25.5 days.

```
Phase 1 (foundation)
   │
   ├── Phase 2 (schema) ──┐
   └── Phase 3 (data)  ───┤
                           ▼
                       Phase 4 (renderer) ──┐
                                            ├── Phase 5 (customer UI) ──┐
                                            └── Phase 6 (ops UI)       ─┤
                                                                        ▼
                                                                  Phase 7 (multi-surface)
                                                                        │
                                                              ┌─────────┼─────────┐
                                                          Phase 8     Phase 9   Phase 10
                                                         (uploads)   (polish)    (QA)
```

### Phase 1 — Server-side overlay rendering (v1.12, ~4 days)

**The unblocker for everything.** Fixes the pre-existing gap where text/shape/image overlays vanish from the printed file. Ships on its own; valuable independent of calendar.

| Day | Deliverable |
|---|---|
| 1 | `services/fonts.py` — lazy-cached `PIL.ImageFont` factory. **Single bundled font: `Inter-Variable.ttf`** in `services/fonts_assets/` per §11.7. No font picker exposed to ops or customer. Startup check warns if the font file is missing; renderer falls back to `ImageFont.load_default()`. |
| 2 | `services/overlay_renderer.py` — `render_overlays(canvas, overlays, canvas_w_px, canvas_h_px, uploaded_files)` for **text + shape**. Smoke-test by adding a text overlay in dev and rendering at 300 DPI. |
| 3 | Image-overlay path (reuse the chunked-upload pipeline; pull bytes from `upload_id → file_path` map). Wire `render_overlays` into `engine._generate_for_surface` after compositing, before mask. |
| 4 | E2E test: dashboard render with mixed text + shape + image overlays; confirm dataUrl preview ≈ rendered PNG. Doc updates in CLAUDE.md. |

**Success criteria:**
- Canvas with one text overlay ("Hello world") renders the same text in the same position in the downloaded PNG as in the preview.
- All three existing overlay types render server-side.
- No regression on layouts without overlays (pixel-diff < 1% on baseline set).

### Phase 2 — Calendar product type schema (v1.13, ~3 days)

Lands all schema + validator changes for calendar layouts. Can run in parallel with Phase 3.

| Day | Deliverable |
|---|---|
| 1 | Layout JSON schema: add `productType: 'calendar'`, `calendars: []` (plural per §11.1), `monthRange: { count, defaultYear }`, `surfaceOverrides`, ops-default + customer-controllable fields. TypeScript types (`CalendarState`, `CalendarCellOverride`, `LayoutCalendar`, `MonthRange`). |
| 2 | Backend validator (`api/validators.py`): enforce `monthRange.count × calendars.length === 12` (§11.1), reject banned fields in `surfaceOverrides[*]` (§11.15), range-check positions and offsets. `LayoutManagementView` accepts new fields round-trip. |
| 3 | Multi-surface auto-derivation from single template. Resolution formula (§11.1): `totalOffset = surfaceIndex + (calendarMonthOffset ?? 0)`. Auto-set `displayLabel` to "January 2026"-style names (§11.6). |

### Phase 3 — Style presets + holiday data (v1.13, ~1.5 days)

Static config + data files. Can run in parallel with Phase 2.

| Day | Deliverable |
|---|---|
| 1 | `storage/calendar_styles/{modern-minimalist,modern-genz,weekday-highlight}.json`. `storage/calendar_palettes/genz/*.json` (4 palettes: Butter & Purple, Mint & Hot Pink, Lilac & Coral, Sky & Lemon — each with `dotCycle`). Endpoints: `GET /api/calendar-styles/`, `GET /api/calendar-styles/<name>`, `PUT /api/ops/calendar-styles/<name>`. |
| 0.5 | Seed `storage/holidays/en-IN/{2026..2030}.json` from Nager.Date. Seed `storage/holidays/generic/{2026..2030}.json` with universal observances (§11.11). Endpoints: `GET /api/holidays/<locale>/<year>` (public, cached `public, max-age=86400, swr=604800`), `PUT /api/ops/holidays/<locale>/<year>`, `DELETE`. `scripts/refresh-holidays.py` — annual ops task (§11.9). |

### Phase 4 — Calendar renderer (client + server, v1.13, ~5 days)

Depends on Phase 1, 2, 3.

| Day | Deliverable |
|---|---|
| 1 | `frontend/nextjs/src/lib/calendar.ts` — shared month-grid math (`date-fns` based). Implements §10.4 baseYear derivation (English vs Financial) and §11.1 resolution formula. Used by both Fabric renderer and sidebar UI. |
| 2 | `fabric-renderer.ts` extension: `buildCalendarFabricGroup` — renders the calendar grid as a Fabric `Group` (Rect grid + Textbox dates + pill badges). Lives at `overlayZStart + overlays.length + 1`. |
| 3 | `services/calendar_renderer.py` — server-side grid math + cell drawing. Implements user-first precedence (§11.14), hard cap of 3 entries (§11.10), out-of-month cells render date number only (§11.12), IST timezone with ISO strings throughout (§11.13). |
| 4 | Wire `render_calendar` into `engine.py` after `render_overlays` (calendar on top, below mask). Auto-fit text via `ImageFont.getbbox()` binary search (~15 LOC per PRD §4.4). |
| 5 | E2E: render a single canvas with date grid + holiday pills at 300 DPI. Pixel-diff between editor preview and server render ≤ 2%. |

### Phase 5 — Customer-facing preview (v1.13, ~3 days)

Depends on Phase 4. Can run in parallel with Phase 6.

| Day | Deliverable |
|---|---|
| 0 | **Frontend test runner setup + TS↔Python parity** (~0.5 d, deferred from Phase 4 review). The frontend currently has no `"test"` script in package.json. Add a minimal Node-native or Vitest test runner so Phase 5 components can be tested. As the first task on the runner, wire up the 4 parity pins from `test_calendar_renderer.py` (Jan 2026 Sunday/Monday-first, Apr 2026 + Mar 2027 FY edges) so any drift between `lib/calendar.ts` and `services/calendar_renderer.py` fails CI. Extract the fixtures to a shared `storage/calendar_parity_fixtures.json` (or similar) so both sides consume the same ground truth. |
| 1 | `CalendarProductPreview.tsx` — 12-month grid component. Theme preset segmented toggle, Gen-Z palette swatches (interlinked, only visible when theme=Gen-Z), Calendar type toggle (English / Financial). Year auto-populated from today + calendar type (read-only). |
| 2 | Calendar type flip warning modal (§11.4). Year derivation: English → `currentYear`; Financial → `today.month >= 3 ? currentYear : currentYear − 1`. 12 month thumbnails grid; tap → opens per-month canvas editor for that surface. |
| 3 | `CalendarEditPanel.tsx` — tap a cell → add text entries (cap=3 per §11.10), upload image override, or reset. User-first precedence in entry list (§11.14). |

### Phase 6 — Ops authoring UI (v1.13, ~3 days)

Depends on Phase 4. Can run in parallel with Phase 5.

| Day | Deliverable |
|---|---|
| 1 | `CalendarLayoutEditor.tsx` shell in `/editor/layouts` — "Create new layout" → product type picker (Single / Multi-surface / **Calendar**). Calendar mode shows the template editor: drag-and-drop calendar primitive(s) + photo frames on ONE representative month. Mode toggle: multi-surface (12 × 1) vs multi-calendar-single-page (1 × 12). |
| 2 | Per-month tile pane (12 tiles) — each tap opens per-month editor pre-loaded with merged effective config (template ⊕ `surfaceOverrides[month_ii]`). "Customized" badge per modified tile. "Reset to template" per-month action. Save → diff against template persisted to `surfaceOverrides`. |
| 3 | "🗓 Calendar" badge in customer-facing layout list (`ListLayoutsView` returns `hasCalendar` flag). Ops-side smoke test: create a 5×7 desk calendar layout end-to-end. |

### Phase 7 — Multi-surface render integration (v1.13, ~2 days)

Depends on Phase 4 + 6. Pulls the whole pipeline together.

| Day | Deliverable |
|---|---|
| 1 | `tasks.py` `render_canvas_task` handles N surfaces for calendar products. Per-surface (year, month) resolution via §11.1 formula. ZIP filename from `displayLabel` (§11.6). |
| 2 | Multi-surface partial-failure handling (§11.5): fail-all-or-nothing with retry warning. Verify embed flow: `EmbedSession` → render → ZIP → webhook → caller pulls. |

### Phase 8 — Cell-image upload pipeline (v1.13, ~1 day)

Depends on Phase 5. Mostly reuse.

| Day | Deliverable |
|---|---|
| 1 | Cell-image uploads reuse existing chunked-upload API. IDB-backed file persistence keyed by `uploadId` (B1 pattern reused). Cell-image expiry handling (§11.3): show "Image expired — re-upload" inline if GC'd. Auto-orientation already wired via v1.11 MediaPipe. |

### Phase 9 — Polish, safeguards, docs (v1.13, ~2 days)

Depends on Phases 5–8.

| Day | Deliverable |
|---|---|
| 1 | Cell-text auto-fit via `getbbox()` binary search (per §4.4). Feb 29 toast for non-leap year auto-roll (§11.8). Mobile UX: cell editing as bottom-sheet on narrow viewports. S3-readiness audit (§11.17): grep for hardcoded disk paths outside `EXPORTS_DIR`. |
| 2 | Performance pass: 12-canvas calendar batch renders within the same wall-time envelope as a 12-photo render (target: ≤ 90 s server-side). Doc updates — CLAUDE.md "Calendar" section, .env.example if any new vars, version history row for v1.12 + v1.13. |

### Phase 10 — Smoke tests & QA (v1.13, ~1 day)

Depends on everything.

| Day | Deliverable |
|---|---|
| 1 | Synthetic tests: (a) ops creates desk-calendar layout → customer fills 12 months → render → ZIP → verify naming + content. (b) Multi-calendar (year-on-one-poster) variant. (c) Calendar type flip mid-edit with orphan entries. (d) Holiday auto-load for 2026 and 2030. (e) IST timezone correctness near midnight. (f) `surfaceOverrides` round-trip via PUT `/api/ops/layouts/<name>`. |

---

**Total effort: ~25.5 days serial single-engineer; ~18 days with two engineers in parallel (Phases 2+3 and Phases 5+6 each parallelizable).**

| Phase | Effort | Depends on | v |
|---|---|---|---|
| 1 — Server-side overlay rendering | 4 d | — | v1.12 |
| 2 — Calendar schema | 3 d | 1 | v1.13 |
| 3 — Style presets + holiday data | 1.5 d | — | v1.13 |
| 4 — Calendar renderer | 5 d | 1, 2, 3 | v1.13 |
| 5 — Customer-facing preview | 3 d | 4 | v1.13 |
| 6 — Ops authoring UI | 3 d | 4 | v1.13 |
| 7 — Multi-surface render integration | 2 d | 4, 6 | v1.13 |
| 8 — Cell-image upload pipeline | 1 d | 5 | v1.13 |
| 9 — Polish + safeguards + docs | 2 d | 5–8 | v1.13 |
| 10 — Smoke tests & QA | 1 d | all | v1.13 |
| **Total** | **25.5 d** | | |

---

## 6. Risks & open questions

### 6.1 Risks (ranked by severity)

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | **Server-side text rendering quality** — Pillow's text rendering is not as crisp as a browser's font hinting. Some font families look noticeably different at 300 DPI between preview and print. | Medium | Pre-render a side-by-side diff during Phase 1; if any family fails QA, drop it from the bundled list. Stick to Inter / Roboto as safe defaults. |
| 2 | **Font licence drift** — when ops adds a new font through the existing header UI, the licence needs to be OFL / Apache / equivalent. Misreading a licence is easy to do quietly. | Low–Medium | The header-UI font-add flow already mandates that ops adds only Google-Fonts-sourced families (all SIL OFL or Apache 2.0). Add a `LICENSES.md` next to `services/fonts_assets/` listing each `.ttf`'s licence and source URL; ops fills it in alongside the file drop. |
| 3 | **Calendar cell-image upload races** — customer uploads, leaves the editor before the upload completes, returns later. Cell shows broken image. | Medium | Persist `upload_id` to IDB on file selection (B1 pattern). Re-resolve on editor reload via `upload_id → file_path` map. If file is missing on render, fall back to date number + log. |
| 4 | **Layout has calendar but customer never picks year** — defaults to whatever ops set; could be stale (e.g. 2025 when customer is buying for 2026). | Medium | Ops sets a "rolling default" flag: `defaultYear: "current"` resolves to `new Date().getFullYear()` on editor mount. |
| 5 | **i18n complexity creep** — different locales want different weekday orders, ordinal suffixes, holiday colouring. Easy to scope-creep. | High | Lock v1 to: `weekStart=monday\|sunday` + weekday name from `Intl` + holidays for `en-IN` and `generic` only. Anything else (`en-US`, `en-GB`, etc.) is added by ops upload when needed. |
| 6 | **Z-order conflict with frame outlines** — the calendar might visually clash with the safe-zone / bleed-zone outlines on the preview (not the print). | Low | Hide outlines whenever a calendar overlaps them in the preview, via the existing `isTransforming` opacity dimming. |
| 7 | **Mobile editor UX for cell editing** — 42 tiny tap targets on a phone is painful. | Medium | Cell editor opens as a bottom-sheet list view on narrow viewports (md breakpoint), not the canvas itself. |

### 6.2 Open questions — status

| # | Question | Decision |
|---|---|---|
| 1 | Which fonts? | **✅ Resolved.** Reuse the existing `storage/fonts.json` list managed via the header UI — same fonts the text-overlay picker already uses. No separate calendar-fonts sign-off. Ops adds a new font once, both text overlays and calendar pick it up. (Server-side rendering still needs the `.ttf` dropped alongside the JSON entry — see §3.5.) |
| 2 | Storefront pre-selects year/month via embed metadata? | **TBD** — defer to ops feedback after first calendar SKU goes live. In-editor selector ships v1.13. |
| 3 | Per-cell pan/scale on image overrides? | **v1 = auto-fit only.** Per-cell pan/scale lands in v2 if ops sees the demand. |
| 4 | Holiday auto-load? | **✅ IN SCOPE for v1.13.** Hybrid maintenance: 5-year seed (`2026–2030`) for `en-IN` + `generic` locales sourced from [Nager.Date](https://date.nager.at/) at build time; ops upload endpoint available for corrections + new locales without a deploy. |
| 5 | Non-Gregorian calendars (Hijri / Shaka / Vikram Samvat)? | **v2 candidate.** v1.13 is Gregorian-only. |
| 6 | Year range? | **`currentYear − 5` to `currentYear + 5`.** Configurable per layout via `calendar.yearRange`. |
| 7 | Ops can lock specific cells to pre-defined text? | **v2 candidate.** v1.13 lets ops define a holiday list; cells aren't otherwise lockable. |
| 8 | **NEW** — Cell entry pill style (post-design-review with mockup) | **✅ Pill design locked.** Date number always visible top-right; entries stack below; cap `MAX_ENTRIES = 3` (configurable per layout via `calendar.style.maxEntriesPerCell`); rounded-rect pill with auto-fill dot + text; "+N more" overflow indicator. **Pill background = single theme-wide colour. Dot colour rotates through a 3-slot per-theme cycle by entry index** (so 1st / 2nd / 3rd user entries in a cell each get a distinct dot) — keeps multi-entry cells readable without a picker. On Gen-Z the cycle comes from the active palette's `dotCycle`. (Holiday entries keep their own colour from the holiday JSON.) |
| 9 | **NEW** — Three style presets (Modern Minimalist / Modern Gen-Z / Weekday Highlight) | **✅ Locked.** Stored as JSON in `storage/calendar_styles/`; ops picks one when authoring a layout; resolved style fields written to layout JSON; customer cannot switch presets (preserves design intent). |

### 6.3 Confirmed scope additions (post-design-review)

After the first design review the following additions were locked in. They are NOT part of the original v1.13 estimate (~14 days); they add **~3.5 days** for a revised total of **~17.5 days**.

**a. Pill-style cell entries (replaces "override" model)**

- Date number always visible (top-right by default).
- User events stack below as small pill badges: rounded-rect bg + 6 px dot + 9–10 pt auto-fit text. **Pill bg = single theme-wide colour. Dot colour rotates through a 3-slot per-theme cycle by entry index**, so the 1st / 2nd / 3rd user entries in a cell get distinct dots automatically (e.g. amber → rose → sky on Modern Minimalist). On Gen-Z the cycle comes from the active palette's `dotCycle` field. Customer sees no colour picker.
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
| `modern-genz` | parameterised by **4 coordinated palettes** (Butter & Purple, Mint & Hot Pink, Lilac & Coral, Sky & Lemon). Each palette sets all 6 colour roles together: page bg, grid colour, month text, weekday header, date number, entry-pill bg. **Plus a 3-slot `dotCycle`** that auto-assigns user-entry dot colours by index (e.g. Butter & Purple cycles purple → pink → sky). Customer picks one palette swatch in the editor — that's the *only* Gen-Z customisation control. Default palette = Butter & Purple. | Trendy 2026 palettes; new palettes ship as additional JSON files under `storage/calendar_palettes/genz/` — no code change |
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

1. **Confirm the remaining open questions in §6.2 with Viji + Mohan + Manish** — ~15 min meeting (most are resolved; only Q2/Q5/Q6/Q7 remain).
2. **Drop the existing `fonts.json` font families' `.ttf` files** into `backend/django/services/fonts_assets/` — one-time prep work for ops, no engineering needed. (Resolved once Phase 1 lands.)
3. **Kick off Phase 1 (foundation)** — independent of calendar; ships v1.12. ~4 days.
4. **Phase 2 + 3 in parallel** if 2 engineers available; otherwise serial. ~8 days.
5. **Phase 4 polish** — ~2 days.
6. **v1.13 ship target:** ~3 working weeks from kickoff.

---

## 10. Calendar Product Type Architecture (May 21, 2026 amendment)

This section folds in architectural decisions made after the original PRD draft. It supersedes the §4.0 table for the controls listed below.

### 10.1 Calendar as a Multi-Surface Product

A 12-month calendar is modelled as a regular Multi-Surface Product with a new top-level flag:

```jsonc
{ "productType": "calendar", ... }
```

The system already has full multi-surface plumbing: `LayoutEngine.generate()` dispatches per-surface, the ZIP packager bundles N files, the embed webhook fires once when all surfaces complete. Adding a `productType` tag on top is the entire architectural cost — **no changes to render, embed, or webhook code.**

**Why not a separate "Calendar" product category.** A new category would fork the codebase (two render pipelines, two ops UIs, two preview UIs) and would contradict §4.1's "calendar is a positioned region inside any canvas" principle.

**Why not pure Multi-Surface (no flag).** Without the flag, ops would have to manually create 12 surfaces, manually drop the calendar primitive on each, and manually keep global controls (theme, calendar type) in sync across all 12. The flag lets the system auto-generate the 12 surfaces from a single template.

### 10.2 Single-template authoring + 12-surface auto-gen

Ops designs ONE representative month — drops the calendar primitive in one area, photo frames in another. The layout JSON stores this single template; at customer-editor mount, the system materializes 12 surfaces from it.

```jsonc
{
  "name": "family_desk_calendar_5x7_landscape",
  "productType": "calendar",

  "canvas": { "widthMm": 178, "heightMm": 127, "dpi": 300 },
  "frames": [...],                       // photo frame(s) — same on every month

  "calendar": {                          // calendar primitive position + style
    "x": 0.05, "y": 0.6, "width": 0.9, "height": 0.35,
    "themePreset":  "modern-minimalist", // ops default; customer can change
    "calendarType": "english",           // ops default; customer can change
    "weekStart":    "sunday",            // ops locked
    "holidaySource": { "enabled": true, "locale": "en-IN" },
    "style": { ... }
  },

  "monthRange": {
    "count": 12,
    "defaultYear": "current"             // auto-rolls; never freezes
  }
}
```

**Surface index → (year, month) resolution.** Customer's calendar type selection drives `startMonth`:

- `english`   → `startMonth = 1`   (Jan..Dec)
- `financial` → `startMonth = 4`   (Apr..Mar of next FY year)

```
realMonth = ((startMonth - 1 + i) % 12) + 1
realYear  = baseYear + Math.floor((startMonth - 1 + i) / 12)
```

where `i` is the surface index (0..11) and `baseYear` is derived from `defaultYear: "current"` at mount time (see §10.4).

### 10.2.1 Per-surface overrides (sparse, optional)

Once the 12 surfaces are auto-materialized from the template, ops can drill into any individual month and override its *structure* (frame layout, calendar position, decorative overlays). The auto-generated template is the starting point, not a permanent constraint — months that don't need customization continue to inherit from the template; months that do hold a sparse field-level override.

**Data model — one new optional field on the layout JSON:**

```jsonc
{
  "productType": "calendar",
  "canvas":   { ... },              // template canvas (locked across all months)
  "frames":   [...],                // template frames
  "calendar": { ... },              // template calendar primitive
  "monthRange": { ... },

  // NEW — sparse, keyed by surface key. Absent entries inherit from template.
  "surfaceOverrides": {
    "month_03": {                   // March has its own frame layout
      "frames": [...]
    },
    "month_12": {                   // December adds a winter-themed overlay
      "overlays": [
        { "type": "image", "src": "snowflakes.png", "x": 0.8, "y": 0.05, ... }
      ]
    }
  }
}
```

**Merge semantics.** At render time, each surface's effective config:

```
effective(surface_i) = template ⊕ surfaceOverrides[month_ii]
```

Override fields **replace** the corresponding template field (not deep-merge). Untouched fields inherit. A surface with no entry in `surfaceOverrides` renders identically to the template; only the resolved `(year, month)` varies.

**Allowed per-surface overrides:**

| Field | Override allowed? | Notes |
|---|---|---|
| `frames` | ✅ | Replace the whole `frames[]` array — different layouts per month are fine |
| `calendar.{x, y, width, height}` | ✅ | Reposition the calendar primitive (e.g. smaller cal box for Dec to make room for a decorative element) |
| `overlays` | ✅ | Add per-month decorations (snowflakes for Dec, hearts for Feb, etc.) |
| `canvas.{widthMm, heightMm, dpi}` | ❌ | Physical product dimensions — must match the SKU; can't differ across months |
| `calendar.themePreset` | ❌ | Customer-controllable on preview page (§10.3) — per-surface override would create merge ambiguity |
| `calendar.calendarType` | ❌ | Customer-controllable on preview page (§10.3) — drives `startMonth` resolution, must stay layout-global |
| `calendar.weekStart` | ❌ | Locale convention; layout-global |

**Ops UX (Phase 5):**

1. Create layout → ops designs the template (calendar primitive + photo frames on ONE representative month) → save.
2. Layout editor's "Months" pane shows 12 tiles (Jan..Dec or Apr..Mar depending on default `calendarType`).
3. Each tile is a thumbnail preview of how that month will render — initially all identical to the template.
4. Click any tile → opens the per-month editor pre-loaded with the merged effective config (template + that month's existing override if any).
5. Modify frames / reposition the calendar / add overlays → save → only the *diff* against the template is persisted into `surfaceOverrides[month_ii]`.
6. Customized tiles show a "Customized" badge so ops can see at a glance which months differ from the template.
7. "Reset to template" button on each customized month → clears its entry from `surfaceOverrides` — the surface goes back to inheriting from the template on next save.

**Customer-side impact: zero.** Customer sees the 12 materialized surfaces with all overrides already baked in. They edit at the cell-content level (entries, image overrides) — the structural layout (frames, calendar position, ops-added decorative overlays) is read-only to them, exactly as it is on today's single-month products.

**Why field-level replace, not deep merge.** Deep-merging arrays (frames, overlays) is ambiguous — "merge by id"? "concatenate"? "positional"? Each interpretation leaks to UX. Field-level replace keeps the contract trivial: if ops touched `frames` on a month, that month uses the overridden `frames` entirely; otherwise inherit. Diff tracking on save uses a structural-equality check against the template.

### 10.3 Ops vs Customer control split (updated)

| Control | Ops sets (default) | Customer changes on preview page | Why |
|---|---|---|---|
| Aspect ratio | ✅ locked | — | Physical SKU dimensions |
| Week starts | ✅ locked | — | Cultural convention per layout / locale |
| **Theme preset** (Minimalist / Gen-Z / Weekday-Highlight) | ✅ default | ✅ | Custom-printing concept — customer picks the vibe |
| **Gen-Z palette** (when theme=Gen-Z) | ✅ default | ✅ | Sub-option of Gen-Z theme; picker only renders when theme=Gen-Z (the two are interlinked in the UI) |
| **Calendar type** (English / Financial) | ✅ default | ✅ | Same SKU; customer picks calendar style |
| Year | — | **auto-populated** from today + calendar type | No manual year picker; see §10.4 |
| **Per-cell entries** | — | ✅ | Pill badges customer types into a day's cell ("Mom's birthday" on Jan 7). Cap = 3/cell. `CalendarCellOverride` `{ type: 'text', text }` (§4.2.2) |
| **Image overrides** | — | ✅ | Replace whole cell with an uploaded image (baby photo on the day of birth, logo on an anniversary). Date number disappears. `CalendarCellOverride` `{ type: 'image', uploadId }` (§4.2.2) |

**Customer preview page (v1.13) renders:**
- Theme preset segmented toggle (3 options)
- Gen-Z palette swatches — visible only when theme = Gen-Z
- Calendar type segmented toggle (English / Financial)
- 12 month thumbnails in a grid; tap one → opens the per-month canvas editor
- Year is shown read-only (e.g. "FY 2026–27" in financial mode)
- Per-month editor: cell entries + image overrides as in §4.2.2

### 10.4 Auto-rolling year (no manual maintenance)

`defaultYear: "current"` resolves at editor mount via the active `Date()` — layout files never freeze to a specific year. A "Family Calendar" layout published in 2026 prints 2026 dates throughout 2026, then automatically prints 2027 starting Jan 1, 2027, with zero ops intervention.

Combined with the customer's calendar-type choice:

```js
if (calendarType === 'english') {
  baseYear = today.getFullYear();              // e.g. 2026
} else {
  // Apr–Dec ⇒ current calendar year IS the FY-start year
  // Jan–Mar ⇒ previous calendar year is the FY-start year
  baseYear = today.getMonth() >= 3
           ? today.getFullYear()
           : today.getFullYear() - 1;
}
```

For today May 21, 2026:
- `english` → baseYear = 2026 → grid spans Jan 2026 → Dec 2026
- `financial` → baseYear = 2026 → grid spans Apr 2026 → Mar 2027 (FY 2026–27)

### 10.5 Photobook and other future product types

Multi-Surface Product is the generic substrate for any "designed once, replicated N times with per-instance data" product. **Photobook** is the immediate next candidate:

```jsonc
{
  "productType": "photobook",
  "pageRange": { "count": 20, "layout": "spread" }
}
```

The pattern reuses:
- Multi-surface render pipeline (zero changes)
- Single-template authoring (ops designs a representative page; system materializes N)
- Embed flow, ZIP packaging, webhook payload

Differences from calendar (handled in the photobook-specific PRD):
- N is variable (customer picks 20-page / 40-page / 60-page SKU)
- No calendar primitive — just photo frames + optional text
- Pages may be "spreads" (left + right bound as one design unit) vs single pages

Each `productType` gets its own ops authoring UI and customer preview UI, but the storage + render layer is shared. **`productType` is the extension point for new products** — same pattern for calendar, photobook, brochure, multi-page card, etc.

### 10.6 Resolved open questions (May 21, 2026)

These items in §6.2 are now resolved by this amendment:

| # | Question | Resolution |
|---|---|---|
| 10 | Multi-surface vs new product category? | **Multi-Surface + `productType` tag.** No new category. (§10.1) |
| 11 | Customer-facing controls on preview page? | **Theme preset + Gen-Z palette + Calendar type are customer-controllable**; aspect ratio + week start ops-locked; year auto-populated. (§10.3) |
| 12 | Same SKU for English vs Financial? | **Yes — same SKU.** Customer toggles on preview page; the 12 surfaces re-derive instantly. (§10.3) |
| 13 | Auto-roll dates for next year? | **Yes — `defaultYear: "current"`** resolves at mount; layouts never freeze to a year. (§10.4) |
| 14 | Mixed month ranges (quarterly, academic)? | **v1 = 12-month annual only.** Schema allows arbitrary `monthRange.count`/`startMonth` for future use. (§10.5) |
| 15 | What about photobook later? | **Same Multi-Surface + `productType` pattern;** photobook gets its own ops/preview UIs but reuses storage + render layers. (§10.5) |

### 10.7 Revised effort — superseded by the §5 replan

The Phase 5 breakdown that originally lived here has been folded into the §5 master phase plan (Phases 2 + 4 + 6). The calendar product type work is now distributed across schema (Phase 2), renderer integration (Phase 4), and ops authoring UI (Phase 6) rather than treated as a single Phase 5. **Effort total stays at ~25.5 days; see §5 for the current breakdown.**

---

## 11. Edge cases & defaults (May 21, 2026 amendment)

Consolidated edge-case resolutions agreed during PRD review. Each subsection is a locked decision; deviating requires an explicit re-review.

### 11.1 Single vs multiple calendar primitives per layout

`calendar` (singular) → **`calendars: []`** (plural array). A layout has one or more calendar primitives; each has its own position + optional `monthOffset`. Two configurations supported in v1:

**(a) Multi-surface mode** — desk/wall calendar with 12 pages:
- `monthRange.count = 12`, `calendars.length = 1`
- Surface index drives the month (surface 0 = Jan, surface 1 = Feb …)
- Each surface renders one calendar grid

**(b) Multi-calendar single-surface mode** — year-on-one-poster:
- `monthRange.count = 1`, `calendars.length = 12`
- Each calendar entry has explicit `monthOffset: 0..11`
- All 12 calendars render on a single page; the photo frame sits above them (or wherever ops positions it)

**Resolution formula** (handles both modes uniformly):

```js
totalOffset = surfaceIndex + (calendarMonthOffset ?? 0);
realMonth   = ((startMonth - 1 + totalOffset) % 12) + 1;
realYear    = baseYear + Math.floor((startMonth - 1 + totalOffset) / 12);
```

**Constraint (v1):** `monthRange.count × calendars.length === 12`. Validator rejects other products. Mixed-grid (e.g. 4 surfaces × 3 calendars/surface) is mathematically valid but UI ships only the two patterns above.

### 11.2 Per-month theme override — not supported in v1

`themePreset`, `calendarType`, `weekStart` are layout-global. Per-surface `surfaceOverrides` cannot include these fields (validator rejects per §11.15). Ops cannot make December look thematically different from January at the layout level. **Workaround:** per-surface `overlays` for decorative accents (snowflakes for Dec, hearts for Feb). Per-surface theme is a v2 candidate.

### 11.3 Cell-image expiry — re-upload on reopen

Cell-image uploads follow the existing `UploadedFile` GC policy. If a customer reopens a calendar after the image was GC'd, the cell renders blank with an inline **"Image expired — please re-upload"** prompt. No automatic recovery; customer re-uploads. Calendar embed sessions are short-lived enough that this is rare in practice.

### 11.4 Calendar type flip mid-edit — warning modal

When customer toggles English ⇄ Financial and N existing entries fall outside the new visible 12-month range, show a confirmation modal:

> Switching to **Financial year** changes the visible range. **N entries** outside the new range will be hidden but not deleted. Switch back to **English** to see them. **Continue?**

Orphaned entries stay in `editor_state.cells` keyed by ISO date; they re-render if the customer flips back.

### 11.5 Multi-surface partial-render failure — fail-all-or-nothing + warning

If any 1 of N surfaces fails to render, the entire RenderJob fails (`status: 'failed'`). Customer-facing retry re-renders all N surfaces. Warning on retry button:

> Render failed on month **March**. Retrying will re-render all 12 months from scratch.

Per-surface retry is a v2 candidate.

### 11.6 ZIP filename convention — from Multi-Surface Display Label

ZIP entries are named from each surface's `displayLabel` field on the Multi-Surface Product schema. For calendar products, the system auto-sets `displayLabel` to the resolved month + year:

```
January 2026.png
February 2026.png
…
December 2026.png
```

Non-calendar multi-surface products (cards, brochures) use the ops-set label (`Front.png`, `Back.png`). For Financial-year calendars, labels span the FY: `April 2026.png … March 2027.png`.

### 11.7 Font — single bundled default, no picker

The calendar renderer uses **Inter Variable** (bundled in `backend/django/services/fonts_assets/Inter-Variable.ttf`) for every text element — date numbers, weekday headers, entry pills, "+N more" indicators, all of it. **No font picker is exposed to ops or customer.** The §4.2.1 layout-JSON `style.fontFamily / fontWeight / headerFontWeight` fields are removed.

Net effect: no font drift between editor preview and 300 DPI render; ops authoring is simpler; production failure mode ("font missing") eliminated.

### 11.8 Leap year — Feb 29 entries on non-leap years

Auto-roll to a non-leap year (2024 → 2025) hides Feb 29 entries from the visible grid. Entries survive in `editor_state.cells` keyed by their original ISO date `"2024-02-29"`. One-time toast on first non-leap render:

> 1 entry on Feb 29 won't appear in 2025.

Customer can roll back to a leap year to see them. (For auto-rolling layouts, this is rarely visible — only matters if customer's editing carried over from one year's draft into the next.)

### 11.9 Holiday list maintenance — annual ops task

`storage/holidays/<locale>/<year>.json` is seeded for `en-IN` + `generic` × 2026–2030. Each January, ops runs `scripts/refresh-holidays.py` to pull the next year from Nager.Date. Calendars rolling to a year without a holiday file render with no auto-injection (no error, customer adds their own entries). Annual maintenance task documented in CLAUDE.md ops section.

### 11.10 No overflow indicator — hard cap of 3 total entries per cell

There is no "+N more" badge. A cell renders at most **3 entries total** (user + auto-loaded holidays combined). Anything beyond the cap is silently suppressed by the renderer per the §11.14 user-first precedence rule.

Customer experience:
- "Add event" button disables when total visible entries = 3.
- If 3 holidays auto-load on the same day (rare, e.g. national + regional overlap), the cell shows all 3 holidays and the customer cannot add their own entry on that day.
- If customer fills 3 user entries on a day that also has a holiday, the holiday silently disappears from the render. Removing a user entry causes the previously-suppressed holiday to re-appear.

Cell-editor panel mirrors the render (same 3 visible entries) — no separate "all entries" view.

### 11.11 `generic` locale — flexible holiday source

`storage/holidays/generic/<year>.json` ships with universal observances (New Year, Christmas, Easter, Valentine's Day). Ops can replace or extend via existing `PUT /api/ops/holidays/generic/<year>` endpoint. Useful for layouts that don't want India-specific holidays.

### 11.12 Out-of-month cells — date number only, no entries

Cells from the previous or next month (the "filler" cells at the start/end of the 6-week grid) render the date number in `style.outOfMonthColor` (greyed). **No entries, no holiday pills, no image overrides.** Cleaner visual; avoids ambiguity ("is this entry for current month or the next?").

### 11.13 Server-side renderer timezone — IST-only for v1

All date math uses ISO date strings (`YYYY-MM-DD`) end-to-end; the renderer never calls `datetime.now()` for date resolution. The frontend computes "today" in `Asia/Kolkata` for the auto-year derivation. **All customers in India** for v1; international expansion is a v2 concern.

### 11.14 MAX_ENTRIES precedence — user-first

Hard cap of `MAX_ENTRIES = 3` total per cell (user + holidays combined). When a cell has both:
1. User entries fill slots first (up to 3)
2. Holidays fill remaining slots
3. Anything beyond the cap is **silently suppressed** — no "+N more" badge (§11.10)

**Reverses the original §6.3 holidays-first rule.** Customer intent takes priority over auto-injection. A day with 3 user entries hides any holiday that would have auto-loaded there; removing a user entry causes the suppressed holiday to re-appear.

### 11.15 Validator — reject banned fields in `surfaceOverrides`

`PUT /api/ops/layouts/<name>` rejects layouts where any entry in `surfaceOverrides[*]` contains a forbidden field:

```
banned = { themePreset, calendarType, weekStart, canvas, monthRange }
```

Returns `400 Bad Request` with the specific field name. Prevents ops from bypassing §10.2.1 / §11.2 via manual JSON edits.

### 11.16 Layout versioning — fresh load on every embed

The Product Editor does NOT version layouts. Each embed session loads the **current** state of the layout JSON from disk. Implications:

- Ops updates a template → next customer (or returning customer) sees the new template immediately.
- A customer's existing `surfaceOverrides` continue to apply; references to deleted frame IDs silently render as empty frames.
- No `layoutVersion` field, no cache invalidation complexity.

**Acceptable for v1** because calendar layouts are short-lived (one session) and ops rarely changes published layouts mid-quarter. If layout-edit frequency rises post-launch, add `layoutVersion` + lock active orders to their submission-time version.

### 11.17 v2 readiness — S3 download path

The Next.js proxy buffers full ZIPs in memory before forwarding to the browser (300 MB peak for a 12-month high-res calendar). **v1 ships with the existing on-disk + streaming approach;** v2 moves rendered output to an S3 bucket and has the customer's browser fetch the ZIP via a signed S3 URL directly (skipping the Next.js proxy entirely).

To make the v2 swap a contained change rather than a refactor, v1 keeps these contracts S3-friendly:

| Contract | v1 behavior | v2 swap |
|---|---|---|
| `download_url` in webhook payload | Points at `https://product-editor.printo.in/api/jobs/<job_id>/download/` (Django streams from disk) | Points at signed S3 URL; same field name, same caller code |
| `RenderJobDownloadView` | Streams from `EXPORTS_DIR/<job_id>/*.zip` | Issues `302 Redirect` to signed S3 URL; same endpoint, same auth check |
| Engine output path | `EXPORTS_DIR/<job_id>/<displayLabel>.png` | `s3://printo-product-editor/jobs/<job_id>/<displayLabel>.png`; same filename convention (§11.6) |
| Webhook payload schema | Unchanged | Unchanged — callers see no difference |

**v1 implementation rule:** all file output uses the existing `EXPORTS_DIR` abstraction (already centralized in `engine.py` + `tasks.py`). No new code should hardcode disk paths outside that abstraction.

---

*— end of PRD —*
