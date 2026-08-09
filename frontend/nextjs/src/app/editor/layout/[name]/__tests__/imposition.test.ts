import {
  MM_TO_IN,
  CROP_MARK_LEN_MM,
  canvasSpecToInches,
  computeImpositionLayout,
  cropMarkLengthsFor,
  cropMarkOffsetIn,
  resolveSheetSize,
} from '../imposition';
import type { ImpositionSettings, PlacedItem } from '../types';

const base: ImpositionSettings = {
  preset: 'a4',
  widthIn: 8.27,
  heightIn: 11.69,
  marginMm: 7,
  gutterMm: 5,
  orientation: 'portrait',
  cropMarksEnabled: true,
  cropMarkLenMm: CROP_MARK_LEN_MM,
};

/** N distinct 4x6 photo canvases (1200x1800 @ 300 dpi). */
const photos4x6 = (n: number) => Array.from({ length: n }, () => ({ wIn: 4, hIn: 6 }));

const totalPlaced = (r: { sheets: { items: unknown[] }[] }) =>
  r.sheets.reduce((acc, s) => acc + s.items.length, 0);

describe('resolveSheetSize', () => {
  it('returns preset dimensions in portrait', () => {
    expect(resolveSheetSize(base)).toEqual({ w: 8.27, h: 11.69 });
  });

  it('swaps the axes in landscape', () => {
    expect(resolveSheetSize({ ...base, orientation: 'landscape' })).toEqual({ w: 11.69, h: 8.27 });
  });

  it('uses the custom inch fields when preset is custom', () => {
    expect(resolveSheetSize({ ...base, preset: 'custom', widthIn: 10, heightIn: 20 }))
      .toEqual({ w: 10, h: 20 });
  });

  it('falls back to A4 for an unknown preset', () => {
    expect(resolveSheetSize({ ...base, preset: 'nope' as never })).toEqual({ w: 8.27, h: 11.69 });
  });
});

describe('canvasSpecToInches', () => {
  it('prefers explicit mm dimensions', () => {
    const got = canvasSpecToInches({ width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4 });
    expect(got!.wIn).toBeCloseTo(4, 6);
    expect(got!.hIn).toBeCloseTo(6, 6);
  });

  it("honours the layout's own dpi rather than assuming 300", () => {
    const got = canvasSpecToInches({ width: 1200, height: 1800, dpi: 150 });
    expect(got).toEqual({ wIn: 8, hIn: 12 });
  });

  it('assumes 300 dpi only when the layout states no dpi', () => {
    expect(canvasSpecToInches({ width: 1200, height: 1800 })).toEqual({ wIn: 4, hIn: 6 });
  });

  it('returns null rather than guessing when dimensions are missing', () => {
    expect(canvasSpecToInches({ width: 0, height: 0 })).toBeNull();
    expect(canvasSpecToInches(null)).toBeNull();
    expect(canvasSpecToInches(undefined)).toBeNull();
  });
});

describe('crop marks — per-side clamping', () => {
  const item = (x: number, y: number, w = 4, h = 6): PlacedItem =>
    ({ canvasIdx: 0, x, y, w, h, rotated: false });
  const A4 = { w: 8.27, h: 11.69 };
  const mm = (v: number) => v / MM_TO_IN;

  it('gives an edge facing the paper the full requested length', () => {
    const only = item(mm(20), mm(20));
    const L = cropMarkLengthsFor(only, [only], { ...base, cropMarkLenMm: 5, marginMm: 20 }, A4.w, A4.h);
    expect(L.left * MM_TO_IN).toBeCloseTo(5, 6);
    expect(L.top * MM_TO_IN).toBeCloseTo(5, 6);
  });

  it('halves the gutter for an edge facing another photo', () => {
    // 10 mm gutter -> 5 mm each side, minus the 2 mm offset = 3 mm.
    const a = item(mm(20), mm(20));
    const b = item(mm(20) + 4 + mm(10), mm(20));
    const L = cropMarkLengthsFor(a, [a, b], { ...base, cropMarkLenMm: 5, gutterMm: 10, marginMm: 20 }, A4.w, A4.h);
    expect(L.right * MM_TO_IN).toBeCloseTo(3, 6);
    expect(L.left * MM_TO_IN).toBeCloseTo(5, 6);   // outer side unaffected
  });

  it('reproduces the reported case: default gutter no longer kills every mark', () => {
    // gutter 5 / margin 6 previously shortened EVERY mark to 0.5 mm because the
    // sheet-wide minimum was applied to all four sides. Outer marks now use the
    // margin they actually have.
    const s = { ...base, gutterMm: 5, marginMm: 6, cropMarkLenMm: 5 };
    const a = item(mm(6), mm(6));
    const b = item(mm(6) + 4 + mm(5), mm(6));
    const L = cropMarkLengthsFor(a, [a, b], s, A4.w, A4.h);
    expect(L.right * MM_TO_IN).toBeCloseTo(0.5, 6);   // faces the neighbour
    expect(L.left * MM_TO_IN).toBeCloseTo(4, 6);      // faces the paper — usable
    expect(L.top * MM_TO_IN).toBeCloseTo(4, 6);
  });

  it('never lets a drawn mark cross into a neighbour', () => {
    for (const gutterMm of [0, 1, 3, 5, 8, 14, 30]) {
      const gap = mm(gutterMm);
      const a = item(mm(20), mm(20));
      const b = item(mm(20) + 4 + gap, mm(20));
      const L = cropMarkLengthsFor(a, [a, b], { ...base, gutterMm, cropMarkLenMm: 20, marginMm: 20 }, A4.w, A4.h);
      if (L.right === 0) continue;
      // offset + length must stay inside this item's half of the gutter
      expect(cropMarkOffsetIn() + L.right).toBeLessThanOrEqual(gap / 2 + 1e-12);
    }
  });

  it('never lets a drawn mark run off the sheet', () => {
    for (const marginMm of [0, 1, 3, 6, 20]) {
      const only = item(mm(marginMm), mm(marginMm));
      const L = cropMarkLengthsFor(only, [only], { ...base, marginMm, cropMarkLenMm: 20 }, A4.w, A4.h);
      if (L.left > 0) expect(cropMarkOffsetIn() + L.left).toBeLessThanOrEqual(mm(marginMm) + 1e-12);
      if (L.top > 0) expect(cropMarkOffsetIn() + L.top).toBeLessThanOrEqual(mm(marginMm) + 1e-12);
    }
  });

  it('suppresses a side with no room instead of drawing a negative mark', () => {
    const only = item(mm(1), mm(1));
    const L = cropMarkLengthsFor(only, [only], { ...base, marginMm: 1 }, A4.w, A4.h);
    expect(L.left).toBe(0);
    expect(L.top).toBe(0);
  });

  it('draws nothing at all when the operator switches marks off', () => {
    const only = item(mm(20), mm(20));
    const L = cropMarkLengthsFor(only, [only], { ...base, cropMarksEnabled: false, marginMm: 20 }, A4.w, A4.h);
    expect([L.left, L.right, L.top, L.bottom]).toEqual([0, 0, 0, 0]);
  });

  it('reports the spread of drawn lengths on the result', () => {
    // 4x6 on A4 at these settings fits one per sheet, so the right/bottom edges
    // face open paper and take the full 5 mm, while left/top are capped by the
    // 6 mm margin (6 - 2 offset = 4). The spread is the point: one sheet-wide
    // number could not express it.
    const r = computeImpositionLayout({ ...base, gutterMm: 5, marginMm: 6, cropMarkLenMm: 5 }, photos4x6(4));
    expect(r.cropMarks.minLenIn * MM_TO_IN).toBeCloseTo(4, 6);
    expect(r.cropMarks.maxLenIn * MM_TO_IN).toBeCloseTo(5, 6);
    expect(r.cropMarks.shortened).toBe(true);
  });

  it('reports no shortening when every mark gets its full length', () => {
    const r = computeImpositionLayout({ ...base, gutterMm: 30, marginMm: 20, cropMarkLenMm: 5 }, photos4x6(1));
    expect(r.cropMarks.shortened).toBe(false);
    expect(r.cropMarks.maxLenIn * MM_TO_IN).toBeCloseTo(5, 6);
  });

  it('reports zero-length marks when they are switched off', () => {
    const r = computeImpositionLayout({ ...base, cropMarksEnabled: false }, photos4x6(2));
    expect(r.cropMarks.disabled).toBe(true);
    expect(r.cropMarks.maxLenIn).toBe(0);
    expect(r.cropMarks.shortened).toBe(false);
  });
});


describe('orientation', () => {
  it('packs a landscape sheet using the swapped axes', () => {
    // 11.69 x 8.27 fits two 4x6 across; portrait A4 fits only one.
    const land = computeImpositionLayout(
      { ...base, orientation: 'landscape', marginMm: 0, gutterMm: 0 },
      [{ wIn: 4, hIn: 6 }],
    );
    expect(land.sheets[0].items).toHaveLength(2);
    const rows = new Set(land.sheets[0].items.map(i => i.y));
    expect(rows.size).toBe(1);
  });

  it('changes how many sheets a batch needs', () => {
    const portrait = computeImpositionLayout(base, photos4x6(4));
    const landscape = computeImpositionLayout({ ...base, orientation: 'landscape' }, photos4x6(4));
    expect(portrait.sheets.length).toBe(4);
    expect(landscape.sheets.length).toBe(2);
    // Either way, every canvas is printed exactly once.
    expect(portrait.placedPerCanvas).toEqual([1, 1, 1, 1]);
    expect(landscape.placedPerCanvas).toEqual([1, 1, 1, 1]);
  });

  it('swaps custom sheet dimensions too', () => {
    const s = { ...base, preset: 'custom' as const, widthIn: 10, heightIn: 20 };
    expect(resolveSheetSize(s)).toEqual({ w: 10, h: 20 });
    expect(resolveSheetSize({ ...s, orientation: 'landscape' })).toEqual({ w: 20, h: 10 });
  });
});

describe('computeImpositionLayout — gang run (single design)', () => {
  it('repeats one design to fill a single sheet', () => {
    const r = computeImpositionLayout({ ...base, marginMm: 0, gutterMm: 0 }, photos4x6(1));
    expect(r.mode).toBe('gang');
    expect(r.sheets).toHaveLength(1);
    // 8.27 x 11.69 fits 2 across (8.0) and 1 down (6.0); 12.0 exceeds 11.69.
    expect(totalPlaced(r)).toBe(2);
    expect(r.placedPerCanvas).toEqual([2]);
  });

  it('places every copy inside the safe area', () => {
    const r = computeImpositionLayout({ ...base, preset: '13x19' }, photos4x6(1));
    const m = base.marginMm / MM_TO_IN;
    for (const it of r.sheets[0].items) {
      expect(it.x).toBeGreaterThanOrEqual(m - 1e-9);
      expect(it.y).toBeGreaterThanOrEqual(m - 1e-9);
      expect(it.x + it.w).toBeLessThanOrEqual(13 - m + 1e-9);
      expect(it.y + it.h).toBeLessThanOrEqual(19 - m + 1e-9);
    }
  });

  it('never overlaps two copies', () => {
    const r = computeImpositionLayout({ ...base, preset: '13x19', gutterMm: 3 }, photos4x6(1));
    const items = r.sheets[0].items;
    expect(items.length).toBeGreaterThan(1);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const disjoint =
          a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9 ||
          a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('honours the gutter between copies', () => {
    const gutterMm = 6;
    const r = computeImpositionLayout({ ...base, preset: '13x19', gutterMm }, photos4x6(1));
    const row = r.sheets[0].items.filter(i => Math.abs(i.y - r.sheets[0].items[0].y) < 1e-9);
    expect(row.length).toBeGreaterThan(1);
    expect(row[1].x - (row[0].x + row[0].w)).toBeCloseTo(gutterMm / MM_TO_IN, 9);
  });

  it('does not lose a column to floating-point error on an exact fit', () => {
    // Two 4.135" items are exactly 8.27" — the sheet width, to the digit.
    const r = computeImpositionLayout(
      { ...base, marginMm: 0, gutterMm: 0 },
      [{ wIn: 8.27 / 2, hIn: 5 }],
    );
    expect(r.sheets[0].items.filter(i => i.y === 0)).toHaveLength(2);
  });

  it('rotates a design that only fits sideways', () => {
    // 10" wide fits only across an 11.69" landscape sheet.
    const r = computeImpositionLayout(
      { ...base, orientation: 'landscape', marginMm: 0, gutterMm: 0 },
      [{ wIn: 5, hIn: 10 }],
    );
    expect(r.sheets[0].items[0].rotated).toBe(true);
    expect(r.sheets[0].items[0].w).toBe(10);
    expect(r.sheets[0].items[0].h).toBe(5);
  });

  it('prefers the unrotated orientation when both fit', () => {
    const r = computeImpositionLayout({ ...base, marginMm: 0, gutterMm: 0 }, photos4x6(1));
    expect(r.sheets[0].items.every(i => i.rotated === false)).toBe(true);
  });
});

describe('computeImpositionLayout — batch (many distinct canvases)', () => {
  it('paginates instead of dropping everything past the first sheet', () => {
    const r = computeImpositionLayout(base, photos4x6(12));
    expect(r.mode).toBe('batch');
    expect(totalPlaced(r)).toBe(12);
    expect(r.sheets.length).toBeGreaterThan(1);
  });

  it('places every distinct canvas exactly once', () => {
    const r = computeImpositionLayout(base, photos4x6(12));
    expect(r.placedPerCanvas).toEqual(new Array(12).fill(1));
    expect(r.skippedCount).toBe(0);
  });

  it('keeps canvases in upload order across sheets', () => {
    const r = computeImpositionLayout(base, photos4x6(12));
    const order = r.sheets.flatMap(s => s.items.map(i => i.canvasIdx));
    expect(order).toEqual([...Array(12).keys()]);
  });

  it('never repeats a canvas to fill leftover space', () => {
    // 9 photos on a 13x19 leaves room, but printing extra copies would give
    // the customer an unequal number of each photo.
    const r = computeImpositionLayout({ ...base, preset: '13x19' }, photos4x6(9));
    expect(r.placedPerCanvas).toEqual(new Array(9).fill(1));
    expect(totalPlaced(r)).toBe(9);
  });

  it('mixes differently sized canvases without overlap', () => {
    const r = computeImpositionLayout({ ...base, preset: '13x19' }, [
      { wIn: 4, hIn: 6 }, { wIn: 2, hIn: 2 }, { wIn: 6, hIn: 4 }, { wIn: 3, hIn: 5 },
    ]);
    expect(totalPlaced(r)).toBe(4);
    const items = r.sheets.flatMap(s => s.items.map(i => ({ ...i, sheet: r.sheets.indexOf(s) })));
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.sheet !== b.sheet) continue;
        const disjoint =
          a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9 ||
          a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('reports canvases too large for the sheet instead of silently dropping them', () => {
    const r = computeImpositionLayout(base, [{ wIn: 4, hIn: 6 }, { wIn: 30, hIn: 40 }]);
    expect(r.skippedCount).toBe(1);
    expect(r.placedPerCanvas).toEqual([1, 0]);
    expect(totalPlaced(r)).toBe(1);
  });

  it('emits no sheets when every canvas is too large', () => {
    const r = computeImpositionLayout(base, [{ wIn: 30, hIn: 40 }, { wIn: 50, hIn: 60 }]);
    expect(r.sheets).toHaveLength(0);
    expect(r.skippedCount).toBe(2);
  });

  it('keeps a big canvas that only fits rotated', () => {
    const r = computeImpositionLayout(
      { ...base, marginMm: 0, gutterMm: 0 },
      [{ wIn: 11, hIn: 8 }, { wIn: 4, hIn: 6 }],
    );
    const rotated = r.sheets.flatMap(s => s.items).find(i => i.canvasIdx === 0);
    expect(rotated).toBeDefined();
    expect(rotated!.rotated).toBe(true);
  });
});

describe('computeImpositionLayout — degenerate settings', () => {
  it('flags an unusable sheet when the margins swallow it', () => {
    const r = computeImpositionLayout({ ...base, marginMm: 200 }, photos4x6(4));
    expect(r.noUsableArea).toBe(true);
    expect(r.sheets).toHaveLength(0);
    expect(r.skippedCount).toBe(4);
  });

  it('flags an unusable sheet when the margins exactly consume it', () => {
    const r = computeImpositionLayout(
      { ...base, preset: 'custom', widthIn: 4, heightIn: 4, marginMm: 2 * MM_TO_IN },
      photos4x6(1),
    );
    expect(r.noUsableArea).toBe(true);
  });

  it('returns an empty, non-skipping result for no canvases', () => {
    const r = computeImpositionLayout(base, []);
    expect(r.sheets).toHaveLength(0);
    expect(r.skippedCount).toBe(0);
    expect(r.placedPerCanvas).toEqual([]);
  });

  it('ignores canvases with a zero or negative dimension', () => {
    const r = computeImpositionLayout(base, [{ wIn: 4, hIn: 6 }, { wIn: 0, hIn: 5 }]);
    expect(r.skippedCount).toBe(1);
    expect(totalPlaced(r)).toBe(1);
  });

  it('terminates on a tiny design over a large sheet', () => {
    const r = computeImpositionLayout(
      { ...base, preset: 'custom', widthIn: 40, heightIn: 40, marginMm: 0, gutterMm: 0 },
      [{ wIn: 0.05, hIn: 0.05 }],
    );
    expect(r.sheets).toHaveLength(1);
    expect(totalPlaced(r)).toBeLessThanOrEqual(2000);
    expect(totalPlaced(r)).toBeGreaterThan(0);
  });

  it('paginates a large batch without losing a single canvas', () => {
    const r = computeImpositionLayout({ ...base, preset: '13x19' }, photos4x6(400));
    expect(totalPlaced(r)).toBe(400);
    expect(r.unplacedCount).toBe(0);
    expect(r.sheets.length).toBe(Math.ceil(400 / 9));
  });

  it('counts anything left unprinted, whatever the reason', () => {
    const r = computeImpositionLayout(base, [
      { wIn: 4, hIn: 6 }, { wIn: 99, hIn: 99 }, { wIn: 4, hIn: 6 },
    ]);
    expect(r.unplacedCount).toBe(1);
    expect(r.unplacedCount).toBe(r.placedPerCanvas.filter(c => c === 0).length);
  });
});
