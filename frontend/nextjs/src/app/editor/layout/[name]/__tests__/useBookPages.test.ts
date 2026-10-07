import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useBookPages } from '../useBookPages';
import { reconcilePageCount } from '../book-pages';
import { spineWidthMm, type BookLayoutLike } from '@/lib/book-layout';
import type { NormalizedLayout } from '@/lib/layout-utils';
import type { CanvasItem, SurfaceState } from '../types';

const BOOK = {
  name: 'test_book', productType: 'book',
  book: {
    pageCount: { min: 4, max: 16, step: 4, default: 8 }, gutterMm: 10, paperThicknessMm: 0.1, coverThicknessMm: 2,
    cover: { canvas: { width: 1000, height: 800, widthMm: 210, heightMm: 168 }, frames: [{ id: 'c0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
    innerPage: { canvas: { width: 900, height: 700, dpi: 300 }, frames: [{ id: 'p0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
  },
} as unknown as BookLayoutLike;
const normalized = { _raw: BOOK } as unknown as NormalizedLayout;
const withThumb = (s: SurfaceState, dataUrl: string): SurfaceState =>
  ({ ...s, canvases: [{ id: 0, frames: [], overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl } as CanvasItem] });

/** The page's surfaces, owned the way the page owns them, around the hook. */
function setup(layout: { productType?: string | null } | null = { productType: 'book' }, norm: NormalizedLayout | null = normalized) {
  const initial = reconcilePageCount(BOOK, undefined, [], {}).visible;
  return renderHook(() => {
    const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>(initial);
    const surfaceStatesRef = { current: surfaceStates };
    const book = useBookPages({ layout, normalizedLayoutState: norm, surfaceStates, surfaceStatesRef, setSurfaceStates });
    return { ...book, surfaceStates, setSurfaceStates };
  });
}
const keys = (s: SurfaceState[]) => s.map(x => x.key);

describe('useBookPages', () => {
  it('starts with no page count, nothing held back and no prompt', () => {
    const { result } = setup();
    expect(result.current.isBookProduct).toBe(true);
    expect(result.current).toMatchObject({ bookPageCount: 0, bookHiddenPages: {}, pendingBookOverflow: null, showSpreadPreview: false });
    expect(result.current.bookOverflowDecidedRef.current).toBe(false);
  });

  it('is inert for a product that is not a book', () => {
    const { result } = setup({ productType: 'photo' });
    expect(result.current.isBookProduct).toBe(false);
    expect(result.current.bookPageBounds).toBeNull();
    expect(result.current.bookSpreads).toEqual([]);
    expect(result.current.bookCoverPreview).toBeNull();
    expect(result.current.bookSpineWidthMm).toBeNull();
  });

  it('offers the template page grid once the layout has loaded', () => {
    expect(setup().result.current.bookPageBounds).toEqual([4, 16, 4, 8]);
    expect(setup(undefined, null).result.current.bookPageBounds).toBeNull();
  });

  it('a page-count change goes through reconcilePageCount: pages shrunk away are held, and come back', () => {
    const { result } = setup();
    const page8 = result.current.surfaceStates.find(s => s.key === 'page_08')!;
    act(() => result.current.setSurfaceStates(prev => prev.map(s => (s.key === 'page_08' ? withThumb(s, 'data:p8') : s))));
    act(() => result.current.handleBookPageCountChange(4));
    expect(result.current.bookPageCount).toBe(4);
    expect(keys(result.current.surfaceStates)).toEqual(['cover', 'page_01', 'page_02', 'page_03', 'page_04', 'back_cover']);
    expect(Object.keys(result.current.bookHiddenPages)).toEqual(expect.arrayContaining(['page_08']));
    expect(result.current.bookHiddenPagesRef.current).toBe(result.current.bookHiddenPages);
    act(() => result.current.handleBookPageCountChange(8));
    expect(result.current.bookPageCount).toBe(8);
    const back = result.current.surfaceStates.find(s => s.key === 'page_08')!;
    expect(back.canvases[0].dataUrl).toBe('data:p8');
    expect(back.key).toBe(page8.key);
  });

  it('a count off the grid snaps up, never down', () => {
    const { result } = setup();
    act(() => result.current.handleBookPageCountChange(9));
    expect(result.current.bookPageCount).toBe(12);
  });

  it('does nothing before the layout has loaded', () => {
    const { result } = setup(undefined, null);
    const before = result.current.surfaceStates;
    act(() => result.current.handleBookPageCountChange(12));
    expect(result.current.surfaceStates).toBe(before);
    expect(result.current.bookPageCount).toBe(0);
  });

  it('previews the visible pages as spreads, with the covers apart for the cover wrap', () => {
    const { result } = setup();
    act(() => result.current.setSurfaceStates(prev => prev.map(s => withThumb(s, `data:${s.key}`))));
    expect(result.current.bookCoverPreview).toMatchObject({ key: 'cover', dataUrl: 'data:cover', canvasWidth: 1000, canvasHeight: 800, canvasWidthMm: 210 });
    expect(result.current.bookBackCoverPreview).toMatchObject({ key: 'back_cover', dataUrl: 'data:back_cover' });
    const spreadKeys = result.current.bookSpreads.map(sp => sp.map(p => p.key));
    expect(spreadKeys.flat()).not.toContain('cover');
    expect(spreadKeys.flat()).not.toContain('back_cover');
    expect(spreadKeys.flat()).toEqual(['page_01', 'page_02', 'page_03', 'page_04', 'page_05', 'page_06', 'page_07', 'page_08']);
    // Inner pages give a pixel width and a dpi, so their width is converted to mm.
    expect(result.current.bookSpreads[0][0].canvasWidthMm).toBeCloseTo((900 / 300) * 25.4);
  });

  it('works the spine width out from the current page count', () => {
    const { result } = setup();
    act(() => result.current.handleBookPageCountChange(12));
    expect(result.current.bookSpineWidthMm).toBe(spineWidthMm(12, 0.1, 2));
  });

  it('holds the "more photos than pages" prompt until it is decided', () => {
    const { result } = setup();
    const overflow = { files: [new File(['x'], 'a.jpg')], currentCapacity: 8, suggestedCount: 12 };
    act(() => result.current.setPendingBookOverflow(overflow));
    expect(result.current.pendingBookOverflow).toBe(overflow);
  });
});
