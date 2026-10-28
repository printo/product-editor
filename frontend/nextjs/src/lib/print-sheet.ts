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
  return printSheetMode(raw) === 'bleed' ? 'Bleed area' : 'Whole canvas';
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

// ── Window box: the size a layout template is keyed on ─────────────────────
//
// A template is bound to the box around a layout's photo windows as the
// layout stores them (each already grown by its bleed): the bleed area when
// there is a bleed, the print area when there is none. Two layouts share
// templates when that box is the same size to the millimetre, whatever the
// canvas around it. Twin of `services/print_sheet.py` (window_box_mm,
// print_area_box_mm, box_key), pinned by
// storage/parity-fixtures/template-window-box.json. The keys themselves are
// computed and compared on the server; the client needs the box to place a
// template's artwork on another canvas (layout-template.ts).

/** A stored window plus its bleed, as a layout definition carries it. */
export interface StoredWindow extends WindowFraction {
  bleedMm?: number | string;
}

export interface CanvasMm {
  widthMm?: number | string;
  heightMm?: number | string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

function frameRectsMm(canvas: CanvasMm, windows: StoredWindow[], insetBleed: boolean): Array<[number, number, number, number]> {
  const wMm = num(canvas.widthMm);
  const hMm = num(canvas.heightMm);
  if (wMm <= 0 || hMm <= 0) return [];
  const rects: Array<[number, number, number, number]> = [];
  for (const f of windows) {
    let left = num(f.x) * wMm;
    let top = num(f.y) * hMm;
    let width = num(f.width) * wMm;
    let height = num(f.height) * hMm;
    if (insetBleed) {
      const b = Math.max(0, num(f.bleedMm));
      if (b > 0 && width - 2 * b > 0 && height - 2 * b > 0) {
        left += b; top += b; width -= 2 * b; height -= 2 * b;
      }
    }
    // Clamped to the canvas, as the print is.
    const right = Math.min(wMm, left + width);
    const bottom = Math.min(hMm, top + height);
    left = Math.max(0, left);
    top = Math.max(0, top);
    if (right - left <= 0 || bottom - top <= 0) continue;
    rects.push([left, top, right, bottom]);
  }
  return rects;
}

function boxOf(rects: Array<[number, number, number, number]>): MmRect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map(r => r[0]));
  const top = Math.min(...rects.map(r => r[1]));
  const right = Math.max(...rects.map(r => r[2]));
  const bottom = Math.max(...rects.map(r => r[3]));
  return { xMm: round2(left), yMm: round2(top), widthMm: round2(right - left), heightMm: round2(bottom - top) };
}

/** The box around the windows as stored (bleed included), in mm; null without windows or millimetres. */
export function windowBoxMm(canvas: CanvasMm, windows: StoredWindow[]): MmRect | null {
  return boxOf(frameRectsMm(canvas, windows, false));
}

/** The box around the visible windows (each inset by its bleed), in mm. */
export function printAreaBoxMm(canvas: CanvasMm, windows: StoredWindow[]): MmRect | null {
  return boxOf(frameRectsMm(canvas, windows, true));
}

/** `'117x168'`: a box's size rounded to the millimetre. */
export function boxKey(box: MmRect | null | undefined): string | null {
  if (!box) return null;
  return `${Math.round(num(box.widthMm))}x${Math.round(num(box.heightMm))}`;
}

/** `'117 × 168 mm'` for the ops pages, which call the windows "print areas". */
export function boxLabel(box: MmRect | null | undefined): string {
  if (!box) return 'no print areas';
  return `${Math.round(num(box.widthMm))} × ${Math.round(num(box.heightMm))} mm`;
}
