import type { ImpositionSettings, SheetLayout, PlacedItem } from './types';
import type { CanvasSpec } from '@/lib/layout-utils';

export const MM_TO_IN = 25.4;

/** Crop marks sit this far outside the trim edge before they start drawing. */
export const CROP_MARK_OFFSET_MM = 2;
/** Default crop-mark length. The operator can change it in the modal; it is
 *  still clamped down automatically when space is tight. */
export const CROP_MARK_LEN_MM = 5;
/** Bounds for the crop-mark length input. */
export const CROP_MARK_LEN_MIN_MM = 1;
export const CROP_MARK_LEN_MAX_MM = 20;

/** Backstop so a tiny item on a huge sheet can't spin forever. */
const MAX_ITEMS_PER_SHEET = 2000;
/** Runaway backstop on pagination. Set far above any real job — the editor
 *  caps canvases long before this — so it never silently truncates a batch. */
const MAX_SHEETS = 500;

/** Inch tolerance for fit comparisons — without it an exact 2-up fit is
 *  rejected by float error and a whole column is silently lost. */
const EPS = 1e-9;

const PRESET_DIMENSIONS: Record<string, { w: number; h: number }> = {
  a4: { w: 8.27, h: 11.69 },
  a3: { w: 11.69, h: 16.54 },
  '12x18': { w: 12, h: 18 },
  '13x19': { w: 13, h: 19 },
};

export function resolveSheetSize(s: ImpositionSettings) {
  const base = s.preset === 'custom'
    ? { w: s.widthIn, h: s.heightIn }
    : PRESET_DIMENSIONS[s.preset] || PRESET_DIMENSIONS.a4;
  return s.orientation === 'landscape' ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
}

export interface ItemSize { wIn: number; hIn: number }

/**
 * Physical size of one canvas, in inches.
 *
 * Prefers the layout's explicit mm dimensions — they are the physical truth.
 * Falls back to pixels ÷ the layout's own dpi. Returns null when the layout
 * carries no usable dimensions at all: imposition must NOT guess a size, since
 * a wrong guess prints at the wrong scale without any visible symptom.
 */
export function canvasSpecToInches(spec: CanvasSpec | null | undefined): ItemSize | null {
  if (!spec) return null;
  if (spec.widthMm && spec.heightMm && spec.widthMm > 0 && spec.heightMm > 0) {
    return { wIn: spec.widthMm / MM_TO_IN, hIn: spec.heightMm / MM_TO_IN };
  }
  const dpi = spec.dpi && spec.dpi > 0 ? spec.dpi : 300;
  if (spec.width > 0 && spec.height > 0) {
    return { wIn: spec.width / dpi, hIn: spec.height / dpi };
  }
  return null;
}

export interface CropMarkGeometry {
  /** Gap between the trim edge and the start of the mark, in inches. */
  offsetIn: number;
  /** Length the operator asked for, in inches. */
  requestedLenIn: number;
  /** Shortest mark actually drawn anywhere on the sheets, in inches. */
  minLenIn: number;
  /** Longest mark actually drawn anywhere on the sheets, in inches. */
  maxLenIn: number;
  /** True when at least one mark had to be trimmed below the request. */
  shortened: boolean;
  /** True when the operator switched marks off — not a space problem. */
  disabled: boolean;
}

/** Drawn mark length per side of one placed item, in inches. */
export interface ItemMarkLengths { left: number; right: number; top: number; bottom: number }

/**
 * Crop marks are drawn OUTWARD from each corner of a placed item, so they
 * live in the gutter (between items) and in the margin (at the sheet edge).
 * At a 5 mm gutter a full-length 7 mm mark reaches 2 mm INTO the neighbouring
 * photo and prints a black line across it. So the operator's requested length
 * is treated as a MAXIMUM and clamped to the room actually available: marks can
 * never touch artwork or run off the sheet at any gutter/margin combination.
 */
export function cropMarkOffsetIn(): number {
  return CROP_MARK_OFFSET_MM / MM_TO_IN;
}

function requestedMarkLenIn(settings: ImpositionSettings): number {
  const mm = Number.isFinite(settings.cropMarkLenMm)
    ? Math.max(0, settings.cropMarkLenMm)
    : CROP_MARK_LEN_MM;
  return mm / MM_TO_IN;
}

/**
 * Free space beyond one edge of an item, in inches.
 *
 * An edge either faces the paper (all of it is available — the marks live in
 * trim waste) or faces another item across the gutter, in which case the two
 * neighbours share that gap and each may use half.
 */
function sideRoomIn(
  item: PlacedItem,
  items: PlacedItem[],
  side: 'left' | 'right' | 'top' | 'bottom',
  sheetWIn: number,
  sheetHIn: number,
): number {
  const horizontal = side === 'left' || side === 'right';
  // An item is only an obstacle if it actually overlaps on the other axis.
  const overlaps = (o: PlacedItem) => horizontal
    ? o.y + o.h > item.y + EPS && o.y < item.y + item.h - EPS
    : o.x + o.w > item.x + EPS && o.x < item.x + item.w - EPS;

  let gapToNeighbour = Infinity;
  for (const o of items) {
    if (o === item || !overlaps(o)) continue;
    let gap = Infinity;
    if (side === 'left'   && o.x + o.w <= item.x + EPS)                 gap = item.x - (o.x + o.w);
    if (side === 'right'  && o.x >= item.x + item.w - EPS)              gap = o.x - (item.x + item.w);
    if (side === 'top'    && o.y + o.h <= item.y + EPS)                 gap = item.y - (o.y + o.h);
    if (side === 'bottom' && o.y >= item.y + item.h - EPS)              gap = o.y - (item.y + item.h);
    if (gap < gapToNeighbour) gapToNeighbour = gap;
  }
  if (gapToNeighbour !== Infinity) return gapToNeighbour / 2;

  // No neighbour — the run to the paper edge is entirely ours.
  switch (side) {
    case 'left':   return item.x;
    case 'top':    return item.y;
    case 'right':  return sheetWIn - (item.x + item.w);
    case 'bottom': return sheetHIn - (item.y + item.h);
  }
}

/**
 * Mark length for each side of one item.
 *
 * Clamped PER SIDE rather than once for the whole sheet. The earlier version
 * took `min(gutter/2, margin)` and applied it to all four sides of every item,
 * so the tightest gap anywhere shortened every mark on the sheet. At the
 * default 5 mm gutter that produced 0.5 mm marks — 6 px at 300 DPI, present
 * but impossible to find on the printed sheet, which is what an operator
 * reported. An edge facing the paper has the full run to the sheet edge
 * available and no neighbour to bleed onto, so it gets a usable mark; only the
 * edges that genuinely face another photo stay short.
 */
export function cropMarkLengthsFor(
  item: PlacedItem,
  items: PlacedItem[],
  settings: ImpositionSettings,
  sheetWIn: number,
  sheetHIn: number,
): ItemMarkLengths {
  if (settings.cropMarksEnabled === false) return { left: 0, right: 0, top: 0, bottom: 0 };
  const offsetIn = cropMarkOffsetIn();
  const requested = requestedMarkLenIn(settings);
  const forSide = (side: 'left' | 'right' | 'top' | 'bottom') => {
    const available = sideRoomIn(item, items, side, sheetWIn, sheetHIn) - offsetIn;
    return available <= 0 ? 0 : Math.min(requested, available);
  };
  return { left: forSide('left'), right: forSide('right'), top: forSide('top'), bottom: forSide('bottom') };
}

/** Offset + requested length + on/off. Per-side lengths come from cropMarkLengthsFor. */
export function resolveCropMarkGeometry(settings: ImpositionSettings): Omit<CropMarkGeometry, 'minLenIn' | 'maxLenIn' | 'shortened'> {
  return {
    offsetIn: cropMarkOffsetIn(),
    requestedLenIn: requestedMarkLenIn(settings),
    disabled: settings.cropMarksEnabled === false,
  };
}

/** 'gang' repeats a single design to fill the sheet; 'batch' places each
 *  distinct canvas exactly once, paginating across as many sheets as needed. */
export type ImpositionMode = 'gang' | 'batch';

export interface ImpositionResult {
  sheets: SheetLayout[];
  /** Inputs that cannot fit the sheet at any rotation, even alone. */
  skippedCount: number;
  /** Inputs that got zero copies for ANY reason — too large, or truncated by
   *  the pagination backstop. This is the number the UI must warn on: it is
   *  exactly how many photos would go missing from the print. */
  unplacedCount: number;
  /** Copies placed, per input index. Lets the UI prove nothing was lost. */
  placedPerCanvas: number[];
  mode: ImpositionMode;
  cropMarks: CropMarkGeometry;
  /** Set when margins consume the whole sheet, so nothing can be placed. */
  noUsableArea: boolean;
}

function emptyResult(
  itemCount: number,
  mode: ImpositionMode,
  cropMarks: Omit<CropMarkGeometry, 'minLenIn' | 'maxLenIn' | 'shortened'>,
  opts: { noUsableArea?: boolean; skippedCount?: number } = {},
): ImpositionResult {
  return {
    sheets: [],
    skippedCount: opts.skippedCount ?? itemCount,
    unplacedCount: itemCount,
    placedPerCanvas: new Array(itemCount).fill(0),
    mode,
    cropMarks: { ...cropMarks, minLenIn: 0, maxLenIn: 0, shortened: false },
    noUsableArea: opts.noUsableArea ?? false,
  };
}

/**
 * Shelf-pack canvases onto print sheets.
 *
 * Two modes, chosen from the input rather than from a setting:
 *  - one distinct canvas  → gang run: repeat it to fill a single sheet.
 *  - many distinct canvases → batch: place each exactly once and paginate.
 *
 * Repeating in batch mode would print an unequal number of copies per photo,
 * which is never what a print order wants; the previous implementation did
 * that AND then dropped everything past the first sheet.
 */
export function computeImpositionLayout(
  settings: ImpositionSettings,
  itemSizes: ItemSize[],
): ImpositionResult {
  const cropMarks = resolveCropMarkGeometry(settings);
  const mode: ImpositionMode = itemSizes.length === 1 ? 'gang' : 'batch';

  if (itemSizes.length === 0) return emptyResult(0, mode, cropMarks, { skippedCount: 0 });

  const marginIn = settings.marginMm / MM_TO_IN;
  const gutterIn = settings.gutterMm / MM_TO_IN;
  const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(settings);
  const safeW = sheetWIn - marginIn * 2;
  const safeH = sheetHIn - marginIn * 2;

  if (!(safeW > EPS) || !(safeH > EPS)) {
    return emptyResult(itemSizes.length, mode, cropMarks, { noUsableArea: true });
  }

  // Orientation for each input, or null when it can never fit. Unrotated wins
  // when both fit, so the operator gets a predictable, un-surprising sheet.
  const oriented = itemSizes.map((s) => {
    if (!(s.wIn > 0) || !(s.hIn > 0)) return null;
    if (s.wIn <= safeW + EPS && s.hIn <= safeH + EPS) {
      return { w: s.wIn, h: s.hIn, rotated: false };
    }
    if (s.hIn <= safeW + EPS && s.wIn <= safeH + EPS) {
      return { w: s.hIn, h: s.wIn, rotated: true };
    }
    return null;
  });

  const skippedCount = oriented.filter((o) => o === null).length;
  const placedPerCanvas = new Array(itemSizes.length).fill(0);
  const sheets: SheetLayout[] = [];

  let items: PlacedItem[] = [];
  let curX = marginIn;
  let curY = marginIn;
  let rowMaxH = 0;

  const flushSheet = () => {
    if (items.length) sheets.push({ items });
    items = [];
    curX = marginIn;
    curY = marginIn;
    rowMaxH = 0;
  };

  /** Place one item on the current sheet, or report the sheet is full. */
  const tryPlace = (canvasIdx: number, w: number, h: number, rotated: boolean): boolean => {
    // Wrap to the next row when the item would cross the right safe edge.
    // The `curX > marginIn` guard keeps a full-width item from wrapping
    // forever on an empty row.
    if (curX > marginIn + EPS && curX + w > marginIn + safeW + EPS) {
      curX = marginIn;
      curY += rowMaxH + gutterIn;
      rowMaxH = 0;
    }
    if (curY + h > marginIn + safeH + EPS) return false;
    items.push({ canvasIdx, x: curX, y: curY, w, h, rotated });
    curX += w + gutterIn;
    rowMaxH = Math.max(rowMaxH, h);
    return true;
  };

  if (mode === 'gang') {
    const o = oriented[0];
    if (!o) return emptyResult(1, mode, cropMarks, { skippedCount: 1 });
    while (items.length < MAX_ITEMS_PER_SHEET && tryPlace(0, o.w, o.h, o.rotated)) {
      placedPerCanvas[0]++;
    }
    flushSheet();
  } else {
    for (let i = 0; i < oriented.length; i++) {
      const o = oriented[i];
      if (!o) continue;
      if (!tryPlace(i, o.w, o.h, o.rotated)) {
        flushSheet();
        if (sheets.length >= MAX_SHEETS) break;
        // Guaranteed to succeed: `oriented` already proved h <= safeH.
        if (!tryPlace(i, o.w, o.h, o.rotated)) continue;
      }
      placedPerCanvas[i]++;
    }
    flushSheet();
  }

  // Summarise the marks actually drawn, so the UI can say what the operator
  // will see rather than quoting a single sheet-wide number.
  let minLenIn = Infinity;
  let maxLenIn = 0;
  if (!cropMarks.disabled) {
    for (const sheet of sheets) {
      for (const it of sheet.items) {
        const L = cropMarkLengthsFor(it, sheet.items, settings, sheetWIn, sheetHIn);
        for (const v of [L.left, L.right, L.top, L.bottom]) {
          if (v < minLenIn) minLenIn = v;
          if (v > maxLenIn) maxLenIn = v;
        }
      }
    }
  }
  if (!Number.isFinite(minLenIn)) minLenIn = 0;

  return {
    sheets,
    skippedCount,
    unplacedCount: placedPerCanvas.filter((c) => c === 0).length,
    placedPerCanvas,
    mode,
    cropMarks: {
      ...cropMarks,
      minLenIn,
      maxLenIn,
      shortened: !cropMarks.disabled && minLenIn < cropMarks.requestedLenIn - EPS,
    },
    noUsableArea: false,
  };
}
