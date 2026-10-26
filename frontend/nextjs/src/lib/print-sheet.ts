/**
 * The print sheet: what part of a layout's canvas the print file is.
 *
 * `printSheet` on a layout (or on each surface of a multi-surface product):
 *   { mode: 'canvas' }   the whole canvas, as always
 *   { mode: 'bleed' }    the bleed area from the photo windows: the box around
 *                        every window grown by its bleed, so the print follows
 *                        the windows wherever ops move them
 *
 * Nothing is ever typed: what prints is exactly what the customer's windows
 * show. The print itself is cut by the server (`services/print_sheet.py`);
 * this module only reads the setting and works out the rectangle the ops
 * editor and the layout cards draw. `bleed` is never a default.
 */

export type PrintSheetMode = 'canvas' | 'bleed';

export interface PrintSheet {
  mode: PrintSheetMode;
}

export interface MmRect { xMm: number; yMm: number; widthMm: number; heightMm: number }
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
}

export interface CanvasSize {
  width: number;
  height: number;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function printSheetMode(raw: unknown): PrintSheetMode {
  return raw && typeof raw === 'object' && (raw as Record<string, unknown>).mode === 'bleed' ? 'bleed' : 'canvas';
}

/** A clean sheet from whatever a layout carries; `canvas` when absent or unreadable. */
export function readPrintSheet(raw: unknown): PrintSheet {
  return { mode: printSheetMode(raw) };
}

export function printSheetLabel(raw: unknown): string {
  return printSheetMode(raw) === 'bleed' ? 'Print areas only' : 'Whole canvas';
}

/** The box around every window grown by its own bleed: the bleed area from the photo windows. */
export function windowsBleedAreaMm(windows: WindowMm[]): MmRect | null {
  if (!windows.length) return null;
  const rects = windows.map(w => {
    const b = num(w.bleedMm);
    return { xMm: num(w.xMm) - b, yMm: num(w.yMm) - b, widthMm: num(w.widthMm) + 2 * b, heightMm: num(w.heightMm) + 2 * b };
  });
  const left = Math.min(...rects.map(r => r.xMm));
  const top = Math.min(...rects.map(r => r.yMm));
  const right = Math.max(...rects.map(r => r.xMm + r.widthMm));
  const bottom = Math.max(...rects.map(r => r.yMm + r.heightMm));
  return { xMm: left, yMm: top, widthMm: right - left, heightMm: bottom - top };
}

/**
 * The rectangle the print covers, in mm, for the ops editor's live preview.
 * Null when the layout prints the whole canvas or there are no windows.
 */
export function printSheetAreaMm(raw: unknown, windows: WindowMm[]): MmRect | null {
  if (printSheetMode(raw) !== 'bleed') return null;
  return windowsBleedAreaMm(windows);
}

/**
 * The same rectangle in canvas pixels, from a stored layout (fraction windows
 * that already include their bleed), for the layout cards. Rounded the way
 * the engine rounds frames.
 */
export function printSheetAreaPx(raw: unknown, canvas: CanvasSize, windows: WindowFraction[]): PxRect | null {
  if (printSheetMode(raw) !== 'bleed' || !windows.length) return null;
  const rects = windows.map(w => ({
    x: Math.round(w.x * canvas.width), y: Math.round(w.y * canvas.height),
    width: Math.round(w.width * canvas.width), height: Math.round(w.height * canvas.height),
  }));
  const left = Math.min(...rects.map(r => r.x));
  const top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width));
  const bottom = Math.max(...rects.map(r => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
