// Millimetre <-> pixel conversion at a given DPI. Unrounded: callers that work
// in whole pixels or fixed decimals round the result themselves. Kept free of
// imports so light components can use it without pulling in fabric.

export function mmToPx(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * 25.4;
}

export type LengthUnit = 'mm' | 'in';

// Layouts are stored in millimetres; inches are a display unit only. Inches
// show at 3 decimals (0.001 in ≈ 0.025 mm, finer than the 2-dp mm we save).
export function mmToUnit(mm: number, unit: LengthUnit): number {
  if (unit === 'mm') return mm;
  return Math.round((mm / 25.4) * 1000) / 1000;
}

export function unitToMm(value: number, unit: LengthUnit): number {
  return unit === 'mm' ? value : value * 25.4;
}
