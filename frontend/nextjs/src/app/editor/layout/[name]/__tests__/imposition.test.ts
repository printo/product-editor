import {
  MM_TO_IN,
  CROP_MARK_LEN_MM,
  canvasSpecToInches,
  computeImpositionLayout,
  resolveCropMarkGeometry,
  resolveSheetSize,
} from '../imposition';
import type { ImpositionSettings } from '../types';

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

describe('resolveCropMarkGeometry', () => {
  it('shortens the mark so it cannot reach into a neighbouring photo', () => {
    // 5 mm gutter is shared by two neighbours -> 2.5 mm each, minus the 2 mm
    // offset leaves 0.5 mm of drawable mark.
    const g = resolveCropMarkGeometry(base);
    expect(g.lenIn).toBeCloseTo(0.5 / MM_TO_IN, 9);
    expect(g.shortened).toBe(true);
  });

  // The contract is "a DRAWN mark never crosses into a neighbour". When there
  // is no room the mark is suppressed (lenIn === 0) and the offset is moot —
  // renderers must skip drawing entirely in that case.
  it('never lets a drawn mark exceed half the gutter', () => {
    for (const gutterMm of [0, 1, 3, 5, 8, 14, 20, 40]) {
      const g = resolveCropMarkGeometry({ ...base, gutterMm, marginMm: 50 });
      if (g.lenIn === 0) continue;
      expect(g.offsetIn + g.lenIn).toBeLessThanOrEqual(gutterMm / 2 / MM_TO_IN + 1e-12);
    }
  });

  it('never lets a drawn mark exceed the margin', () => {
    for (const marginMm of [0, 1, 3, 7, 20]) {
      const g = resolveCropMarkGeometry({ ...base, marginMm, gutterMm: 100 });
      if (g.lenIn === 0) continue;
      expect(g.offsetIn + g.lenIn).toBeLessThanOrEqual(marginMm / MM_TO_IN + 1e-12);
    }
  });

  it('suppresses the mark when the gutter is too tight to hold even the offset', () => {
    // 3 mm gutter -> 1.5 mm per side, below the 2 mm offset.
    expect(resolveCropMarkGeometry({ ...base, gutterMm: 3, marginMm: 50 }).lenIn).toBe(0);
  });

  it('draws the full requested length when there is ample room', () => {
    const g = resolveCropMarkGeometry({ ...base, gutterMm: 30, marginMm: 20 });
    expect(g.lenIn).toBeCloseTo(CROP_MARK_LEN_MM / MM_TO_IN, 9);
    expect(g.shortened).toBe(false);
    expect(g.disabled).toBe(false);
  });

  it('suppresses the mark entirely when there is no room at all', () => {
    const g = resolveCropMarkGeometry({ ...base, gutterMm: 0, marginMm: 0 });
    expect(g.lenIn).toBe(0);
    expect(g.shortened).toBe(true);
    expect(g.disabled).toBe(false);
  });

  it('honours a longer operator-chosen length when the space allows', () => {
    const g = resolveCropMarkGeometry({ ...base, cropMarkLenMm: 12, gutterMm: 40, marginMm: 30 });
    expect(g.lenIn).toBeCloseTo(12 / MM_TO_IN, 9);
    expect(g.shortened).toBe(false);
  });

  it('treats the operator-chosen length as a maximum, not a guarantee', () => {
    // Asks for 12 mm but a 10 mm gutter only affords 5 mm per side, less the
    // 2 mm offset -> 3 mm.
    const g = resolveCropMarkGeometry({ ...base, cropMarkLenMm: 12, gutterMm: 10, marginMm: 30 });
    expect(g.lenIn).toBeCloseTo(3 / MM_TO_IN, 9);
    expect(g.shortened).toBe(true);
    expect(g.requestedLenIn).toBeCloseTo(12 / MM_TO_IN, 9);
  });

  it('draws nothing when the operator switches marks off', () => {
    const g = resolveCropMarkGeometry({ ...base, cropMarksEnabled: false, gutterMm: 40, marginMm: 30 });
    expect(g.lenIn).toBe(0);
    expect(g.disabled).toBe(true);
    // Not a space problem, so it must not be reported as shortened.
    expect(g.shortened).toBe(false);
  });

  it('never reports shortened for a shorter requested length that fits', () => {
    const g = resolveCropMarkGeometry({ ...base, cropMarkLenMm: 1, gutterMm: 30, marginMm: 20 });
    expect(g.lenIn).toBeCloseTo(1 / MM_TO_IN, 9);
    expect(g.shortened).toBe(false);
  });

  it('falls back to the default length for a non-finite input', () => {
    const g = resolveCropMarkGeometry({ ...base, cropMarkLenMm: NaN, gutterMm: 40, marginMm: 30 });
    expect(g.lenIn).toBeCloseTo(CROP_MARK_LEN_MM / MM_TO_IN, 9);
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
