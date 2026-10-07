import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useCardActions } from '../useCardActions';
import { calculateSmartCropOffsets } from '../fabric-renderer';
import { convertAndPartitionFiles, isHeicFile } from '@/lib/heic-convert';
import type { CanvasItem, FrameState, SurfaceState } from '../types';

jest.mock('../fabric-renderer', () => ({ calculateSmartCropOffsets: jest.fn(async () => ({ x: 7, y: -3 })) }));
jest.mock('@/lib/image-utils', () => ({ getImageMetadata: jest.fn(async () => ({ element: {}, width: 3000, height: 4000 })) }));
jest.mock('@/lib/heic-convert', () => ({
  isHeicFile: jest.fn((f: File) => /\.heic$/i.test(f.name)),
  convertAndPartitionFiles: jest.fn(async (files: File[]) => ({
    accepted: files.filter(f => !/\.svg$/i.test(f.name)),
    warning: files.some(f => /\.svg$/i.test(f.name)) ? 'skipped logo.svg' : null,
  })),
}));

const LAYOUT = { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] };
const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const frame = (over: Partial<FrameState> = {}): FrameState =>
  ({ id: 0, originalFile: photo('a.jpg'), offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover', ...over }) as FrameState;
const canvas = (over: Partial<CanvasItem> = {}, frames = [frame()]): CanvasItem =>
  ({ id: 0, frames, overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: 'data:old', ...over });
const side = (key: string, files: File[], c: CanvasItem[] = [canvas()]): SurfaceState =>
  ({ key, label: key, def: { canvas: { width: 1000, height: 600 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] }, files, canvases: c, globalFitMode: 'cover' }) as unknown as SurfaceState;

type Init = { files?: File[]; canvases?: CanvasItem[]; surfaceStates?: SurfaceState[]; activeSurfaceKey?: string; orderQty?: number | null; isProcessing?: boolean; layout?: unknown };
const renderCanvas = jest.fn(async () => 'data:new');
const generateCanvasesForLayout = jest.fn(async (_l: unknown, files: File[]) => files.map((f, i) => canvas({ id: i, dataUrl: `data:${f.name}` })));
const expandPdfPages = jest.fn(async (files: File[]) => files);

/** The page's state, held the way the page holds it, around the hook. */
function setup(init: Init = {}) {
  return renderHook(() => {
    const [files, setFiles] = useState<File[]>(init.files ?? [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
    const [canvases, setCanvases] = useState<CanvasItem[]>(init.canvases ?? [canvas({ id: 0 }), canvas({ id: 1 }), canvas({ id: 2 })]);
    const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>(init.surfaceStates ?? []);
    const [activeSurfaceKey, setActiveSurfaceKey] = useState(init.activeSurfaceKey ?? 'default');
    const [activeCanvasIdx, setActiveCanvasIdx] = useState<number | null>(null);
    const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
    const [swapSource, setSwapSource] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
    const [qtyUnder, setQtyUnder] = useState<{ uploaded: number; needed: number } | null>(null);
    const [dragOverIdx, setDragOverIdx] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
    const [heicConverting, setHeicConverting] = useState(false);
    const [unsupportedWarning, setUnsupportedWarning] = useState<string | null>(null);
    const actions = useCardActions({
      layout: init.layout ?? LAYOUT, files, setFiles, canvases, setCanvases, surfaceStates, setSurfaceStates, activeSurfaceKey, setActiveSurfaceKey,
      normalizedLayoutState: { _raw: { name: 'x' } } as never, activeCanvasIdx, setActiveCanvasIdx, setEditingCanvas, renderCanvas,
      generateCanvasesForLayout: generateCanvasesForLayout as never, repositionMode: false, swapSource, setSwapSource,
      deleteConfirm, setDeleteConfirm, orderQty: init.orderQty ?? null, setQtyUnder, dragOverIdx, setDragOverIdx,
      isProcessing: init.isProcessing ?? false, heicConverting, setHeicConverting, expandPdfPages, serverHeicConvert: undefined,
      setUnsupportedWarning,
    });
    return { ...actions, files, canvases, surfaceStates, activeSurfaceKey, activeCanvasIdx, editingCanvas, swapSource, setSwapSource, deleteConfirm, qtyUnder, dragOverIdx, heicConverting, unsupportedWarning };
  });
}
const names = (fs: File[]) => fs.map(f => f.name);
const dragEvent = (data: Record<string, string> = {}, files: File[] = []) => {
  const store: Record<string, string> = { ...data };
  return {
    preventDefault: jest.fn(),
    dataTransfer: { files, getData: (k: string) => store[k] ?? '', setData: (k: string, v: string) => { store[k] = v; }, effectAllowed: '' },
    store,
  } as unknown as React.DragEvent & { store: Record<string, string> };
};

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState(null, '', '/editor/layout/x?order_id=PE-1');
});

describe('useCardActions — the editor', () => {
  it('opens a card in the editor with its own copy of the frames, and records it in the URL', async () => {
    const { result } = setup();
    await act(async () => { await result.current.openEditor(1); });
    expect(result.current.activeCanvasIdx).toBe(1);
    expect(result.current.editingCanvas).toEqual(result.current.canvases[1]);
    expect(result.current.editingCanvas!.frames[0].offset).not.toBe(result.current.canvases[1].frames[0].offset);
    expect(new URLSearchParams(window.location.search).get('canvas')).toBe('1');
    act(() => result.current.closeEditor());
    expect(result.current.activeCanvasIdx).toBeNull();
    expect(result.current.editingCanvas).toBeNull();
    expect(window.location.search).toBe('?order_id=PE-1');
  });

  it('a ?canvas= link opens that card once the cards exist', () => {
    window.history.replaceState(null, '', '/editor/layout/x?canvas=2');
    const { result } = setup();
    expect(result.current.activeCanvasIdx).toBe(2);
    expect(result.current.editingCanvas?.id).toBe(2);
  });

  it('ignores a ?canvas= past the last card', () => {
    window.history.replaceState(null, '', '/editor/layout/x?canvas=3');
    expect(setup().result.current.activeCanvasIdx).toBeNull();
  });

  it('opening a card mid-toggle waits for the toggle, so the editor sees the new state', async () => {
    let finish!: () => void;
    renderCanvas.mockImplementationOnce(() => new Promise(r => { finish = () => r('data:new'); }));
    const { result } = setup();
    act(() => result.current.handleQuickToggleBlur(0));
    await waitFor(() => expect(renderCanvas).toHaveBeenCalled());
    let opened!: Promise<void>;
    act(() => { opened = result.current.openEditor(0); });
    expect(result.current.editingCanvas).toBeNull();
    await act(async () => { finish(); await opened; });
    expect(result.current.editingCanvas!.frames[0].fillStyle).toBe('blur');
  });
});

describe('useCardActions — quick actions', () => {
  it('rotate turns the photo 90° and re-crops an untouched cover photo', async () => {
    const { result } = setup();
    await act(async () => { result.current.handleQuickRotate(1); });
    await waitFor(() => expect(result.current.canvases[1].frames[0].rotation).toBe(90));
    expect(calculateSmartCropOffsets).toHaveBeenCalledWith({}, 1200, 1800, 90);
    expect(result.current.canvases[1].frames[0].offset).toEqual({ x: 7, y: -3 });
    expect(result.current.canvases[1].dataUrl).toBe('data:new');
    expect(renderCanvas).toHaveBeenCalledWith(expect.anything(), { thumbnail: true });
    expect(result.current.canvases[0].frames[0].rotation).toBe(0);
  });

  it('rotate keeps a photo the customer moved where they put it', async () => {
    const moved = canvas({}, [frame({ offset: { x: 30, y: 0 } })]);
    const { result } = setup({ canvases: [moved] });
    await act(async () => { result.current.handleQuickRotate(0); });
    await waitFor(() => expect(result.current.canvases[0].frames[0].rotation).toBe(90));
    expect(result.current.canvases[0].frames[0].offset).toEqual({ x: 30, y: 0 });
    expect(calculateSmartCropOffsets).not.toHaveBeenCalled();
  });

  it('fit/cover: cover re-crops, fit centres', async () => {
    const { result } = setup({ canvases: [canvas({}, [frame({ fitMode: 'contain' })]), canvas({}, [frame({ offset: { x: 5, y: 5 } })])] });
    await act(async () => { result.current.handleQuickToggleFit(0); result.current.handleQuickToggleFit(1); });
    await waitFor(() => expect(result.current.canvases[1].frames[0].fitMode).toBe('contain'));
    expect(result.current.canvases[0].frames[0]).toMatchObject({ fitMode: 'cover', offset: { x: 7, y: -3 } });
    expect(result.current.canvases[1].frames[0].offset).toEqual({ x: 0, y: 0 });
  });

  it('blur toggles on every frame of the card, and back off', async () => {
    const { result } = setup({ canvases: [canvas({}, [frame(), frame()])] });
    await act(async () => { result.current.handleQuickToggleBlur(0); });
    await waitFor(() => expect(result.current.canvases[0].frames.map(f => f.fillStyle)).toEqual(['blur', 'blur']));
    await act(async () => { result.current.handleQuickToggleBlur(0); });
    await waitFor(() => expect(result.current.canvases[0].frames.map(f => f.fillStyle)).toEqual([undefined, undefined]));
  });

  it('a card whose photo could not be recovered keeps its saved preview', async () => {
    const { result } = setup({ canvases: [canvas({ dataUrl: 'data:saved' }, [frame({ originalFile: null })])] });
    await act(async () => { result.current.handleQuickToggleBlur(0); });
    await waitFor(() => expect(result.current.canvases[0].frames[0].fillStyle).toBe('blur'));
    expect(renderCanvas).not.toHaveBeenCalled();
    expect(result.current.canvases[0].dataUrl).toBe('data:saved');
  });

  it('on a multi-surface product, acts on that side, and on the visible cards only when it is the active side', async () => {
    const sides = [side('front', [photo('f.jpg')]), side('back', [photo('b.jpg')])];
    const { result } = setup({ surfaceStates: sides, activeSurfaceKey: 'front', canvases: sides[0].canvases });
    await act(async () => { result.current.handleQuickToggleBlur(0, 'back'); });
    await waitFor(() => expect(result.current.surfaceStates[1].canvases[0].frames[0].fillStyle).toBe('blur'));
    expect(result.current.canvases[0].frames[0].fillStyle).toBeUndefined();
    await act(async () => { result.current.handleQuickToggleBlur(0, 'front'); });
    await waitFor(() => expect(result.current.canvases[0].frames[0].fillStyle).toBe('blur'));
  });
});

describe('useCardActions — remove', () => {
  it('asks first, then removes that card and its photo, and re-checks the ordered quantity', () => {
    const { result } = setup({ orderQty: 3 });
    act(() => result.current.handleQuickDelete(1));
    expect(result.current.deleteConfirm).toEqual({ idx: 1, surfaceKey: null });
    expect(result.current.canvases).toHaveLength(3);
    act(() => result.current.confirmDelete());
    expect(result.current.canvases.map(c => c.id)).toEqual([0, 2]);
    expect(names(result.current.files)).toEqual(['a.jpg', 'c.jpg']);
    expect(result.current.qtyUnder).toEqual({ uploaded: 2, needed: 3 });
    expect(result.current.deleteConfirm).toBeNull();
  });

  it('on a collage, removes the card’s whole block of photos', () => {
    const files = ['1', '2', '3', '4', '5', '6'].map(n => photo(`${n}.jpg`));
    const layout = { ...LAYOUT, frames: [LAYOUT.frames[0], LAYOUT.frames[0]] };
    const { result } = setup({ files, layout, canvases: [canvas({ id: 0 }), canvas({ id: 1 }), canvas({ id: 2 })] });
    act(() => result.current.handleQuickDelete(1));
    act(() => result.current.confirmDelete());
    expect(names(result.current.files)).toEqual(['1.jpg', '2.jpg', '5.jpg', '6.jpg']);
  });

  it('on a multi-surface product, empties that side', () => {
    const sides = [side('front', [photo('f.jpg')]), side('back', [photo('b.jpg')])];
    const { result } = setup({ surfaceStates: sides, activeSurfaceKey: 'back', files: [photo('b.jpg')], canvases: sides[1].canvases });
    act(() => result.current.handleQuickDelete(0, 'back'));
    act(() => result.current.confirmDelete());
    expect(result.current.surfaceStates[1]).toMatchObject({ files: [], canvases: [] });
    expect(result.current.surfaceStates[0].files).toHaveLength(1);
    expect(result.current.files).toEqual([]);
    expect(result.current.canvases).toEqual([]);
  });
});

describe('useCardActions — swap and drag', () => {
  it('tap-to-swap: the next card tapped swaps photos with the picked one', async () => {
    const { result } = setup();
    act(() => result.current.setSwapSource({ idx: 0, surfaceKey: null }));
    await act(async () => { result.current.handleCardClick(2); });
    expect(names(result.current.files)).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
    expect(result.current.swapSource).toBeNull();
    expect(result.current.activeCanvasIdx).toBeNull();
  });

  it('tapping the picked card again just puts it down', async () => {
    const { result } = setup();
    act(() => result.current.setSwapSource({ idx: 1, surfaceKey: null }));
    await act(async () => { result.current.handleCardClick(1); });
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(result.current.swapSource).toBeNull();
  });

  it('without a picked card, a tap opens the editor', async () => {
    const { result } = setup();
    await act(async () => { result.current.handleCardClick(2); });
    expect(result.current.activeCanvasIdx).toBe(2);
  });

  it('dragging a card carries its index (and side), and dropping it on another swaps them', async () => {
    const { result } = setup();
    const start = dragEvent();
    act(() => result.current.handleDragStart(start, 0));
    expect(start.store).toEqual({ canvasIdx: '0' });
    const over = dragEvent();
    act(() => result.current.handleDragOver(over, 2));
    expect(over.preventDefault).toHaveBeenCalled();
    expect(result.current.dragOverIdx).toEqual({ idx: 2, surfaceKey: null });
    await act(async () => { await result.current.handleDrop(dragEvent(start.store), 2); });
    expect(names(result.current.files)).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
    expect(result.current.dragOverIdx).toBeNull();
    const surfaceStart = dragEvent();
    act(() => result.current.handleDragStart(surfaceStart, 0, 'back'));
    expect(surfaceStart.store).toEqual({ canvasIdx: '0', surfaceKey: 'back' });
  });

  it('dropping photos from the desktop puts them on that card, skipping what cannot print', async () => {
    const { result } = setup();
    await act(async () => { await result.current.handleDrop(dragEvent({}, [photo('new.jpg'), new File(['x'], 'logo.svg')]), 1); });
    expect(names(result.current.files)).toEqual(['a.jpg', 'new.jpg', 'c.jpg']);
    expect(result.current.unsupportedWarning).toBe('skipped logo.svg');
  });

  it('an iPhone photo shows the converting card while it converts', async () => {
    let finish!: () => void;
    jest.mocked(convertAndPartitionFiles).mockImplementationOnce((files) => new Promise(r => { finish = () => r({ accepted: files, warning: null }); }));
    const { result } = setup();
    const heic = new File(['x'], 'IMG_1.HEIC');
    let dropped!: Promise<void>;
    act(() => { dropped = result.current.handleDrop(dragEvent({}, [heic]), 0); });
    await waitFor(() => expect(result.current.heicConverting).toBe(true));
    await act(async () => { finish(); await dropped; });
    expect(jest.mocked(isHeicFile).mock.calls[0][0]).toBe(heic);
    expect(result.current.heicConverting).toBe(false);
    expect(names(result.current.files)[0]).toBe('IMG_1.HEIC');
  });

  it('a drop onto one side of a multi-surface product fills that side, up to its frames', async () => {
    const sides = [side('front', []), side('back', [])];
    const { result } = setup({ surfaceStates: sides, activeSurfaceKey: 'back', files: [], canvases: [] });
    await act(async () => { await result.current.handleDrop(dragEvent({}, [photo('x.jpg'), photo('y.jpg')]), 0, 'back'); });
    expect(expandPdfPages).toHaveBeenCalledWith(expect.any(Array), { maxSelectable: 1 });
    expect(names(result.current.surfaceStates[1].files)).toEqual(['x.jpg']);
    expect(result.current.surfaceStates[0].files).toEqual([]);
    expect(names(result.current.files)).toEqual(['x.jpg']);
    expect(result.current.canvases[0].dataUrl).toBe('data:x.jpg');
  });

  it('swapping two sides swaps their photos and rebuilds both', async () => {
    const sides = [side('front', [photo('f.jpg')]), side('back', [photo('b.jpg')])];
    const { result } = setup({ surfaceStates: sides, activeSurfaceKey: 'front', files: [photo('f.jpg')], canvases: sides[0].canvases });
    await act(async () => { await result.current.handleDrop(dragEvent({ canvasIdx: '0', surfaceKey: 'front' }), 0, 'back'); });
    expect(result.current.surfaceStates.map(s => names(s.files))).toEqual([['b.jpg'], ['f.jpg']]);
    expect(names(result.current.files)).toEqual(['b.jpg']);
    expect(generateCanvasesForLayout).toHaveBeenCalledTimes(2);
  });

  it('ignores drops while photos are processing', async () => {
    const { result } = setup({ isProcessing: true });
    await act(async () => { await result.current.handleDrop(dragEvent({ canvasIdx: '0' }), 2); });
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });
});
