import { act, renderHook, waitFor } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { useActiveSurfaceLayout, useLayoutLoader } from '../useLayoutLoader';
import type { SurfaceState } from '../types';

const LAYOUT_4X6 = {
  name: 'test_4x6', tags: ['Photo Prints'],
  canvas: { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4, dpi: 300 },
  frames: [{ id: 'f1', x: 0, y: 0, width: 1, height: 1, xMm: 0, yMm: 0, widthMm: 101.6, heightMm: 152.4 }],
};
const TWO_SIDED = {
  name: 'card', type: 'product',
  surfaces: [
    { key: 'front', label: 'Front', canvas: { width: 1000, height: 600, widthMm: 85, heightMm: 55 }, frames: [] },
    { key: 'back', label: 'Back', canvas: { width: 1000, height: 600, widthMm: 85, heightMm: 55 }, frames: [] },
  ],
};
const BOOK = {
  name: 'test_book', productType: 'book',
  book: {
    pageCount: { min: 4, max: 16, step: 4, default: 8 }, gutterMm: 10,
    cover: { canvas: { width: 1000, height: 800, widthMm: 210, heightMm: 168 }, frames: [{ id: 'c0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
    innerPage: { canvas: { width: 900, height: 700, widthMm: 190, heightMm: 148 }, frames: [{ id: 'p0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
  },
};

type Props = Parameters<typeof useLayoutLoader>[0];
let order: string[] = [];
const named = (name: string) => jest.fn(() => { order.push(name); });

function props(over: Partial<Props> = {}): Props {
  return {
    layoutName: 'test_4x6', embedToken: null, status: 'authenticated', apiBase: '/api/internal/proxy',
    getAuthHeaders: () => ({}), orderId: 'PE-LOCAL', setOrderId: named('setOrderId'), setSessionQty: jest.fn(),
    selectedFonts: [], setSelectedFonts: jest.fn(), loadGoogleFont: jest.fn(), setError: jest.fn(),
    setLayout: named('setLayout'), setLayoutLoading: jest.fn(), setNormalizedLayoutState: jest.fn(),
    setSurfaceStates: jest.fn(), setActiveSurfaceKey: jest.fn(), setBookPageCount: jest.fn(), setBookHiddenPages: jest.fn(),
    ...over,
  };
}
function serve(body: unknown, status = 200) {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  return global.fetch as jest.Mock;
}
const loaded = (p: Props) => waitFor(() => expect(p.setLayoutLoading).toHaveBeenLastCalledWith(false));

beforeEach(() => { order = []; window.history.replaceState(null, '', '/editor/layout/test_4x6'); });

describe('useLayoutLoader', () => {
  it('dashboard: waits for the sign-in before asking for the layout', async () => {
    const fetchMock = serve({ layout: LAYOUT_4X6 });
    const p = props({ status: 'loading' });
    const { rerender } = renderHook((q: Props) => useLayoutLoader(q), { initialProps: p });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ ...p, status: 'authenticated' });
    await loaded(p);
    expect(fetchMock).toHaveBeenCalledWith('/api/internal/proxy/editor/init?layout=test_4x6', { headers: { Accept: 'application/json' } });
  });

  it('asks for only the sides named in ?surfaces=, through the embed proxy with the token', async () => {
    window.history.replaceState(null, '', '/editor/layout/card?surfaces=back');
    const fetchMock = serve({ layout: TWO_SIDED, order_id: null });
    const p = props({ layoutName: 'card', embedToken: 'tok', status: 'loading', apiBase: '/api/embed/proxy', getAuthHeaders: () => ({ 'X-Embed-Token': 'tok' }) });
    renderHook(() => useLayoutLoader(p));
    await loaded(p);
    expect(fetchMock).toHaveBeenCalledWith('/api/embed/proxy/editor/init?layout=card&surfaces=back',
      { headers: { 'X-Embed-Token': 'tok', Accept: 'application/json' } });
    expect((p.setSurfaceStates as jest.Mock).mock.calls[0][0].map((s: SurfaceState) => s.key)).toEqual(['back']);
    expect(p.setActiveSurfaceKey).toHaveBeenCalledWith('back');
  });

  it('seeds the page from the layout', async () => {
    serve({ layout: LAYOUT_4X6, fonts: ['Inter', 'Lobster'] });
    const p = props();
    renderHook(() => useLayoutLoader(p));
    await loaded(p);
    expect(p.setLayoutLoading).toHaveBeenCalledWith(true);
    expect(p.setSelectedFonts).toHaveBeenCalledWith(['Inter', 'Lobster']);
    const surfaces = (p.setSurfaceStates as jest.Mock).mock.calls[0][0] as SurfaceState[];
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ files: [], canvases: [], globalFitMode: 'contain' });
    expect(p.setActiveSurfaceKey).toHaveBeenCalledWith(surfaces[0].key);
    expect(p.setNormalizedLayoutState).toHaveBeenCalledWith(expect.objectContaining({ name: 'test_4x6' }));
    expect((p.setLayout as jest.Mock).mock.calls[0][0]).toMatchObject({
      name: 'test_4x6', productType: null, dimensions: '101.60x152.40mm', height: 1800,
      canvas: LAYOUT_4X6.canvas, tags: ['Photo Prints'], weekStart: 'sunday', holidayLocale: null, calendarDefaultYear: 'current',
    });
    expect(p.setError).not.toHaveBeenCalled();
    expect(p.setOrderId).not.toHaveBeenCalled();
  });

  it('embed: adopts the session order id before the layout is set, remembering the old id', async () => {
    serve({ layout: LAYOUT_4X6, order_id: 'EXT-SESSION' });
    const p = props({ embedToken: 'tok' });
    const { result } = renderHook(() => useLayoutLoader(p));
    await loaded(p);
    expect(p.setOrderId).toHaveBeenCalledWith('EXT-SESSION');
    expect(order).toEqual(['setOrderId', 'setLayout']);
    expect(result.current.legacyOrderIdRef.current).toBe('PE-LOCAL');
  });

  it('keeps its own order id on the dashboard, and when the session id is the same', async () => {
    serve({ layout: LAYOUT_4X6, order_id: 'EXT-SESSION' });
    const p = props();
    const { result } = renderHook(() => useLayoutLoader(p));
    await loaded(p);
    serve({ layout: LAYOUT_4X6, order_id: 'PE-LOCAL' });
    const q = props({ embedToken: 'tok' });
    renderHook(() => useLayoutLoader(q));
    await loaded(q);
    expect(p.setOrderId).not.toHaveBeenCalled();
    expect(q.setOrderId).not.toHaveBeenCalled();
    expect(result.current.legacyOrderIdRef.current).toBeNull();
  });

  it.each([[12, 12], [0, null], [2.5, null], ['12', null], [null, null]])('session quantity %p → adopted: %p (null = not adopted)', async (qty, adopted) => {
    serve({ layout: LAYOUT_4X6, qty });
    const p = props();
    renderHook(() => useLayoutLoader(p));
    await loaded(p);
    if (adopted === null) expect(p.setSessionQty).not.toHaveBeenCalled();
    else expect(p.setSessionQty).toHaveBeenCalledWith(adopted);
  });

  it('a book starts at its template page count, with no hidden pages', async () => {
    serve({ layout: BOOK });
    const p = props({ layoutName: 'test_book' });
    renderHook(() => useLayoutLoader(p));
    await loaded(p);
    expect(p.setBookPageCount).toHaveBeenCalledWith(8);
    expect(p.setBookHiddenPages).toHaveBeenCalledWith({});
    const keys = (p.setSurfaceStates as jest.Mock).mock.calls[0][0].map((s: SurfaceState) => s.key);
    expect(keys[0]).toBe('cover');
    expect(keys.at(-1)).toBe('back_cover');
    expect(keys).toHaveLength(10);
    expect((p.setLayout as jest.Mock).mock.calls[0][0].productType).toBe('book');
  });

  it.each([[404, 'Layout not found.'], [500, 'Failed to load layout.']])('a %p says %p', async (status, message) => {
    serve({}, status);
    const p = props();
    renderHook(() => useLayoutLoader(p));
    await loaded(p);
    expect(p.setError).toHaveBeenCalledWith(message);
    expect(p.setLayout).not.toHaveBeenCalled();
  });

  it('a network failure says so too, and still stops loading', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const p = props();
    renderHook(() => useLayoutLoader(p));
    await loaded(p);
    expect(p.setError).toHaveBeenCalledWith('Failed to load layout.');
  });

  it('loads every selected font', () => {
    serve({ layout: LAYOUT_4X6 });
    const p = props({ status: 'loading', selectedFonts: ['Inter', 'Lobster'] });
    renderHook(() => useLayoutLoader(p));
    expect((p.loadGoogleFont as jest.Mock).mock.calls).toEqual([['Inter'], ['Lobster']]);
  });
});

describe('useActiveSurfaceLayout', () => {
  const back = { key: 'back', label: 'Back', def: { canvas: { width: 600, height: 400, widthMm: 50.8, heightMm: 33.87 }, frames: [{ id: 'b' }], maskUrl: 'm.png', maskOnExport: true } } as unknown as SurfaceState;
  const applied = (setLayout: jest.Mock, prev: unknown) => {
    const arg = setLayout.mock.calls.at(-1)[0] as SetStateAction<unknown>;
    return typeof arg === 'function' ? (arg as (p: unknown) => unknown)(prev) : arg;
  };

  it('puts the active side’s canvas, frames, mask and size on the layout', () => {
    const setLayout = jest.fn();
    renderHook(() => useActiveSurfaceLayout({ activeSurfaceKey: 'back', activeSurface: back, normalizedLayoutState: {} as never, setLayout }));
    expect(applied(setLayout, { name: 'card', dimensions: 'old' })).toEqual({
      name: 'card', canvas: back.def.canvas, frames: back.def.frames, maskUrl: 'm.png', maskOnExport: true, dimensions: '50.80x33.87mm',
    });
    expect(applied(setLayout, null)).toBeNull();
  });

  it('waits for the layout, and follows a switch of side', () => {
    const setLayout = jest.fn();
    const { rerender } = renderHook((p: Parameters<typeof useActiveSurfaceLayout>[0]) => useActiveSurfaceLayout(p),
      { initialProps: { activeSurfaceKey: 'back', activeSurface: back, normalizedLayoutState: null, setLayout } });
    expect(setLayout).not.toHaveBeenCalled();
    rerender({ activeSurfaceKey: 'back', activeSurface: back, normalizedLayoutState: {} as never, setLayout });
    expect(setLayout).toHaveBeenCalledTimes(1);
    act(() => rerender({ activeSurfaceKey: 'front', activeSurface: { ...back, key: 'front' }, normalizedLayoutState: {} as never, setLayout }));
    expect(setLayout).toHaveBeenCalledTimes(2);
  });
});
