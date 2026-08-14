/**
 * Unit tests for lib/book-layout.ts — everything not already covered by
 * book-layout.parity.test.ts (materialization, spread grouping, gutter
 * mechanics). See BOOK_LAYOUT_PRD.md §5.
 */
import {
  applyGutter,
  materializePages,
  pagesToSpreads,
  ROLE_BACK_COVER,
  ROLE_COVER,
  ROLE_INNER,
  type BookLayoutLike,
} from '@/lib/book-layout';

function bookLayout(overrides: Partial<BookLayoutLike['book']> = {}): BookLayoutLike {
  return {
    productType: 'book',
    book: {
      bleedMm: 3,
      gutterMm: 12,
      pageCount: { min: 20, max: 60, step: 4, default: 24 },
      paperThicknessMm: 0.12,
      cover: {
        canvas: { width: 3579, height: 2551, widthMm: 303, heightMm: 216 },
        frames: [{ id: 'c0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
      },
      innerPage: {
        canvas: { width: 3508, height: 2480, widthMm: 297, heightMm: 210 },
        frames: [{ id: 'p0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
      },
      backCover: {
        canvas: { width: 3579, height: 2551, widthMm: 303, heightMm: 216 },
        frames: [],
      },
      ...overrides,
    },
  };
}

describe('materializePages', () => {
  it('produces cover + N inner pages + back cover, in physical order', () => {
    const pages = materializePages(bookLayout(), { pageCount: 24 });
    expect(pages).toHaveLength(26);
    expect(pages[0].role).toBe(ROLE_COVER);
    expect(pages[pages.length - 1].role).toBe(ROLE_BACK_COVER);
    expect(pages.slice(1, -1).every(p => p.role === ROLE_INNER)).toBe(true);
  });

  it('page indices are 1-based and ordered', () => {
    const pages = materializePages(bookLayout(), { pageCount: 20 });
    const inner = pages.filter(p => p.role === ROLE_INNER);
    expect(inner.map(p => p.pageIndex)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('covers carry no pageIndex', () => {
    const pages = materializePages(bookLayout(), { pageCount: 20 });
    expect(pages[0].pageIndex).toBeNull();
    expect(pages[pages.length - 1].pageIndex).toBeNull();
  });

  it('per-role canvas can differ (D7)', () => {
    const pages = materializePages(bookLayout(), { pageCount: 20 });
    expect(pages[0].canvas.widthMm).toBe(303);
    expect(pages[1].canvas.widthMm).toBe(297);
  });

  it('changing page count never renumbers or misidentifies covers', () => {
    const small = materializePages(bookLayout(), { pageCount: 20 });
    const large = materializePages(bookLayout(), { pageCount: 40 });
    expect(small[0].role).toBe(large[0].role);
    expect(small[small.length - 1].role).toBe(large[large.length - 1].role);
  });

  it('gutter mirrors by page parity', () => {
    // pageCount 4 clamps up to the template min (20) — only the leading
    // parity pattern is asserted, not the resolved count.
    const pages = materializePages(bookLayout(), { pageCount: 4 });
    const inner = pages.filter(p => p.role === ROLE_INNER);
    expect(inner.slice(0, 4).map(p => p.gutterSide)).toEqual(['left', 'right', 'left', 'right']);
  });

  it('covers have no gutter side', () => {
    const pages = materializePages(bookLayout(), { pageCount: 20 });
    expect(pages[0].gutterSide).toBeNull();
    expect(pages[pages.length - 1].gutterSide).toBeNull();
  });

  it('collage inner pages (>1 frame) keep their frame count through materialization', () => {
    const layout = bookLayout();
    layout.book!.innerPage.frames = [
      { id: 'left', x: 0.02, y: 0.05, width: 0.46, height: 0.9 },
      { id: 'right', x: 0.52, y: 0.05, width: 0.46, height: 0.9 },
    ];
    const pages = materializePages(layout, { pageCount: 20 });
    const inner = pages.filter(p => p.role === ROLE_INNER);
    expect(inner.every(p => p.frames.length === 2)).toBe(true);
  });

  it('spine width lands on covers only', () => {
    const pages = materializePages(bookLayout(), { pageCount: 24 });
    expect(pages[0].spineWidthMm).toBeCloseTo(12 * 0.12, 9);
    expect(pages[pages.length - 1].spineWidthMm).toBeCloseTo(12 * 0.12, 9);
    expect(pages[1].spineWidthMm).toBeUndefined();
  });

  it('back cover falls back to the front cover canvas when omitted', () => {
    const layout = bookLayout();
    delete layout.book!.backCover;
    const pages = materializePages(layout, { pageCount: 4 });
    expect(pages[pages.length - 1].canvas.widthMm).toBe(pages[0].canvas.widthMm);
  });

  it('page overrides reposition without changing frame count', () => {
    const layout = bookLayout();
    layout.pageOverrides = {
      '2': { frames: [{ id: 'p0', x: 0.1, y: 0.1, width: 0.8, height: 0.8 }] },
    };
    const pages = materializePages(layout, { pageCount: 4 });
    const page2 = pages.find(p => p.pageIndex === 2)!;
    expect(page2.frames[0].x).not.toBe(layout.book!.innerPage.frames![0].x);
  });

  it('throws for a non-book layout', () => {
    expect(() => materializePages({ productType: 'calendar' })).toThrow();
  });

  it('throws when the book block is missing', () => {
    expect(() => materializePages({ productType: 'book' })).toThrow();
  });
});

describe('pagesToSpreads', () => {
  it('groups facing pages, page 1 and trailing verso alone', () => {
    const pages = [
      { role: ROLE_COVER },
      { role: ROLE_INNER, pageIndex: 1 },
      { role: ROLE_INNER, pageIndex: 2 },
      { role: ROLE_INNER, pageIndex: 3 },
      { role: ROLE_INNER, pageIndex: 4 },
      { role: ROLE_BACK_COVER },
    ];
    const spreads = pagesToSpreads(pages);
    expect(spreads.map(s => s.length)).toEqual([1, 1, 2, 1, 1]);
  });
});

describe('applyGutter', () => {
  it('shifts both x and xMm together', () => {
    const frames = [{ x: 0.05, xMm: 15, width: 0.9 }];
    const { frames: shifted } = applyGutter(frames, [], 12, { widthMm: 297 }, 'left');
    expect(shifted[0].x).toBeGreaterThan(frames[0].x);
    expect(shifted[0].xMm).toBeGreaterThan(frames[0].xMm!);
  });

  it('moves a tight collage frame and a loose one by the SAME amount', () => {
    const frames = [
      { x: 0.02, width: 0.46 },
      { x: 0.52, width: 0.46 }, // only 0.02 headroom on the right
    ];
    const { frames: shifted } = applyGutter(frames, [], 40, { widthMm: 297 }, 'left');
    const dx0 = shifted[0].x! - frames[0].x;
    const dx1 = shifted[1].x! - frames[1].x;
    expect(Math.abs(dx0 - dx1)).toBeLessThan(1e-9);
  });

  it('is a no-op when gutter is zero', () => {
    const frames = [{ x: 0.05, width: 0.9 }];
    const { frames: shifted } = applyGutter(frames, [], 0, { widthMm: 297 }, 'left');
    expect(shifted[0].x).toBe(frames[0].x);
  });
});
