/**
 * Shared book/booklet/photobook math — the TypeScript twin of
 * `backend/django/services/book_layout.py`. See BOOK_LAYOUT_PRD.md §5.3.
 *
 * Both sides MUST produce identical page counts, gutter shifts, spine
 * widths and display labels for the same inputs — this is the same
 * TS↔Python parity pattern as `caption-layout.ts` ↔
 * `LayoutEngine._resolve_caption_box` and `calendar.ts` ↔
 * `calendar_renderer.py`. Change a formula here and update
 * `book_layout.py` (and both parity suites) in the same commit, or the
 * customer's editor preview will disagree with the printed page.
 *
 * Design decisions this module implements (all settled 2026-08-14):
 *   D1 flat page list — one entry per printed SIDE, in physical order.
 *   D2 page count is CUSTOMER state, clamped to book.pageCount.
 *   D5 one book.gutterMm, mirrored by page parity.
 *   D6 edit single pages, preview spreads — `pagesToSpreads` serves the
 *      preview only; the editor works the flat list directly.
 *   D7 each role (cover / inner / backCover) carries its own canvas.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type BookRole = 'cover' | 'inner' | 'backCover';

export const ROLE_COVER: BookRole = 'cover';
export const ROLE_INNER: BookRole = 'inner';
export const ROLE_BACK_COVER: BookRole = 'backCover';

export interface PageCountSpec {
  min: number;
  max: number;
  step: number;
  default?: number;
}

export interface BookCanvasSpec {
  width?: number;
  height?: number;
  widthMm?: number;
  heightMm?: number;
  dpi?: number;
  bleedMm?: number;
}

export interface BookFrameSpec {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  xMm?: number;
  yMm?: number;
  [key: string]: unknown;
}

export interface BookOverlaySpec {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface BookRoleTemplate {
  canvas?: BookCanvasSpec;
  frames?: BookFrameSpec[];
  overlays?: BookOverlaySpec[];
  maskUrl?: string | null;
  maskOnExport?: boolean;
  [key: string]: unknown;
}

export interface BookBlock {
  bleedMm?: number;
  gutterMm?: number;
  pageCount: PageCountSpec;
  paperThicknessMm?: number;
  coverThicknessMm?: number;
  cover: BookRoleTemplate;
  innerPage: BookRoleTemplate;
  backCover?: BookRoleTemplate;
}

export interface BookLayoutLike {
  productType?: string;
  book?: BookBlock;
  pageOverrides?: Record<string, { frames?: BookFrameSpec[]; overlays?: BookOverlaySpec[] }>;
  maskUrl?: string | null;
  maskOnExport?: boolean;
}

export interface MaterializedPage {
  key: string;
  role: BookRole;
  pageIndex: number | null;
  displayLabel: string;
  gutterSide: 'left' | 'right' | null;
  canvas: BookCanvasSpec;
  frames: BookFrameSpec[];
  overlays: BookOverlaySpec[];
  maskUrl: string | null;
  maskOnExport: boolean;
  pageCount: number;
  spineWidthMm?: number;
}

const _DEFAULT_PAGE_COUNT = 24;
const _DEFAULT_STEP = 4;

const _ROLE_LABEL: Partial<Record<BookRole, string>> = {
  cover: 'Front Cover',
  backCover: 'Back Cover',
};

// ─── Page count resolution (D2) ─────────────────────────────────────────────

export function pageCountBounds(layout: BookLayoutLike): [number, number, number, number] {
  const spec = layout.book?.pageCount;
  let step = spec?.step ?? _DEFAULT_STEP;
  if (step < 1) step = 1;
  let lo = spec?.min ?? step;
  let hi = spec?.max ?? Math.max(lo, _DEFAULT_PAGE_COUNT);
  const def = spec?.default ?? lo;
  if (hi < lo) [lo, hi] = [hi, lo];
  return [lo, hi, step, def];
}

/**
 * Clamp a customer-requested page count onto the template's allowed grid.
 * Snaps UP, never down, so the customer never silently loses a page they
 * asked for. Mirrors `services/book_layout.py::resolve_page_count` exactly.
 */
export function resolvePageCount(layout: BookLayoutLike, requested?: number | null): number {
  const [lo, hi, step, def] = pageCountBounds(layout);

  let value: number;
  if (requested === undefined || requested === null || Number.isNaN(requested)) {
    value = def;
  } else {
    value = Math.trunc(requested);
  }

  if (value < lo) value = lo;
  if (value > hi) value = hi;

  const offset = value - lo;
  if (offset % step !== 0) {
    value = lo + (Math.floor(offset / step) + 1) * step;
  }
  if (value > hi) value = hi;
  return value;
}

// ─── Page parity / gutter side (D5) ─────────────────────────────────────────

/**
 * Page 1 is a recto (right-hand page), bound on the LEFT; page 2 is its
 * verso (left-hand page), bound on the RIGHT. Odd pages bind left, even
 * pages bind right. Mirrors `services/book_layout.py::gutter_side_for`.
 */
export function gutterSideFor(pageIndex: number): 'left' | 'right' {
  return pageIndex % 2 === 1 ? 'left' : 'right';
}

function canvasWidthMm(canvas: BookCanvasSpec | undefined): number | null {
  if (!canvas) return null;
  if (typeof canvas.widthMm === 'number' && canvas.widthMm > 0) return canvas.widthMm;
  if (
    typeof canvas.width === 'number' && canvas.width > 0 &&
    typeof canvas.dpi === 'number' && canvas.dpi > 0
  ) {
    return (canvas.width / canvas.dpi) * 25.4;
  }
  return null;
}

function asFloat(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return value;
}

/**
 * Resolve the horizontal shift for one page, as a fraction of canvas
 * width. Positive shifts right, negative shifts left. Mirrors
 * `services/book_layout.py::gutter_shift_fraction` — see that docstring
 * for the semantics (half the gutter, uniform across the page, capped by
 * the tightest element's headroom).
 */
export function gutterShiftFraction(
  frames: BookFrameSpec[] | undefined,
  overlays: BookOverlaySpec[] | undefined,
  gutterMm: number | undefined,
  canvasWidthMmValue: number | null,
  gutterSide: 'left' | 'right',
): number {
  if (!gutterMm || gutterMm <= 0) return 0;
  if (!canvasWidthMmValue || canvasWidthMmValue <= 0) return 0;

  const desired = (gutterMm / 2) / canvasWidthMmValue;
  const direction = gutterSide === 'left' ? 1 : -1;

  let headroom = 1;
  for (const f of frames || []) {
    const x = asFloat(f?.x);
    const w = asFloat(f?.width);
    if (x === null || w === null) continue;
    const room = direction > 0 ? 1 - (x + w) : x;
    headroom = Math.min(headroom, Math.max(0, room));
  }
  for (const o of overlays || []) {
    // Overlays use PERCENT coords (0-100), not 0..1 fractions.
    const xRaw = asFloat(o?.x);
    if (xRaw === null) continue;
    const x = xRaw / 100;
    const w = (asFloat(o?.width) ?? 0) / 100;
    const room = direction > 0 ? 1 - (x + w) : x;
    headroom = Math.min(headroom, Math.max(0, room));
  }

  return direction * Math.min(desired, headroom);
}

/**
 * Return `{ frames, overlays }` shifted away from the bound edge. Mirrors
 * `services/book_layout.py::apply_gutter` — shifts both the fractional
 * `x` and millimetre `xMm` representations so the engine (which reads the
 * fraction) and the ops authoring UI (which reads mm) never disagree.
 */
export function applyGutter(
  frames: BookFrameSpec[] | undefined,
  overlays: BookOverlaySpec[] | undefined,
  gutterMm: number | undefined,
  canvas: BookCanvasSpec | undefined,
  gutterSide: 'left' | 'right',
): { frames: BookFrameSpec[]; overlays: BookOverlaySpec[] } {
  const widthMm = canvasWidthMm(canvas);
  const dx = gutterShiftFraction(frames, overlays, gutterMm, widthMm, gutterSide);
  if (!dx) {
    return { frames: frames ? [...frames] : [], overlays: overlays ? [...overlays] : [] };
  }
  const dxMm = widthMm ? dx * widthMm : 0;

  const shiftedFrames = (frames || []).map(f => {
    const out: BookFrameSpec = { ...f };
    const x = asFloat(f?.x);
    if (x !== null) out.x = x + dx;
    const xMm = asFloat(f?.xMm);
    if (xMm !== null) out.xMm = xMm + dxMm;
    return out;
  });

  const shiftedOverlays = (overlays || []).map(o => {
    const out: BookOverlaySpec = { ...o };
    const x = asFloat(o?.x);
    if (x !== null) out.x = x + dx * 100;
    return out;
  });

  return { frames: shiftedFrames, overlays: shiftedOverlays };
}

// ─── Spine width (D4 / R2) ───────────────────────────────────────────────────

/**
 * Spine width for a book of `pageCount` printed SIDES — i.e.
 * `pageCount / 2` leaves. Mirrors `services/book_layout.py::spine_width_mm`.
 *
 * ⚠️ This is the "leaves, not sides" formula, which differs from the
 * `pageCount × paperThicknessMm` sketch in BOOK_LAYOUT_PRD.md §4 D4 (which
 * double-counts). Unconfirmed with Catalog Ops which convention their
 * paper-thickness spec actually uses — see the Python twin's docstring.
 */
export function spineWidthMm(
  pageCount: number,
  paperThicknessMm: number,
  coverThicknessMm = 0,
): number {
  if (pageCount <= 0 || paperThicknessMm <= 0) {
    return Math.max(0, 2 * coverThicknessMm);
  }
  return (pageCount / 2) * paperThicknessMm + 2 * coverThicknessMm;
}

// ─── Display labels (U6 — mechanical collation) ─────────────────────────────

/** Mirrors `services/book_layout.py::display_label_for`. */
export function displayLabelFor(
  role: BookRole,
  pageIndex: number | null,
  ordinal: number,
  total: number,
): string {
  const width = Math.max(2, String(Math.max(1, total)).length);
  const prefix = String(ordinal).padStart(width, '0');
  const roleLabel = _ROLE_LABEL[role];
  if (roleLabel) return `${prefix} ${roleLabel}`;
  const pageStr = String(pageIndex ?? 0).padStart(width, '0');
  return `${prefix} Page ${pageStr}`;
}

// ─── Spread grouping (D6) ────────────────────────────────────────────────────

/**
 * Group a flat page list into how the bound book reads, for the
 * customer's read-only spread preview. Mirrors
 * `services/book_layout.py::pages_to_spreads`. Purely a display concern —
 * the editor and the renderer both work the flat list.
 */
export function pagesToSpreads<T extends { role: BookRole; pageIndex?: number | null }>(
  pages: T[],
): T[][] {
  const coversFront = pages.filter(p => p.role === ROLE_COVER);
  const coversBack = pages.filter(p => p.role === ROLE_BACK_COVER);
  const inner = pages.filter(p => p.role === ROLE_INNER);

  const spreads: T[][] = coversFront.map(c => [c]);
  if (inner.length) {
    spreads.push([inner[0]]);
    const rest = inner.slice(1);
    for (let i = 0; i < rest.length; i += 2) {
      spreads.push(rest.slice(i, i + 2));
    }
  }
  coversBack.forEach(c => spreads.push([c]));
  return spreads;
}

// ─── Materialization (client-side mirror of §5.2) ───────────────────────────

/**
 * Expand a book template into concrete per-page entries, for the editor's
 * client-side preview/card-grid ahead of any server round-trip. Mirrors
 * `services/book_layout.py::materialize_pages` — same contract, same
 * override semantics. The SERVER remains the source of truth at render
 * time; this exists so the editor can build its page list without a
 * network call every time the customer changes the page count.
 */
export function materializePages(
  layout: BookLayoutLike,
  opts: { pageCount?: number | null; overrides?: BookLayoutLike['pageOverrides'] } = {},
): MaterializedPage[] {
  if (layout.productType !== 'book') {
    throw new Error("materializePages() requires productType === 'book'");
  }
  const book = layout.book;
  if (!book) {
    throw new Error('book layout has no `book` block');
  }

  const resolvedCount = resolvePageCount(layout, opts.pageCount);
  const gutterMm = book.gutterMm || 0;
  const defaultBleed = book.bleedMm;

  const mergedOverrides: NonNullable<BookLayoutLike['pageOverrides']> = {
    ...(layout.pageOverrides || {}),
    ...(opts.overrides || {}),
  };

  const plan: Array<[BookRole, number | null]> = [[ROLE_COVER, null]];
  for (let i = 1; i <= resolvedCount; i++) plan.push([ROLE_INNER, i]);
  plan.push([ROLE_BACK_COVER, null]);
  const total = plan.length;

  const spine = spineWidthMm(
    resolvedCount,
    book.paperThicknessMm || 0,
    book.coverThicknessMm || 0,
  );

  return plan.map(([role, pageIndex], i) => {
    const ordinal = i + 1;
    const template: BookRoleTemplate | undefined =
      role === ROLE_COVER ? book.cover
      : role === ROLE_BACK_COVER ? (book.backCover ?? { canvas: book.cover?.canvas, frames: [] })
      : book.innerPage;
    if (!template) {
      throw new Error(`book layout is missing the ${role} template`);
    }

    const canvas: BookCanvasSpec = { ...(template.canvas || {}) };
    if (defaultBleed !== undefined && canvas.bleedMm === undefined) {
      canvas.bleedMm = defaultBleed;
    }

    const key = role === ROLE_COVER ? 'cover'
      : role === ROLE_BACK_COVER ? 'back_cover'
      : `page_${String(pageIndex).padStart(2, '0')}`;

    const override = pageIndex !== null ? mergedOverrides[String(pageIndex)] : undefined;
    let frames = override?.frames ?? template.frames ?? [];
    let overlays = override?.overlays ?? template.overlays ?? [];

    const gutterSide = role === ROLE_INNER && pageIndex !== null ? gutterSideFor(pageIndex) : null;
    if (gutterSide) {
      const shifted = applyGutter(frames, overlays, gutterMm, canvas, gutterSide);
      frames = shifted.frames;
      overlays = shifted.overlays;
    }

    const page: MaterializedPage = {
      key,
      role,
      pageIndex,
      displayLabel: displayLabelFor(role, pageIndex, ordinal, total),
      gutterSide,
      canvas,
      frames,
      overlays,
      maskUrl: (template.maskUrl ?? layout.maskUrl) || null,
      maskOnExport: Boolean(template.maskOnExport ?? layout.maskOnExport ?? false),
      pageCount: resolvedCount,
    };
    if (role === ROLE_COVER || role === ROLE_BACK_COVER) {
      page.spineWidthMm = spine;
    }
    return page;
  });
}
