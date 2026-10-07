import { act, renderHook } from '@testing-library/react';
import { useSubmitGuards } from '../useSubmitGuards';
import { collectLowDpiFrames, type LowDpiFrame } from '@/lib/dpi-utils';
import type { CanvasItem, SurfaceState } from '../types';

jest.mock('@/lib/dpi-utils', () => ({ collectLowDpiFrames: jest.fn() }));
const sweep = jest.mocked(collectLowDpiFrames);

const photo = new File(['x'], 'a.jpg');
const canvas = (withPhoto: boolean): CanvasItem =>
  ({ id: 0, frames: [{ id: 0, originalFile: withPhoto ? photo : null }], overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: null }) as unknown as CanvasItem;
const side = (key: string, withPhoto: boolean): SurfaceState =>
  ({ key, label: key.toUpperCase(), def: { canvas: {} }, files: [], canvases: [canvas(withPhoto)], globalFitMode: 'cover' }) as unknown as SurfaceState;
const low = (canvasIdx: number, dpi: number, surfaceKey: string | null = null): LowDpiFrame =>
  ({ canvasIdx, frameIdx: 0, surfaceKey, dpi, severity: dpi < 100 ? 'critical' : 'warn' });

type Props = Parameters<typeof useSubmitGuards>[0];
const base: Props = { layout: { canvas: {} }, surfaceStates: [], canvases: [canvas(true)], isBookProduct: false };

beforeEach(() => { jest.useFakeTimers(); sweep.mockReset(); });
afterEach(() => jest.useRealTimers());

describe('useSubmitGuards', () => {
  it('names the sides that would print blank', () => {
    const { result } = renderHook(() => useSubmitGuards({ ...base, surfaceStates: [side('front', true), side('back', false)] }));
    expect(result.current.emptySurfaces.map(s => s.key)).toEqual(['back']);
  });

  it('a book’s blank inner pages are fine; a blank cover is not', () => {
    const pages = [side('cover', false), side('page_01', false), side('page_02', true), side('back_cover', true)];
    const { result } = renderHook(() => useSubmitGuards({ ...base, isBookProduct: true, surfaceStates: pages }));
    expect(result.current.emptySurfaces.map(s => s.key)).toEqual(['cover']);
  });

  it('checks resolution 300 ms after the design settles, for the single-surface design', async () => {
    sweep.mockResolvedValue([low(0, 120)]);
    const { result } = renderHook(() => useSubmitGuards(base));
    await act(async () => { jest.advanceTimersByTime(299); });
    expect(sweep).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep.mock.calls[0][0]).toEqual([{ canvases: base.canvases, layoutDef: base.layout, surfaceKey: null }]);
    expect(result.current.lowDpiFrames).toEqual([low(0, 120)]);
  });

  it('checks each side of a multi-surface product with its own definition', async () => {
    sweep.mockResolvedValue([]);
    const sides = [side('front', true), side('back', true)];
    renderHook(() => useSubmitGuards({ ...base, surfaceStates: sides }));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(sweep.mock.calls[0][0]).toEqual(sides.map(s => ({ canvases: s.canvases, layoutDef: s.def, surfaceKey: s.key, surfaceLabel: s.label })));
  });

  it('a newer edit cancels the pending check, and a stale result never lands', async () => {
    let finishFirst!: (v: LowDpiFrame[]) => void;
    sweep.mockResolvedValue([low(0, 140)]).mockImplementationOnce(() => new Promise(r => { finishFirst = r; }));
    const { result, rerender } = renderHook((p: Props) => useSubmitGuards(p), { initialProps: base });
    await act(async () => { jest.advanceTimersByTime(300); });
    rerender({ ...base, canvases: [canvas(true)] });
    await act(async () => { jest.advanceTimersByTime(300); });
    await act(async () => { finishFirst([low(0, 50)]); });
    expect(result.current.lowDpiFrames).toEqual([low(0, 140)]);
    rerender({ ...base, canvases: [canvas(true), canvas(true)] });
    rerender({ ...base, canvases: [canvas(true)] });
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('does not check before the layout has loaded, and a failed check changes nothing', async () => {
    sweep.mockRejectedValue(new Error('decode failed'));
    const { result, rerender } = renderHook((p: Props) => useSubmitGuards(p), { initialProps: { ...base, layout: null } as Props });
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(sweep).not.toHaveBeenCalled();
    rerender(base);
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(result.current.lowDpiFrames).toEqual([]);
  });

  it('keeps the worst frame per card, for both grid kinds', async () => {
    sweep.mockResolvedValue([low(0, 140), low(0, 90), low(1, 130), low(0, 120, 'back')]);
    const { result } = renderHook(() => useSubmitGuards(base));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(Object.fromEntries([...result.current.lowDpiByCard].map(([k, f]) => [k, f.dpi])))
      .toEqual({ ':0': 90, ':1': 130, 'back:0': 120 });
  });
});
