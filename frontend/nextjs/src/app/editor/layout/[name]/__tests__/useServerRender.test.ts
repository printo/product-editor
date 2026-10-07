import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useServerRender } from '../useServerRender';
import { uploadFiles } from '@/lib/upload-utils';
import type { CanvasItem, FrameState, Overlay, SurfaceState } from '../types';

jest.mock('@/lib/upload-utils', () => ({
  ...jest.requireActual('@/lib/upload-utils'),
  uploadFiles: jest.fn(async (files: File[], _b: string, _h: unknown, onProgress: (d: number, t: number) => void) => {
    onProgress(files.length, files.length);
    return new Map(files.map((f, i) => [f, { uploadId: `up-${i}-${f.name}` }]));
  }),
}));

const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg', lastModified: 1 });
const frame = (file: File | null, over: Partial<FrameState> = {}): FrameState =>
  ({ id: 0, originalFile: file, offset: { x: 3, y: -2 }, scale: 1.5, rotation: 90, fitMode: 'cover', fillStyle: 'blur', caption: ' Hi ', captionEnabled: true, ...over }) as FrameState;
const canvas = (frames: FrameState[], over: Partial<CanvasItem> = {}): CanvasItem =>
  ({ id: 0, frames, overlays: [], bgColor: '#123456', paperColor: '#fefefe', dataUrl: null, ...over });

type Props = Parameters<typeof useServerRender>[0];
type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let statuses: Array<Record<string, unknown>> = [];
function serve(render: { ok?: boolean; body?: unknown } = {}) {
  calls = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/editor/render')) {
      return { ok: render.ok ?? true, status: render.ok === false ? 400 : 202, json: async () => render.body ?? { job_id: 'job-1', order_id: 'EXT-SERVER' } };
    }
    return { ok: true, json: async () => statuses.shift() ?? { status: 'processing' } };
  }) as unknown as typeof fetch;
}
const renderBody = () => JSON.parse(calls.find(c => c.url.endsWith('/editor/render'))!.init!.body as string);

function setup(over: Partial<Props> = {}) {
  return renderHook(() => {
    const [isDownloading, setIsDownloading] = useState(false);
    const [showDownloadModal, setShowDownloadModal] = useState(true);
    const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const r = useServerRender({
      layout: { name: 'classic_4x6', frameCaptionsEnabled: false }, layoutName: 'classic_4x6', embedToken: 'tok', parentOrigin: 'https://printo.in',
      apiBase: '/api/embed/proxy', getAuthHeaders: () => ({}), orderId: 'PE-LOCAL',
      surfaceStates: [{ key: 'default' } as SurfaceState], canvases: [canvas([frame(photo('a.jpg'))])], activeSurfaceKey: 'default',
      isCalendarProduct: false, calendarTheme: 'modern-minimalist', calendarType: 'english', genzPalette: undefined, calendarCells: {},
      isBookProduct: false, bookPageCount: 0, qtyNeeded: 0, totalUploadedCount: 1,
      setIsDownloading, setShowDownloadModal, setRenderProgress, setError, ...over,
    });
    return { ...r, isDownloading, showDownloadModal, renderProgress, error };
  });
}
const run = async (fn: () => unknown) => { await act(async () => { await fn(); }); };

// Request and guard tests run as the embed, which returns once the job is
// accepted; the dashboard polls for up to 10 minutes, so its tests fake timers.
let post: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks(); statuses = []; serve();
  post = jest.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
});
afterEach(() => post.mockRestore());

describe('useServerRender — the render request', () => {
  it('uploads each photo once, then submits every frame with its upload and placement', async () => {
    const a = photo('a.jpg');
    const { result } = setup({ canvases: [canvas([frame(a)]), canvas([frame(a, { offset: { x: 0, y: 0 } })])] });
    await run(() => result.current.executeBatchDownload());
    expect(jest.mocked(uploadFiles).mock.calls[0][0]).toEqual([a]);
    expect(jest.mocked(uploadFiles).mock.calls[0][4]).toBe('PE-LOCAL');
    const body = renderBody();
    expect(body).toMatchObject({ layout_name: 'classic_4x6', order_id: 'PE-LOCAL', qty_shortfall_acknowledged: false });
    expect(body.canvases[0]).toEqual({
      canvas_index: 0, surface_key: 'default', bg_color: '#123456', paper_color: '#fefefe', overlays: [],
      frames: [{ frame_index: 0, upload_id: 'up-0-a.jpg', offset_x: 3, offset_y: -2, scale: 1.5, rotation: 90, fit_mode: 'cover', fill_style: 'blur', caption: null, caption_enabled: false }],
    });
    expect(body.canvases[1].frames[0]).toMatchObject({ upload_id: 'up-0-a.jpg', offset_x: 0 });
  });

  it('sends a caption only for a template that has captions', async () => {
    const { result } = setup({ layout: { name: 'x', frameCaptionsEnabled: true } });
    await run(() => result.current.handleSubmitDesign());
    expect(renderBody().canvases[0].frames[0]).toMatchObject({ caption: 'Hi', caption_enabled: true });
  });

  it('a blank side of a multi-surface product is sent blank, under its own key, never dropped', async () => {
    const sides = [
      { key: 'front', def: { frames: [{}] }, canvases: [canvas([frame(photo('f.jpg'))])], globalFitMode: 'cover' },
      { key: 'back', def: { frames: [{}, {}] }, canvases: [], globalFitMode: 'contain' },
    ] as unknown as SurfaceState[];
    const { result } = setup({ surfaceStates: sides });
    await run(() => result.current.executeBatchDownload());
    const body = renderBody();
    expect(body.canvases.map((c: { surface_key: string }) => c.surface_key)).toEqual(['front', 'back']);
    expect(body.canvases[1].frames.map((f: { upload_id: unknown; fit_mode: string }) => [f.upload_id, f.fit_mode])).toEqual([[null, 'contain'], [null, 'contain']]);
  });

  it('a customer’s own sticker is uploaded with the photos and sent by upload id', async () => {
    const sticker = photo('sticker.png');
    const overlays = [
      { type: 'image', source: 'local', originalFile: sticker, src: 'blob:x', fileId: 'idb-1' },
      { type: 'image', source: 'clipart', src: '/clipart/star.svg' },
      { type: 'text', text: 'Hello' },
    ] as unknown as Overlay[];
    const { result } = setup({ canvases: [canvas([frame(photo('a.jpg'))], { overlays })] });
    await run(() => result.current.executeBatchDownload());
    const sent = renderBody().canvases[0].overlays;
    expect(sent[0]).toEqual({ type: 'image', source: 'local', src: null, fileId: 'up-1-sticker.png' });
    expect(sent[1]).toMatchObject({ src: '/clipart/star.svg', fileId: null });
    expect(sent[2]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('a calendar sends its choices and day entries; a book its page count', async () => {
    const cells = { '2027-03-08': [{ type: 'text', text: 'B' }] };
    const { result } = setup({ isCalendarProduct: true, calendarTheme: 'modern-genz', calendarType: 'financial', genzPalette: 'neon', calendarCells: cells });
    await run(() => result.current.executeBatchDownload());
    expect(renderBody().canvases[0].calendar).toEqual({ themePreset: 'modern-genz', calendarType: 'financial', genzPalette: 'neon', cells });
    serve();
    const book = setup({ isBookProduct: true, bookPageCount: 12 });
    await run(() => book.result.current.executeBatchDownload());
    expect(renderBody().canvases[0].book).toEqual({ pageCount: 12 });
  });

  it('flags a submitted shortfall', async () => {
    const { result } = setup({ qtyNeeded: 5, totalUploadedCount: 3 });
    await run(() => result.current.executeBatchDownload());
    expect(renderBody().qty_shortfall_acknowledged).toBe(true);
  });
});

describe('useServerRender — what stops a submit', () => {
  it('a photo that could not be recovered blocks the submit and is named', async () => {
    const { result } = setup({ canvases: [canvas([frame(photo('a.jpg'))]), canvas([frame(null, { fileName: 'b.jpg' })])] });
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('1 photo could not be recovered (page 2, photo 1). Please re-upload it before continuing so your print matches your design.');
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(result.current.isDownloading).toBe(false);
  });

  it('no photos at all, or a file that can’t print, stops before uploading', async () => {
    const empty = setup({ canvases: [canvas([frame(null)])] });
    await run(() => empty.result.current.executeBatchDownload());
    expect(empty.result.current.error).toBe('No files to upload for server render.');
    const svg = setup({ canvases: [canvas([frame(new File(['x'], 'logo.svg'))])] });
    await run(() => svg.result.current.executeBatchDownload());
    expect(svg.result.current.error).toMatch(/logo\.svg/);
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('nothing to download says so; Save & Continue with nothing does nothing', async () => {
    const { result } = setup({ canvases: [] });
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('No canvases to download.');
    await run(() => result.current.handleSubmitDesign());
    expect(calls).toEqual([]);
  });

  it('a refused render says why and clears the busy state', async () => {
    serve({ ok: false, body: { detail: 'Too many photos for this order.' } });
    const { result } = setup();
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('Too many photos for this order.');
    expect(result.current).toMatchObject({ isDownloading: false, showDownloadModal: false, serverRenderLabel: null, renderProgress: null });
  });
});

describe('useServerRender — after submitting', () => {
  it('embed: tells the storefront, only at its own origin, and shows the submitted panel', async () => {
    const { result } = setup({ parentOrigin: 'https://alpha.printo.in' });
    await run(() => result.current.handleSubmitDesign());
    expect(post).toHaveBeenCalledWith({ type: 'pe:render_job', jobId: 'job-1', orderID: 'EXT-SERVER' }, 'https://alpha.printo.in');
    expect(result.current).toMatchObject({ submitted: true, submittedJobId: 'job-1', isDownloading: false });
    expect(calls.map(c => c.url)).toEqual(['/api/embed/proxy/editor/render']);
  });

  it('dashboard: polls the job, shows the queue honestly, then downloads the ZIP with the uploads choice', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const clicks: Array<{ href: string; download: string }> = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute('href') || '', download: this.download });
    });
    statuses = [{ status: 'queued', estimated_wait_seconds: 90 }, { status: 'completed' }];
    const { result } = setup({ embedToken: null, apiBase: '/api/internal/proxy' });
    act(() => { result.current.setIncludeUploads(true); result.current.includeUploadsRef.current = true; });
    let done!: Promise<unknown>;
    act(() => { done = result.current.executeBatchDownload(); });
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
    expect(result.current.serverRenderLabel).toMatch(/^Queued — about /);
    await act(async () => { await jest.advanceTimersByTimeAsync(3000); await done; });
    expect(calls.filter(c => c.url.startsWith('/api/internal/proxy/render-status/job-1/'))).toHaveLength(2);
    expect(clicks).toEqual([{ href: '/api/internal/proxy/jobs/job-1/download/?include_uploads=1', download: 'classic_4x6.zip' }]);
    expect(result.current.isDownloading).toBe(false);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('dashboard: a failed render is reported', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    statuses = [{ status: 'failed', error: 'Mask missing' }];
    const { result } = setup({ embedToken: null, apiBase: '/api/internal/proxy' });
    let done!: Promise<unknown>;
    act(() => { done = result.current.executeBatchDownload(); });
    await act(async () => { await jest.advanceTimersByTimeAsync(2000); await done; });
    expect(result.current.error).toBe('Mask missing');
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
});
