import type { ImpositionSettings, SheetLayout } from './types';

export const MM_TO_IN = 25.4;

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

export function computeImpositionLayout(
  settings: ImpositionSettings,
  itemSizes: { wIn: number; hIn: number }[],
): { sheets: SheetLayout[]; skippedCount: number } {
  const marginIn = settings.marginMm / MM_TO_IN;
  const gutterIn = settings.gutterMm / MM_TO_IN;
  const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(settings);
  const safeW = sheetWIn - marginIn * 2;
  const safeH = sheetHIn - marginIn * 2;
  if (safeW <= 0 || safeH <= 0) return { sheets: [], skippedCount: itemSizes.length };

  const sheets: SheetLayout[] = [{ items: [] }];
  let curX = marginIn, curY = marginIn, rowMaxH = 0, skippedCount = 0;

  for (let i = 0; i < itemSizes.length; i++) {
    let w = itemSizes[i].wIn, h = itemSizes[i].hIn, rotated = false;
    const fitsNormal = w <= safeW && h <= safeH;
    const fitsRotated = h <= safeW && w <= safeH;
    if (!fitsNormal && fitsRotated) { [w, h] = [h, w]; rotated = true; }
    else if (!fitsNormal && !fitsRotated) { skippedCount++; continue; }

    if (curX + w > marginIn + safeW) { curX = marginIn; curY += rowMaxH + gutterIn; rowMaxH = 0; }
    if (curY + h > marginIn + safeH) { sheets.push({ items: [] }); curX = marginIn; curY = marginIn; rowMaxH = 0; }

    sheets[sheets.length - 1].items.push({ canvasIdx: i, x: curX, y: curY, w, h, rotated });
    curX += w + gutterIn;
    rowMaxH = Math.max(rowMaxH, h);
  }
  return { sheets, skippedCount };
}
