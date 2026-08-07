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
  /** Drawn length of the mark, in inches. 0 means nothing is drawn. */
  lenIn: number;
  /** Length the operator asked for, in inches. */
  requestedLenIn: number;
  /** True when the mark had to be trimmed below the requested length to fit. */
  shortened: boolean;
  /** True when the operator switched marks off — not a space problem. */
  disabled: boolean;
}

/**
 * Crop marks are drawn OUTWARD from each corner of a placed item, so they
 * live in the gutter (between items) and in the margin (at the sheet edge).
 * At a 5 mm gutter a full-length 7 mm mark reaches 2 mm INTO the neighbouring
 * photo and prints a black line across it. So the operator's requested length
 * is treated as a MAXIMUM and clamped to the room actually available: marks can
 * never touch artwork or run off the sheet at any gutter/margin combination.
 */
export function resolveCropMarkGeometry(settings: ImpositionSettings): CropMarkGeometry {
  const offsetIn = CROP_MARK_OFFSET_MM / MM_TO_IN;
  const requestedMm = Number.isFinite(settings.cropMarkLenMm)
    ? Math.max(0, settings.cropMarkLenMm)
    : CROP_MARK_LEN_MM;
  const requestedLenIn = requestedMm / MM_TO_IN;

  if (settings.cropMarksEnabled === false) {
    return { offsetIn, lenIn: 0, requestedLenIn, shortened: false, disabled: true };
  }
  // Marks must fit in the tightest space they can land in. The gutter is
  // shared by two neighbours, so each side may only use half of it.
  const roomIn = Math.min(settings.gutterMm / 2, settings.marginMm) / MM_TO_IN;
  const availableIn = roomIn - offsetIn;
  if (availableIn <= 0) {
    return { offsetIn, lenIn: 0, requestedLenIn, shortened: true, disabled: false };
  }
  const lenIn = Math.min(requestedLenIn, availableIn);
  return {
    offsetIn,
    lenIn,
    requestedLenIn,
    shortened: lenIn < requestedLenIn - EPS,
    disabled: false,
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
  cropMarks: CropMarkGeometry,
  opts: { noUsableArea?: boolean; skippedCount?: number } = {},
): ImpositionResult {
  return {
    sheets: [],
    skippedCount: opts.skippedCount ?? itemCount,
    unplacedCount: itemCount,
    placedPerCanvas: new Array(itemCount).fill(0),
    mode,
    cropMarks,
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

  return {
    sheets,
    skippedCount,
    unplacedCount: placedPerCanvas.filter((c) => c === 0).length,
    placedPerCanvas,
    mode,
    cropMarks,
    noUsableArea: false,
  };
}
