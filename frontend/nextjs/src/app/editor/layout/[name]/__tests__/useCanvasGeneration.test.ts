import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useCanvasGeneration, useObjectUrls, useRenderCanvas } from '../useCanvasGeneration';
import { calculateSmartCropOffsets, renderCanvas as renderCanvasCore } from '../fabric-renderer';
import { detectFileOrientation } from '@/lib/ml-orientation';
import { pdfDerivedFiles } from '@/lib/pdf-import';
import { resolveRotation } from '../editor-utils';
import type { CanvasItem, FitMode, SurfaceState } from '../types';

jest.mock('../fabric-renderer', () => ({
  renderCanvas: jest.fn(async () => 'data:thumb'),
  calculateSmartCropOffsets: jest.fn(async () => ({ x: 11, y: -4 })),
}));
// A landscape photo (4000×3000) for every file.
jest.mock('@/lib/image-utils', () => ({ getImageMetadata: jest.fn(async () => ({ width: 4000, height: 3000, element: { tag: 'img' } })) }));
jest.mock('@/lib/ml-orientation', () => ({ detectFileOrientation: jest.fn(async () => ({ rotation: 0, confidence: 0, source: 'none' })) }));
jest.mock('@/lib/pdf-import', () => ({ pdfDerivedFiles: new WeakSet<File>() }));

const LAYOUT = { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] };
const photo = (name: string, lastModified = 1) => new File(['x'], name, { type: 'image/jpeg', lastModified });
const crop = jest.mocked(calculateSmartCropOffsets);
const draw = jest.mocked(renderCanvasCore);
const detect = jest.mocked(detectFileOrientation);
const settle = () => new Promise(r => setTimeout(r, 0));

describe('useObjectUrls', () => {
  it('gives each photo one URL, however often it is asked for, and tracks it for revoking', () => {
    let n = 0;
    jest.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`);
    const { result } = renderHook(() => useObjectUrls());
    const a = photo('a.jpg'), b = photo('b.jpg');
    expect(result.current.getFileUrl(a)).toBe('blob:1');
    expect(result.current.getFileUrl(a)).toBe('blob:1');
    expect(result.current.getFileUrl(b)).toBe('blob:2');
    expect([...result.current.createdObjectURLs.current]).toEqual(['blob:1', 'blob:2']);
    expect(result.current.fileUrlCache.current.get(a)).toBe('blob:1');
    jest.restoreAllMocks();
  });
});

describe('useRenderCanvas', () => {
  it('draws with the current layout, or the one it is given', async () => {
    const getFileUrl = jest.fn();
    const { result, rerender } = renderHook(({ layout }) => useRenderCanvas(layout, getFileUrl), { initialProps: { layout: { name: 'one' } as unknown } });
    const c = { id: 0 } as CanvasItem;
    rerender({ layout: { name: 'two' } });
    await result.current(c, { thumbnail: true });
    expect(draw).toHaveBeenLastCalledWith(c, { name: 'two' }, getFileUrl, { thumbnail: true });
    await result.current(c, { layoutOverride: { name: 'side' } });
    expect(draw.mock.calls.at(-1)?.[1]).toEqual({ name: 'side' });
  });
});

// Stable, like the page's (a useCallback with no dependencies).
const getFileUrl = () => 'blob:x';

type Init = { files?: File[]; layout?: unknown; fitMode?: FitMode; blur?: boolean; isCalendarProduct?: boolean; surfaceStates?: SurfaceState[]; canvases?: CanvasItem[] };

/** The page's state around the hook, held the way the page holds it. */
function setup(init: Init = {}) {
  return renderHook(() => {
    const [files, setFiles] = useState<File[]>(init.files ?? []);
    const [canvases, setCanvases] = useState<CanvasItem[]>(init.canvases ?? []);
    const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>(init.surfaceStates ?? []);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);
    const [globalFitMode, setGlobalFitMode] = useState<FitMode>(init.fitMode ?? 'contain');
    const [globalBlurFill, setGlobalBlurFill] = useState(init.blur ?? true);
    const canvasesRef = useRef(canvases); canvasesRef.current = canvases;
    const globalFitModeRef = useRef(globalFitMode); globalFitModeRef.current = globalFitMode;
    const globalBlurFillRef = useRef(globalBlurFill); globalBlurFillRef.current = globalBlurFill;
    const skipNextGenerateRef = useRef(false);
    const fitModeUserToggledRef = useRef(false);
    const blurFillUserToggledRef = useRef(false);
    const renderCanvas = useRenderCanvas(init.layout ?? LAYOUT, getFileUrl);
    const gen = useCanvasGeneration({
      layout: init.layout ?? LAYOUT, files, isProcessing, setIsProcessing, setError, isCalendarProduct: init.isCalendarProduct ?? false,
      setRenderProgress, canvasesRef, setCanvases, renderCanvas, apiBase: '/api/embed/proxy', getAuthHeaders: () => ({ 'X-Embed-Token': 't' }),
      globalFitModeRef, globalBlurFillRef, skipNextGenerateRef, surfaceStates, setSurfaceStates, fitModeUserToggledRef, globalFitMode,
      activeSurfaceKey: 'front', blurFillUserToggledRef, globalBlurFill,
    });
    return { ...gen, files, setFiles, canvases, surfaceStates, isProcessing, error, renderProgress, setGlobalFitMode, setGlobalBlurFill, skipNextGenerateRef, fitModeUserToggledRef, blurFillUserToggledRef };
  });
}
// The frame the landscape test photo goes into: the full 1200×1800 canvas.
const expectedRotation = () => resolveRotation({ rotation: 0, confidence: 0, source: 'none' } as never, 4000, 3000, 1200, 1800);

beforeEach(() => jest.clearAllMocks());

describe('useCanvasGeneration — building the cards', () => {
  it('builds one card per photo with the orientation, crop and default blur the page always used', async () => {
    const files = [photo('a.jpg'), photo('b.jpg')];
    const { result } = setup({ files, fitMode: 'cover' });
    await waitFor(() => expect(result.current.canvases).toHaveLength(2));
    await waitFor(() => expect(result.current.isProcessing).toBe(false));
    const rotation = expectedRotation();
    expect(detect).toHaveBeenCalledWith('/api/embed/proxy', files[0], { tag: 'img' }, { 'X-Embed-Token': 't' });
    expect(crop).toHaveBeenCalledWith({ tag: 'img' }, 1200, 1800, rotation, `a.jpg:1:1:1200x1800:${rotation}`);
    expect(result.current.canvases[0]).toMatchObject({ id: 0, dataUrl: 'data:thumb', bgColor: '#ffffff', overlays: [] });
    expect(result.current.canvases[0].frames[0]).toMatchObject({
      id: 0, originalFile: files[0], fileName: 'a.jpg', fileSize: 1, offset: { x: 11, y: -4 }, scale: 1, rotation, fitMode: 'cover', fillStyle: 'blur',
    });
    expect(result.current.renderProgress).toBeNull();
  });

  it('in Fit mode, a new photo is centred, not cropped; with Blur off it gets no fill', async () => {
    const { result } = setup({ files: [photo('a.jpg')], fitMode: 'contain', blur: false });
    await waitFor(() => expect(result.current.canvases).toHaveLength(1));
    expect(crop).not.toHaveBeenCalled();
    expect(result.current.canvases[0].frames[0]).toMatchObject({ offset: { x: 0, y: 0 }, fitMode: 'contain', fillStyle: undefined });
  });

  it('a PDF page is never rotated or sent for orientation', async () => {
    const page = photo('menu-p1.png');
    pdfDerivedFiles.add(page);
    const { result } = setup({ files: [page] });
    await waitFor(() => expect(result.current.canvases).toHaveLength(1));
    expect(detect).not.toHaveBeenCalled();
    expect(result.current.canvases[0].frames[0].rotation).toBe(0);
  });

  it('adding a photo keeps the edits on the photos already there', async () => {
    const a = photo('a.jpg'), b = photo('b.jpg');
    const { result } = setup({ files: [a] });
    await waitFor(() => expect(result.current.canvases).toHaveLength(1));
    act(() => { result.current.canvases[0].frames[0].offset = { x: 99, y: 1 }; });
    act(() => result.current.setFiles([a, b]));
    await waitFor(() => expect(result.current.canvases).toHaveLength(2));
    expect(result.current.canvases[0].frames[0].offset).toEqual({ x: 99, y: 1 });
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('a calendar takes at most 12 photo pages', async () => {
    const files = Array.from({ length: 14 }, (_, i) => photo(`p${i}.jpg`, i + 1));
    const { result } = setup({ files, isCalendarProduct: true });
    await waitFor(() => expect(result.current.isProcessing).toBe(false));
    await waitFor(() => expect(result.current.canvases).toHaveLength(12));
  });

  it('a failed build says so and stops processing', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    draw.mockRejectedValueOnce(new Error('decode'));
    const { result } = setup({ files: [photo('a.jpg')] });
    await waitFor(() => expect(result.current.error).toBe('Failed to process images'));
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.renderProgress).toBeNull();
  });

  it('skips one rebuild when asked (the editor modal commits its own canvases)', async () => {
    const { result } = setup();
    act(() => { result.current.skipNextGenerateRef.current = true; });
    act(() => result.current.setFiles([photo('a.jpg')]));
    await act(settle);
    expect(result.current.canvases).toHaveLength(0);
    expect(result.current.skipNextGenerateRef.current).toBe(false);
  });

  it('builds one side’s cards on request, with that side’s frame size', async () => {
    const { result } = setup();
    const side = { canvas: { width: 1000, height: 600 }, frames: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }] };
    let built: CanvasItem[] = [];
    await act(async () => { built = await result.current.generateCanvasesForLayout(side, [photo('x.jpg'), photo('y.jpg')], 'cover', []); });
    expect(built).toHaveLength(1);
    expect(built[0].frames.map(f => f.fileName)).toEqual(['x.jpg', 'y.jpg']);
    const rotation = resolveRotation({ rotation: 0, confidence: 0, source: 'none' } as never, 4000, 3000, 500, 600);
    expect(crop).toHaveBeenCalledWith({ tag: 'img' }, 500, 600, rotation, `x.jpg:1:1:500x600:${rotation}`);
    expect(draw).toHaveBeenLastCalledWith(expect.anything(), side, expect.any(Function), { thumbnail: true, layoutOverride: side });
    await act(async () => { built = await result.current.generateCanvasesForLayout(side, [], 'cover', []); });
    expect(built).toEqual([]);
  });
});

describe('useCanvasGeneration — whole-design Fit/Cover and Blur', () => {
  const card = (key: string): SurfaceState => ({
    key, label: key, globalFitMode: 'contain', files: [],
    def: { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] },
    canvases: [{ id: 0, overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: 'data:old',
      frames: [{ id: 0, originalFile: photo('a.jpg'), fileId: 'fid-1', offset: { x: 5, y: 5 }, scale: 1, rotation: 90, fitMode: 'contain' }] }],
  } as unknown as SurfaceState);

  it('ignores a Fit/Cover change it did not see the customer make (restore, side switch)', async () => {
    const { result } = setup({ surfaceStates: [card('front')] });
    act(() => result.current.setGlobalFitMode('cover'));
    await act(settle);
    expect(crop).not.toHaveBeenCalled();
  });

  it('the customer’s switch to Cover re-crops every card, keyed by the stored photo id', async () => {
    const { result } = setup({ surfaceStates: [card('front'), card('back')] });
    act(() => { result.current.fitModeUserToggledRef.current = true; result.current.setGlobalFitMode('cover'); });
    await waitFor(() => expect(result.current.surfaceStates[1].canvases[0].frames[0].fitMode).toBe('cover'));
    expect(crop).toHaveBeenCalledWith({ tag: 'img' }, 1200, 1800, 90, 'fid-1:1200x1800:90');
    expect(result.current.surfaceStates.map(s => s.globalFitMode)).toEqual(['cover', 'cover']);
    expect(result.current.surfaceStates[0].canvases[0]).toMatchObject({ dataUrl: 'data:thumb' });
    expect(result.current.surfaceStates[0].canvases[0].frames[0].offset).toEqual({ x: 11, y: -4 });
    expect(result.current.canvases[0].frames[0].fitMode).toBe('cover');
    expect(result.current.fitModeUserToggledRef.current).toBe(false);
    expect(result.current.isProcessing).toBe(false);
  });

  it('the customer’s switch to Fit centres every photo', async () => {
    const s = card('front');
    s.canvases[0].frames[0].fitMode = 'cover';
    const { result } = setup({ surfaceStates: [s], fitMode: 'cover' });
    act(() => { result.current.fitModeUserToggledRef.current = true; result.current.setGlobalFitMode('contain'); });
    await waitFor(() => expect(result.current.surfaceStates[0].canvases[0].frames[0].fitMode).toBe('contain'));
    expect(result.current.surfaceStates[0].canvases[0].frames[0].offset).toEqual({ x: 0, y: 0 });
    expect(crop).not.toHaveBeenCalled();
  });

  it('Blur Effect sets or clears the fill on every frame, only on the customer’s toggle', async () => {
    const { result } = setup({ surfaceStates: [card('front')] });
    act(() => result.current.setGlobalBlurFill(false));
    await act(settle);
    expect(draw).not.toHaveBeenCalled();
    act(() => { result.current.blurFillUserToggledRef.current = true; result.current.setGlobalBlurFill(true); });
    await waitFor(() => expect(result.current.surfaceStates[0].canvases[0].frames[0].fillStyle).toBe('blur'));
    expect(result.current.canvases[0].frames[0].fillStyle).toBe('blur');
    act(() => { result.current.blurFillUserToggledRef.current = true; result.current.setGlobalBlurFill(false); });
    await waitFor(() => expect(result.current.surfaceStates[0].canvases[0].frames[0].fillStyle).toBeUndefined());
    expect(draw).toHaveBeenCalledWith(expect.anything(), card('front').def, expect.any(Function), { thumbnail: true, layoutOverride: card('front').def });
  });
});
