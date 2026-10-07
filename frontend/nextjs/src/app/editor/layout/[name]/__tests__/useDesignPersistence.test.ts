import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useAutosaveAndRestore, usePhotoStore } from '../useDesignPersistence';
import {
  deleteFile, FileStoreQuotaError, getFilesForOrder, getPersistenceMode, pruneStaleOrders, pruneUnreferencedFiles, saveFile,
} from '@/lib/file-store';
import type { CalendarTheme, CalendarType } from '@/types/calendar';
import type { CanvasItem, FitMode, FrameState, SurfaceState } from '../types';

jest.mock('@/lib/file-store', () => {
  class FileStoreQuotaError extends Error {}
  return {
    FileStoreQuotaError,
    saveFile: jest.fn(async (_o: string, f: File) => `id-${f.name}`),
    deleteFile: jest.fn(async () => {}),
    getFilesForOrder: jest.fn(async () => new Map()),
    pruneStaleOrders: jest.fn(async () => {}),
    pruneUnreferencedFiles: jest.fn(async () => {}),
    getPersistenceMode: jest.fn(() => 'durable'),
  };
});
jest.mock('../fabric-renderer', () => ({ renderCanvas: jest.fn(async () => 'data:regen') }));

const LAYOUT = { name: 'classic_4x6', canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] };
const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg', lastModified: 1 });
const frame = (over: Partial<FrameState> = {}): FrameState =>
  ({ id: 0, originalFile: null, offset: { x: 4, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover', ...over }) as FrameState;
const canvas = (frames: FrameState[], id = 0): CanvasItem => ({ id, frames, overlays: [], bgColor: '#ffffff', paperColor: '#ffffff', dataUrl: 'data:thumb' });
const side = (key: string, canvases: CanvasItem[] = []) =>
  ({ key, label: key, def: { canvas: {}, frames: [{}] }, files: [], canvases, globalFitMode: 'contain' }) as unknown as SurfaceState;

// ── A fake canvas-state endpoint ────────────────────────────────────────────
type Held = { release: (status: number, body?: unknown) => void };
let gets: string[] = [];
let puts: Array<{ url: string; body: { layout_name: string; editor_state: Record<string, any> } }> = [];
let getQueue: Array<{ status: number; body?: unknown } | 'hold'> = [];
let held: Held | null = null;
let putStatus = 200;
beforeEach(() => {
  jest.clearAllMocks();
  gets = []; puts = []; getQueue = []; held = null; putStatus = 200;
  window.localStorage.clear();
  window.history.replaceState(null, '', '/editor/layout/classic_4x6?order_id=EXT-1');
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(init.body as string) });
      return { ok: putStatus < 400, status: putStatus, json: async () => ({}) };
    }
    gets.push(url);
    const next = getQueue.shift() ?? { status: 404 };
    if (next === 'hold') {
      return new Promise(resolve => {
        held = { release: (status, body) => resolve({ ok: status < 400, status, json: async () => body }) };
      });
    }
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  }) as unknown as typeof fetch;
});
afterEach(() => jest.useRealTimers());

type Init = { layout?: unknown; legacy?: string | null; surfaceStates?: SurfaceState[]; calendar?: boolean; book?: boolean };
/** The page's state around the hook, held the way the page holds it. */
function setup(init: Init = {}) {
  return renderHook(() => {
    const [canvases, setCanvases] = useState<CanvasItem[]>([]);
    const [files, setFiles] = useState<File[]>([]);
    const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>(init.surfaceStates ?? [side('default')]);
    const surfaceStatesRef = useRef(surfaceStates); surfaceStatesRef.current = surfaceStates;
    const [activeSurfaceKey, setActiveSurfaceKey] = useState('default');
    const activeSurfaceKeyRef = useRef(activeSurfaceKey); activeSurfaceKeyRef.current = activeSurfaceKey;
    const [globalFitMode, setGlobalFitMode] = useState<FitMode>('contain');
    const [calendarTheme, setCalendarTheme] = useState<CalendarTheme>('modern-minimalist');
    const [calendarType, setCalendarType] = useState<CalendarType>('english');
    const [genzPalette, setGenzPalette] = useState<string | undefined>(undefined);
    const [calendarCells, setCalendarCells] = useState<Record<string, any[]>>({});
    const [bookPageCount, setBookPageCount] = useState(8);
    const [bookHiddenPages, setBookHiddenPages] = useState<Record<string, SurfaceState>>({});
    const bookHiddenPagesRef = useRef(bookHiddenPages); bookHiddenPagesRef.current = bookHiddenPages;
    const legacyOrderIdRef = useRef<string | null>(init.legacy ?? null);
    const skipNextGenerateRef = useRef(false);
    const p = useAutosaveAndRestore({
      layout: init.layout === undefined ? LAYOUT : init.layout, layoutLoading: false, layoutName: 'classic_4x6', orderId: 'EXT-1',
      apiBase: '/api/embed/proxy', getAuthHeaders: () => ({ 'X-Embed-Token': 't' }), legacyOrderIdRef, normalizedLayoutState: null,
      canvases, setCanvases, setFiles, surfaceStatesRef, setSurfaceStates, activeSurfaceKey, activeSurfaceKeyRef, setActiveSurfaceKey,
      setGlobalFitMode, getFileUrl: (f: File) => `blob:${f.name}`, skipNextGenerateRef,
      isCalendarProduct: init.calendar ?? false, calendarTheme, setCalendarTheme, calendarType, setCalendarType, genzPalette, setGenzPalette,
      calendarCells, setCalendarCells, isBookProduct: init.book ?? false, bookPageCount, setBookPageCount, bookHiddenPagesRef, setBookHiddenPages,
    });
    return { ...p, canvases, setCanvases, files, surfaceStates, setSurfaceStates, activeSurfaceKey, globalFitMode, calendarTheme, setCalendarTheme, calendarCells, setBookPageCount, setBookHiddenPages, skipNextGenerateRef };
  });
}
const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

describe('useAutosaveAndRestore — autosave waits for the restore', () => {
  it('never writes while the saved design is still loading, then saves once it lands', async () => {
    jest.useFakeTimers();
    getQueue = ['hold'];
    const { result } = setup();
    await tick(0);
    expect(gets).toEqual(['/api/embed/proxy/canvas-state/EXT-1/']);
    expect(result.current.restorePending).toBe(true);
    // An edit while the restore is in flight, then far more than the 2 s debounce.
    act(() => result.current.setCanvases([canvas([frame()])]));
    await tick(10_000);
    expect(puts).toEqual([]);
    expect(result.current.isSaving).toBe('idle');
    // The restore lands (nothing saved): the edit made meanwhile is saved.
    await act(async () => { held!.release(404); await jest.advanceTimersByTimeAsync(0); });
    expect(result.current.restorePending).toBe(false);
    await tick(1_999);
    expect(puts).toEqual([]);
    await tick(1);
    expect(puts).toHaveLength(1);
    expect(puts[0].body.editor_state.surfaces).toHaveLength(1);
  });

  it('a slow restore of a saved design is never overwritten by the pre-restore state', async () => {
    jest.useFakeTimers();
    getQueue = ['hold'];
    const saved = { layoutName: 'classic_4x6', activeSurfaceKey: 'default', surfaces: [{ key: 'default', canvases: [canvas([frame({ fileId: 'f1' })])], globalFitMode: 'cover' }] };
    const { result } = setup();
    await tick(0);
    act(() => result.current.setCanvases([]));
    await tick(5_000);
    await act(async () => { held!.release(200, { editor_state: saved }); await jest.advanceTimersByTimeAsync(0); });
    await tick(5_000);
    // The restored design isn't written straight back, and nothing older replaced it.
    expect(puts).toEqual([]);
    expect(result.current.canvases).toHaveLength(1);
    expect(result.current.globalFitMode).toBe('cover');
  });
  it('a calendar edit during the restore waits too (the PR #166 calendar path, which has no guard of its own)', async () => {
    jest.useFakeTimers();
    getQueue = ['hold'];
    const { result } = setup({ calendar: true });
    await tick(0);
    act(() => result.current.setCalendarTheme('modern-genz'));
    await tick(10_000);
    expect(puts).toEqual([]);
    await act(async () => { held!.release(404); await jest.advanceTimersByTimeAsync(0); });
  });
});

describe('useAutosaveAndRestore — the save', () => {
  it('debounces edits into one save of the serialised design, then shows saved', async () => {
    jest.useFakeTimers();
    const { result } = setup();
    await tick(0);
    const a = photo('a.jpg');
    act(() => result.current.setCanvases([canvas([frame({ originalFile: a })])]));
    act(() => result.current.setSurfaceStates([side('default', [canvas([frame({ originalFile: a, fileId: 'id-a' })])])]));
    await tick(1_000);
    act(() => result.current.setCanvases([canvas([frame({ originalFile: a })]), canvas([frame()], 1)]));
    expect(result.current.isSaving).toBe('saving');
    await tick(2_000);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('/api/embed/proxy/canvas-state/EXT-1/');
    const state = puts[0].body.editor_state;
    expect(puts[0].body.layout_name).toBe('classic_4x6');
    expect(state).toMatchObject({ activeSurfaceKey: 'default', layoutName: 'classic_4x6' });
    // Previews and Files are never sent: they are regenerated / restored locally.
    expect(state.surfaces[0].canvases[0]).toMatchObject({ dataUrl: null, frames: [{ originalFile: null, fileId: 'id-a' }] });
    expect(result.current.isSaving).toBe('saved');
    await tick(3_000);
    expect(result.current.isSaving).toBe('idle');
  });

  it('a calendar saves its choices and day entries; a book its page count and held pages', async () => {
    jest.useFakeTimers();
    const cal = setup({ calendar: true });
    await tick(0);
    act(() => cal.result.current.setCalendarTheme('modern-genz'));
    await tick(2_000);
    expect(puts.at(-1)!.body.editor_state.calendarState).toEqual({ themePreset: 'modern-genz', calendarType: 'english', genzPalette: undefined, cells: {} });
    const book = setup({ book: true });
    await tick(0);
    act(() => { book.result.current.setBookHiddenPages({ page_09: side('page_09', [canvas([frame()])]) }); book.result.current.setBookPageCount(4); });
    await tick(2_000);
    expect(puts.at(-1)!.body.editor_state.bookState).toMatchObject({ pageCount: 4, hiddenSurfaces: [{ key: 'page_09', globalFitMode: 'contain' }] });
  });

  it('a failed save goes back to idle', async () => {
    jest.useFakeTimers();
    putStatus = 400;
    const { result } = setup();
    await tick(0);
    act(() => result.current.setCanvases([canvas([frame()])]));
    await tick(2_000);
    expect(result.current.isSaving).toBe('idle');
  });

  it('leaving the page leaves no timer running, the "saved" reset included', async () => {
    jest.useFakeTimers();
    const { result, unmount } = setup();
    await tick(0);
    act(() => result.current.setCanvases([canvas([frame()])]));
    await tick(2_000);
    expect(result.current.isSaving).toBe('saved');
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a save after leaving the page is cancelled', async () => {
    jest.useFakeTimers();
    const { result, unmount } = setup();
    await tick(0);
    act(() => result.current.setCanvases([canvas([frame()])]));
    unmount();
    await tick(5_000);
    expect(puts).toEqual([]);
  });

  it('remembers how many cards there were, for the next visit’s placeholders', async () => {
    const { result } = setup();
    act(() => result.current.setCanvases([canvas([frame()]), canvas([frame()], 1)]));
    await waitFor(() => expect(window.localStorage.length).toBeGreaterThan(0));
    expect(Object.values({ ...window.localStorage })).toContain('2');
  });
});

describe('useAutosaveAndRestore — the restore', () => {
  it('brings the saved design back with its photos from the browser store, and redraws the previews', async () => {
    const a = photo('a.jpg');
    jest.mocked(getFilesForOrder).mockResolvedValueOnce(new Map([['f1', a]]));
    getQueue = [{ status: 200, body: { editor_state: {
      layoutName: 'classic_4x6', activeSurfaceKey: 'default',
      surfaces: [{ key: 'default', canvases: [{ ...canvas([frame({ fileId: 'f1' })]), dataUrl: null }], globalFitMode: 'cover' }],
    } } }];
    window.history.replaceState(null, '', '/editor/layout/classic_4x6?order_id=EXT-1&canvas=0');
    const { result } = setup();
    await waitFor(() => expect(result.current.canvases[0]?.dataUrl).toBe('data:regen'));
    expect(result.current.canvases[0].frames[0].originalFile).toBe(a);
    expect(result.current.surfaceStates[0].canvases[0].frames[0].originalFile).toBe(a);
    expect(result.current.files).toEqual([a]);
    expect(result.current.globalFitMode).toBe('cover');
    expect(result.current.skipNextGenerateRef.current).toBe(true);
    expect(result.current.restorePending).toBe(false);
    // A stale ?canvas= from the last visit doesn't reopen the editor over the restore.
    expect(window.location.search).toBe('?order_id=EXT-1');
    expect(pruneStaleOrders).toHaveBeenCalledWith('EXT-1');
    expect(pruneUnreferencedFiles).toHaveBeenCalledWith('EXT-1', new Set(['f1']), expect.any(Number));
  });

  it('falls back once to a design saved under the pre-adoption order id', async () => {
    getQueue = [{ status: 404 }, { status: 404 }];
    setup({ legacy: 'PE-OLD' });
    await waitFor(() => expect(gets).toHaveLength(2));
    expect(gets).toEqual(['/api/embed/proxy/canvas-state/EXT-1/', '/api/embed/proxy/canvas-state/PE-OLD/']);
  });

  it('ignores a design saved for a different template', async () => {
    getQueue = [{ status: 200, body: { editor_state: { layoutName: 'other', surfaces: [{ key: 'default', canvases: [canvas([frame()])] }] } } }];
    const { result } = setup();
    await waitFor(() => expect(result.current.restorePending).toBe(false));
    expect(result.current.canvases).toEqual([]);
    expect(pruneUnreferencedFiles).not.toHaveBeenCalled();
  });

  it('restores a calendar’s choices, merging legacy per-month entries', async () => {
    getQueue = [{ status: 200, body: { editor_state: {
      layoutName: 'classic_4x6', surfaces: [{ key: 'default', canvases: [] }],
      calendarState: { themePreset: 'modern-genz', cellsPerCanvas: [{ '2027-01-01': [{ type: 'hide' }] }], cells: { '2027-03-08': [{ type: 'text', text: 'B' }] } },
    } } }];
    const { result } = setup({ calendar: true });
    await waitFor(() => expect(result.current.calendarTheme).toBe('modern-genz'));
    expect(result.current.calendarCells).toEqual({ '2027-01-01': [{ type: 'hide' }], '2027-03-08': [{ type: 'text', text: 'B' }] });
  });

  it('waits for the layout, then runs once, even if the layout object is replaced', async () => {
    const init: Init = { layout: null };
    const { rerender } = setup(init);
    await act(async () => {});
    expect(gets).toEqual([]);
    init.layout = { ...LAYOUT };
    rerender();
    await waitFor(() => expect(gets).toHaveLength(1));
    init.layout = { ...LAYOUT };
    rerender();
    await act(async () => {});
    expect(gets).toHaveLength(1);
  });

  it('after a save, deletes the stored photos this tab owns that the design no longer uses', async () => {
    jest.useFakeTimers();
    const a = photo('a.jpg'), b = photo('b.jpg');
    jest.mocked(getFilesForOrder).mockResolvedValueOnce(new Map([['fa', a], ['fb', b]]));
    getQueue = [{ status: 200, body: { editor_state: {
      layoutName: 'classic_4x6', surfaces: [{ key: 'default', canvases: [canvas([frame({ fileId: 'fa' })]), canvas([frame({ fileId: 'fb' })], 1)] }],
    } } }];
    const { result } = setup();
    await tick(0); await tick(0);
    // The customer removes photo b.
    act(() => result.current.setSurfaceStates([side('default', [canvas([frame({ fileId: 'fa', originalFile: a })])])]));
    act(() => result.current.setCanvases([canvas([frame({ fileId: 'fa', originalFile: a })])]));
    await tick(2_000);
    expect(puts).toHaveLength(1);
    expect(deleteFile).toHaveBeenCalledWith('fb');
    expect(deleteFile).not.toHaveBeenCalledWith('fa');
  });
});

describe('usePhotoStore', () => {
  function store(init: SurfaceState[]) {
    return renderHook(() => {
      const [surfaceStates, setSurfaceStates] = useState(init);
      const [persistDegraded, setPersistDegraded] = useState(false);
      const [storageBlocked, setStorageBlocked] = useState(false);
      const fileIdByFileRef = useRef(new WeakMap<File, string>());
      const fileSaveInFlightRef = useRef(new WeakMap<File, Promise<string>>());
      const sessionFilesRef = useRef(new Map<string, File>());
      const deletedFileIdsRef = useRef(new Set<string>());
      usePhotoStore({ orderId: 'EXT-1', surfaceStates, setSurfaceStates, fileIdByFileRef, fileSaveInFlightRef, sessionFilesRef, deletedFileIdsRef, setPersistDegraded, setStorageBlocked });
      return { surfaceStates, persistDegraded, storageBlocked, sessionFilesRef, deletedFileIdsRef, setSurfaceStates };
    });
  }

  it('stores each photo once, however often it is placed, and writes its id into the design', async () => {
    const a = photo('a.jpg');
    const sticker = photo('s.png');
    const s = side('default', [{ ...canvas([frame({ originalFile: a }), frame({ originalFile: a })]),
      overlays: [{ type: 'image', source: 'local', originalFile: sticker } as never] }]);
    const { result } = store([s]);
    await waitFor(() => expect(result.current.surfaceStates[0].canvases[0].frames.map(f => f.fileId)).toEqual(['id-a.jpg', 'id-a.jpg']));
    expect((result.current.surfaceStates[0].canvases[0].overlays[0] as { fileId?: string }).fileId).toBe('id-s.png');
    expect(jest.mocked(saveFile).mock.calls.map(c => (c[1] as File).name).sort()).toEqual(['a.jpg', 's.png']);
    expect(result.current.sessionFilesRef.current.get('id-a.jpg')).toBe(a);
  });

  it('a photo whose stored copy was deleted is stored again', async () => {
    const a = photo('a.jpg');
    const { result } = store([side('default', [canvas([frame({ originalFile: a, fileId: 'old' })])])]);
    await act(async () => {});
    expect(saveFile).not.toHaveBeenCalled();
    act(() => { result.current.deletedFileIdsRef.current.add('old'); result.current.setSurfaceStates(prev => [...prev]); });
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  });

  it('says when storage is full, or blocked', async () => {
    jest.mocked(saveFile).mockRejectedValueOnce(new FileStoreQuotaError());
    jest.mocked(getPersistenceMode).mockReturnValue('memory');
    const { result } = store([side('default', [canvas([frame({ originalFile: photo('a.jpg') })])])]);
    await waitFor(() => expect(result.current.persistDegraded).toBe(true));
    expect(result.current.storageBlocked).toBe(true);
    jest.mocked(getPersistenceMode).mockReturnValue('durable');
  });
});
