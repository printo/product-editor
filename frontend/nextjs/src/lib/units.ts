// Millimetre <-> pixel conversion at a given DPI. Unrounded: callers that work
// in whole pixels or fixed decimals round the result themselves. Kept free of
// imports so light components can use it without pulling in fabric.

export function mmToPx(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * 25.4;
}
