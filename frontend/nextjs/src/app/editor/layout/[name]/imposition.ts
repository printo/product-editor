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
  let itemIdx = 0;
  let consecutiveSkips = 0;

  // Loop until we can't fit any more items, with a generous safety limit.
  while (itemIdx < 1000) {
    const canvasIdx = itemIdx % itemSizes.length;
    let w = itemSizes[canvasIdx].wIn, h = itemSizes[canvasIdx].hIn, rotated = false;
    
    const fitsNormal = w <= safeW && h <= safeH;
    const fitsRotated = h <= safeW && w <= safeH;

    if (!fitsNormal && !fitsRotated) {
      skippedCount++;
      consecutiveSkips++;
      // If we've tried every item and none fit, we're done.
      if (consecutiveSkips >= itemSizes.length) {
        break;
      }
      itemIdx++;
      continue;
    }
    
    // Reset consecutive skips since we found a placeable item.
    consecutiveSkips = 0;

    // Simple rotation strategy: if it doesn't fit normally, rotate if that works.
    if (!fitsNormal && fitsRotated) {
      [w, h] = [h, w];
      rotated = true;
    }

    // Move to the next row if the item doesn't fit horizontally.
    if (curX + w > marginIn + safeW) {
      curX = marginIn;
      curY += rowMaxH + gutterIn;
      rowMaxH = 0;
    }

    // Move to a new sheet if the item doesn't fit vertically.
    if (curY + h > marginIn + safeH) {
      // If the item doesn't even fit at the top of a new row, the sheet is full.
      // We break here to stop filling this sheet.
      // A more complex implementation could start a new sheet.
      break;
    }

    sheets[sheets.length - 1].items.push({ canvasIdx, x: curX, y: curY, w, h, rotated });
    curX += w + gutterIn;
    rowMaxH = Math.max(rowMaxH, h);
    itemIdx++;
  }
  return { sheets, skippedCount };
}
