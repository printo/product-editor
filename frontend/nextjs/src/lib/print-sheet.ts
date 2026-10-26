/**
 * The print sheet: what part of a layout's canvas the print file is.
 *
 * `printSheet` on a layout (or on each surface of a multi-surface product):
 *   { mode: 'canvas' }                      the whole canvas, as always
 *   { mode: 'bleed' }                       the bleed area from the photo windows:
 *                                           the box around every window grown by its bleed
 *   { mode: 'bleed', xMm, yMm, widthMm,     a typed bleed area: the visible rectangle
 *     heightMm, bleedMm }                   grown by bleedMm on every side
 *
 * The print itself is cut by the server (`services/print_sheet.py`); this
 * module only reads the setting and works out the rectangles the ops editor
 * and the layout cards draw. `bleed` is never a default.
 */

export type PrintSheetMode = 'canvas' | 'bleed';
export type PrintSheetSource = 'windows' | 'typed';

export interface PrintSheet {
  mode: PrintSheetMode;
  xMm?: number;
  yMm?: number;
  widthMm?: number;
  heightMm?: number;
  bleedMm?: number;
}

export interface MmRect { xMm: number; yMm: number; widthMm: number; heightMm: number }
export interface TypedSheet extends MmRect { bleedMm: number }
export interface PxRect { x: number; y: number; width: number; height: number }

/** A photo window as the ops editor holds it: the visible rectangle in mm and its bleed. */
export interface WindowMm {
  xMm?: number | string;
  yMm?: number | string;
  widthMm?: number | string;
  heightMm?: number | string;
  bleedMm?: number | string;
}

/** A photo window as a layout stores it: fractions of the canvas, already grown by the bleed. */
export interface WindowFraction {
  x: number;
  y: number;
  width: number;
  height: number;
  bleedMm?: number | string;
}

export interface CanvasSize {
  width: number;
  height: number;
  widthMm?: number;
  heightMm?: number;
  dpi?: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The typed visible rectangle and bleed, or null when the sheet has no rectangle. */
export function typedSheet(raw: unknown): TypedSheet | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isNum(s.xMm) || !isNum(s.yMm) || !isNum(s.widthMm) || !isNum(s.heightMm)) return null;
  return { xMm: s.xMm, yMm: s.yMm, widthMm: s.widthMm, heightMm: s.heightMm, bleedMm: isNum(s.bleedMm) ? s.bleedMm : 0 };
}

export function printSheetMode(raw: unknown): PrintSheetMode {
  return raw && typeof raw === 'object' && (raw as Record<string, unknown>).mode === 'bleed' ? 'bleed' : 'canvas';
}

/** `typed` when the bleed area was typed, `windows` when it comes from the photo windows. */
export function printSheetSource(raw: unknown): PrintSheetSource {
  return typedSheet(raw) ? 'typed' : 'windows';
}

/** A clean sheet from whatever a layout carries; `canvas` when absent or unreadable. */
export function readPrintSheet(raw: unknown): PrintSheet {
  if (printSheetMode(raw) !== 'bleed') return { mode: 'canvas' };
  const typed = typedSheet(raw);
  return typed ? { mode: 'bleed', ...typed } : { mode: 'bleed' };
}

/** What a layout stores for the ops editor's choice. */
export function printSheetToJson(mode: PrintSheetMode, source: PrintSheetSource, typed: TypedSheet): PrintSheet {
  if (mode !== 'bleed') return { mode: 'canvas' };
  if (source !== 'typed') return { mode: 'bleed' };
  return { mode: 'bleed', ...typed };
}

export function printSheetLabel(raw: unknown): string {
  if (printSheetMode(raw) !== 'bleed') return 'Whole canvas';
  return typedSheet(raw) ? 'Bleed area (typed)' : 'Bleed area (from the photo windows)';
}

export function growMm(rect: MmRect, bleedMm: number): MmRect {
  return {
    xMm: rect.xMm - bleedMm, yMm: rect.yMm - bleedMm,
    widthMm: rect.widthMm + 2 * bleedMm, heightMm: rect.heightMm + 2 * bleedMm,
  };
}

function unionMm(rects: MmRect[]): MmRect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map(r => r.xMm));
  const top = Math.min(...rects.map(r => r.yMm));
  const right = Math.max(...rects.map(r => r.xMm + r.widthMm));
  const bottom = Math.max(...rects.map(r => r.yMm + r.heightMm));
  return { xMm: left, yMm: top, widthMm: right - left, heightMm: bottom - top };
}

const windowMm = (w: WindowMm): MmRect => ({ xMm: num(w.xMm), yMm: num(w.yMm), widthMm: num(w.widthMm), heightMm: num(w.heightMm) });

/** The box around every window's visible rectangle. */
export function windowsVisibleAreaMm(windows: WindowMm[]): MmRect | null {
  return unionMm(windows.map(windowMm));
}

/** The box around every window grown by its own bleed: the bleed area "from the photo windows". */
export function windowsBleedAreaMm(windows: WindowMm[]): MmRect | null {
  return unionMm(windows.map(w => growMm(windowMm(w), num(w.bleedMm))));
}

/**
 * The visible and bleed rectangles the print sheet covers, in mm, for drawing
 * in the ops editor. Null when the layout prints the whole canvas or nothing
 * can be worked out (bleed from windows with no windows).
 */
export function printSheetAreasMm(raw: unknown, windows: WindowMm[]): { visible: MmRect; bleed: MmRect } | null {
  if (printSheetMode(raw) !== 'bleed') return null;
  const typed = typedSheet(raw);
  if (typed) {
    const { bleedMm, ...visible } = typed;
    return { visible, bleed: growMm(visible, bleedMm) };
  }
  const visible = windowsVisibleAreaMm(windows);
  const bleed = windowsBleedAreaMm(windows);
  return visible && bleed ? { visible, bleed } : null;
}

const round = (v: number) => Math.round(v);

/**
 * The same two rectangles in canvas pixels, from a stored layout (fraction
 * windows that already include their bleed), for the layout cards.
 */
export function printSheetAreasPx(raw: unknown, canvas: CanvasSize, windows: WindowFraction[]): { visible: PxRect; bleed: PxRect } | null {
  if (printSheetMode(raw) !== 'bleed') return null;
  const ppmX = canvas.widthMm ? canvas.width / canvas.widthMm : (canvas.dpi || 300) / 25.4;
  const ppmY = canvas.heightMm ? canvas.height / canvas.heightMm : (canvas.dpi || 300) / 25.4;
  const typed = typedSheet(raw);
  if (typed) {
    const b = typed.bleedMm;
    const toPx = (r: MmRect): PxRect => ({
      x: round(r.xMm * ppmX), y: round(r.yMm * ppmY),
      width: round((r.xMm + r.widthMm) * ppmX) - round(r.xMm * ppmX),
      height: round((r.yMm + r.heightMm) * ppmY) - round(r.yMm * ppmY),
    });
    const { bleedMm: _b, ...visible } = typed;
    return { visible: toPx(visible), bleed: toPx(growMm(visible, b)) };
  }
  if (!windows.length) return null;
  const bleedRects = windows.map(w => ({
    x: round(w.x * canvas.width), y: round(w.y * canvas.height),
    width: round(w.width * canvas.width), height: round(w.height * canvas.height),
  }));
  const visibleRects = windows.map((w, i) => {
    const bx = round(num(w.bleedMm) * ppmX);
    const by = round(num(w.bleedMm) * ppmY);
    const r = bleedRects[i];
    return { x: r.x + bx, y: r.y + by, width: Math.max(0, r.width - 2 * bx), height: Math.max(0, r.height - 2 * by) };
  });
  const union = (rects: PxRect[]): PxRect => {
    const left = Math.min(...rects.map(r => r.x));
    const top = Math.min(...rects.map(r => r.y));
    const right = Math.max(...rects.map(r => r.x + r.width));
    const bottom = Math.max(...rects.map(r => r.y + r.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  return { visible: union(visibleRects), bleed: union(bleedRects) };
}
