import { act, renderHook } from '@testing-library/react';
import { usePanGesture } from '../usePanGesture';
import { getImageMetadata } from '@/lib/image-utils';
import type { CanvasItem, FrameState, SurfaceState } from '../types';

jest.mock('@/lib/image-utils', () => ({ getImageMetadata: jest.fn(async () => ({ width: 3000, height: 4000 })) }));

// 1200×1800 canvas shown in a 120×180 card: 10 canvas px per screen px. A
// 3000×4000 photo covering it scales by 0.45 to 1350×1800, so it can pan
// 75 px either way horizontally and not at all vertically.
const LAYOUT = { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] };
const frame = (over: Partial<FrameState> = {}): FrameState =>
  ({ id: 0, originalFile: new File(['x'], 'a.jpg'), offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover', ...over }) as FrameState;
const canvas = (frames = [frame()]): CanvasItem => ({ id: 0, frames, overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: null });

function host() {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 180 } as DOMRect);
  return el;
}
const pointer = (el: HTMLElement, x: number, y: number, over: Record<string, unknown> = {}) =>
  ({ button: 0, pointerId: 1, clientX: x, clientY: y, currentTarget: el, preventDefault: jest.fn(), stopPropagation: jest.fn(), ...over }) as unknown as React.PointerEvent<HTMLDivElement>;

type Props = Parameters<typeof usePanGesture>[0];
function setup(over: Partial<Props> = {}) {
  const updateCanvasState = jest.fn(async () => undefined);
  const props: Props = { repositionMode: true, surfaceStates: [], canvases: [canvas()], layout: LAYOUT, updateCanvasState, ...over };
  return { ...renderHook(() => usePanGesture(props)), updateCanvasState: props.updateCanvasState as jest.Mock };
}
/** The offset each committed update would give frame `i`. */
const offsets = (update: jest.Mock, i = 0) =>
  update.mock.calls.map(([, , fn]) => (fn(canvas([frame(), frame()])) as CanvasItem).frames[i].offset);
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 0; });
});
afterEach(() => jest.restoreAllMocks());

describe('usePanGesture', () => {
  it('drags the photo within its frame, one update per frame, and lands the final position', async () => {
    const { result, updateCanvasState } = setup();
    const el = host();
    await act(async () => { await result.current.handlePanStart(pointer(el, 60, 90), 0); });
    act(() => result.current.handlePanMove(pointer(el, 65, 90)));
    await act(settle);
    expect(updateCanvasState.mock.calls[0].slice(0, 2)).toEqual([0, null]);
    expect(offsets(updateCanvasState)).toEqual([{ x: 50, y: 0 }]);
    act(() => result.current.handlePanMove(pointer(el, 90, 120)));
    await act(settle);
    // Clamped to the pan room: 75 across, none down.
    expect(offsets(updateCanvasState).at(-1)).toEqual({ x: 75, y: 0 });
    act(() => result.current.handlePanEnd(pointer(el, 52, 90)));
    await act(settle);
    expect(offsets(updateCanvasState).at(-1)).toEqual({ x: -75, y: 0 });
    expect(result.current.panSuppressClickRef.current).toBe(true);
  });

  // Every move commits, even a tiny one; what a tap must not do is swallow
  // the click that opens the editor.
  it('a tap that barely moves still opens the editor', async () => {
    const { result, updateCanvasState } = setup();
    const el = host();
    await act(async () => { await result.current.handlePanStart(pointer(el, 60, 90), 0); });
    act(() => result.current.handlePanMove(pointer(el, 62, 91)));
    act(() => result.current.handlePanEnd(pointer(el, 62, 91)));
    await act(settle);
    expect(offsets(updateCanvasState)).toEqual([{ x: 20, y: 0 }]);
    expect(result.current.panSuppressClickRef.current).toBe(false);
  });

  it('does nothing while photos are locked, for a right-click, or without the photo file', async () => {
    const el = host();
    for (const p of [{ repositionMode: false }, {}, { canvases: [canvas([frame({ originalFile: null })])] }]) {
      const { result, updateCanvasState } = setup(p);
      const ev = 'repositionMode' in p || 'canvases' in p ? pointer(el, 60, 90) : pointer(el, 60, 90, { button: 2 });
      await act(async () => { await result.current.handlePanStart(ev, 0); });
      act(() => result.current.handlePanMove(pointer(el, 80, 90)));
      await act(settle);
      expect(updateCanvasState).not.toHaveBeenCalled();
    }
    expect(getImageMetadata).toHaveBeenCalledTimes(0);
  });

  it('ignores a second finger', async () => {
    const { result, updateCanvasState } = setup();
    const el = host();
    await act(async () => { await result.current.handlePanStart(pointer(el, 60, 90), 0); });
    act(() => result.current.handlePanMove(pointer(el, 80, 90, { pointerId: 2 })));
    await act(settle);
    expect(updateCanvasState).not.toHaveBeenCalled();
  });

  it('pans the frame under the pointer on a collage', async () => {
    const collage = { canvas: LAYOUT.canvas, frames: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }] };
    const { result, updateCanvasState } = setup({ layout: collage, canvases: [canvas([frame(), frame()])] });
    const el = host();
    await act(async () => { await result.current.handlePanStart(pointer(el, 90, 90), 0); });
    act(() => result.current.handlePanMove(pointer(el, 90, 95)));
    await act(settle);
    // Each half is 600×1800; the photo covers it at 0.45 → 1350 wide, so it
    // pans 375 across but still not down, and only frame 1 moves.
    act(() => result.current.handlePanMove(pointer(el, 120, 95)));
    await act(settle);
    expect(offsets(updateCanvasState, 1).at(-1)).toEqual({ x: 300, y: 0 });
    expect(offsets(updateCanvasState, 0).at(-1)).toEqual({ x: 0, y: 0 });
  });

  it('on a multi-surface product, pans that side’s card', async () => {
    const back = { key: 'back', label: 'Back', def: LAYOUT, files: [], canvases: [canvas()], globalFitMode: 'cover' } as unknown as SurfaceState;
    const { result, updateCanvasState } = setup({ surfaceStates: [back], canvases: [] });
    const el = host();
    await act(async () => { await result.current.handlePanStart(pointer(el, 60, 90), 0, 'back'); });
    act(() => result.current.handlePanMove(pointer(el, 64, 90)));
    await act(settle);
    expect(updateCanvasState.mock.calls[0].slice(0, 2)).toEqual([0, 'back']);
  });
});
