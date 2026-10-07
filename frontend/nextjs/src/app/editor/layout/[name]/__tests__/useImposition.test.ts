import { act, renderHook } from '@testing-library/react';
import { useImposition } from '../useImposition';
import { computeImpositionLayout, MM_TO_IN, type ItemSize } from '../imposition';
import type { CanvasItem, SurfaceState } from '../types';

// The Fabric preview and the full-resolution export need a real canvas; the
// Playwright suite covers those. These pin the logic around them.

const canvas = (i: number) => ({ id: `c${i}` }) as unknown as CanvasItem;
const canvases = (n: number) => Array.from({ length: n }, (_, i) => canvas(i));
const FOUR_BY_SIX: ItemSize = { wIn: 4, hIn: 6 };
const LAYOUT_4X6 = { canvas: { width: 1200, height: 1800, dpi: 300 } };

type Props = Parameters<typeof useImposition>[0];

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    layout: LAYOUT_4X6,
    surfaceStates: [],
    canvases: canvases(3),
    renderCanvas: jest.fn(async () => 'data:image/png;base64,AAAA'),
    setError: jest.fn(),
    setRenderProgress: jest.fn(),
    ...overrides,
  };
  return { ...renderHook((p: Props) => useImposition(p), { initialProps: props }), props };
}

describe('useImposition', () => {
  it('places one item per canvas, at the layout physical size', () => {
    const { result } = setup();
    const { impositionSettings, impositionResult, impositionPlacedTotal, sheetCount } = result.current;
    expect(impositionResult).toEqual(computeImpositionLayout(impositionSettings, [FOUR_BY_SIX, FOUR_BY_SIX, FOUR_BY_SIX]));
    expect(impositionPlacedTotal).toBe(impositionResult.placedPerCanvas.reduce((a, b) => a + b, 0));
    expect(sheetCount).toBe(impositionResult.sheets.length);
  });

  it('gives each side of a multi-sided product its own size', () => {
    const surfaceStates = [
      { key: 'front', def: { canvas: { width: 1200, height: 1800, dpi: 300 } }, canvases: [canvas(0)] },
      { key: 'back', def: { canvas: { widthMm: 210, heightMm: 297 } }, canvases: [canvas(1), canvas(2)] },
    ] as unknown as SurfaceState[];
    const { result } = setup({ surfaceStates });
    const a4: ItemSize = { wIn: 210 / MM_TO_IN, hIn: 297 / MM_TO_IN };
    expect(result.current.impositionResult)
      .toEqual(computeImpositionLayout(result.current.impositionSettings, [FOUR_BY_SIX, a4, a4]));
  });

  it('labels the sheet by its preset, or by its size when custom', () => {
    const { result } = setup();
    expect(result.current.impositionSheetLabel).toBe('A4');
    act(() => result.current.setImpositionSettings(s => ({ ...s, preset: 'custom', widthIn: 12, heightIn: 18 })));
    expect(result.current.impositionSheetLabel).toBe('12″ × 18″');
  });

  it('refuses to impose a layout with no physical size, without starting', async () => {
    const { result, props } = setup({ layout: { canvas: {} } });
    await act(async () => { await result.current.executeImposition(); });
    expect(props.setError).toHaveBeenCalledWith('This layout has no physical dimensions, so it cannot be imposed.');
    expect(result.current.isImposing).toBe(false);
    expect(props.renderCanvas).not.toHaveBeenCalled();
  });

  it('keeps the previewed sheet in range, and starts every visit on sheet 1', () => {
    const { result } = setup({ canvases: canvases(20) });
    const onA4 = result.current.sheetCount;
    act(() => result.current.setPreviewSheetIdx(onA4 - 1));
    act(() => result.current.setImpositionSettings(s => ({ ...s, preset: '13x19' })));
    const onLargerSheet = result.current.sheetCount;
    expect(onLargerSheet).toBeLessThan(onA4);
    expect(result.current.previewSheetIdx).toBe(onLargerSheet - 1);

    act(() => result.current.setShowImpositionModal(true));
    expect(result.current.previewSheetIdx).toBe(0);
  });
});
