import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { MAX_RESTORE_STATE_CHARS, useServerRender } from '../useServerRender';
import { uploadFiles } from '@/lib/upload-utils';
import { rasterizeSvgUrl } from '@/lib/icon-raster';
import { RestoredPhotos } from '../restored-photos';
import type { CanvasItem, FrameState, Overlay, SurfaceState } from '../types';

jest.mock('@/lib/icon-raster', () => ({
  ...jest.requireActual('@/lib/icon-raster'),
  rasterizeSvgUrl: jest.fn(async (_url: string, _w: number, _h: number, name: string) => new File(['png'], name, { type: 'image/png' })),
}));

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

  it('an icon is drawn to a PNG at its print size, uploaded with the photos and sent by upload id', async () => {
    const src = 'https://api.iconify.design/flat-color-icons/like.svg';
    const icon = (over: Partial<Overlay> = {}) =>
      ({ type: 'image', id: 'i1', source: 'icon', src, label: 'flat-color-icons:like', x: 35, y: 35, width: 12, height: 10, rotation: 0, opacity: 1, ...over }) as Overlay;
    const a = photo('a.jpg');
    const sides = [{ key: 'default', def: { canvas: { width: 1800, height: 1200 } } }] as unknown as SurfaceState[];
    // The same icon twice at one size is drawn and uploaded once; at another size it is drawn again.
    const { result } = setup({
      surfaceStates: sides,
      canvases: [canvas([frame(a)], { overlays: [icon(), icon({ id: 'i2', x: 60 }), icon({ id: 'i3', width: 30 })] })],
    });
    await run(() => result.current.executeBatchDownload());
    // Drawn from our own copy of the icon, never from Iconify, whose rate
    // limit used to block the submit; the design still stores Iconify's address.
    const own = `${window.location.origin}/api/icons/flat-color-icons/like.svg`;
    expect(jest.mocked(rasterizeSvgUrl).mock.calls).toEqual([
      [own, 216, 120, 'icon-flat-color-icons-like.png'],
      [own, 540, 120, 'icon-flat-color-icons-like.png'],
    ]);
    const uploaded = jest.mocked(uploadFiles).mock.calls[0][0];
    expect(uploaded.map(f => f.name)).toEqual(['a.jpg', 'icon-flat-color-icons-like.png', 'icon-flat-color-icons-like.png']);
    const sent = renderBody().canvases[0].overlays;
    expect(sent.map((o: { fileId: string }) => o.fileId)).toEqual([
      'up-1-icon-flat-color-icons-like.png', 'up-1-icon-flat-color-icons-like.png', 'up-2-icon-flat-color-icons-like.png',
    ]);
    expect(sent[0]).toEqual({ type: 'image', id: 'i1', source: 'icon', src, label: 'flat-color-icons:like', x: 35, y: 35, width: 12, height: 10, rotation: 0, opacity: 1, fileId: 'up-1-icon-flat-color-icons-like.png' });
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

  it('sends the design and the id each uploaded photo goes by in it, for restore.json', async () => {
    const a = photo('a.jpg'), b = photo('b.jpg'), sticker = photo('sticker.png');
    const overlays = [
      { type: 'image', source: 'local', originalFile: sticker, src: 'blob:x', fileId: 'idb-sticker' },
      { type: 'image', id: 'i1', source: 'icon', src: 'https://api.iconify.design/flat-color-icons/like.svg', label: 'like', x: 1, y: 1, width: 5, height: 5, rotation: 0, opacity: 1 },
    ] as unknown as Overlay[];
    // a is used twice; b's browser copy has no id yet.
    const cards = [canvas([frame(a)], { overlays }), canvas([frame(a)]), canvas([frame(b)])];
    const fileIdByFileRef = { current: new WeakMap<File, string>([[a, 'idb-a'], [sticker, 'idb-sticker']]) };
    const seen: Array<string | undefined> = [];
    const buildEditorState = jest.fn((fileIdOf?: (f: File) => string | undefined) => {
      seen.push(fileIdOf?.(a), fileIdOf?.(b), fileIdOf?.(sticker));
      return { layoutName: 'classic_4x6', surfaces: [] };
    });
    const { result } = setup({ canvases: cards, buildEditorState, fileIdByFileRef });
    await run(() => result.current.executeBatchDownload());
    const { restore } = renderBody();
    expect(restore.editor_state).toEqual({ layoutName: 'classic_4x6', surfaces: [] });
    // One entry per distinct customer file, in the order it first appears; the icon's PNG is not one.
    expect(restore.files.map((f: { upload_id: string }) => f.upload_id)).toEqual(['up-0-a.jpg', 'up-1-sticker.png', 'up-2-b.jpg']);
    expect(restore.files[0].file_id).toBe('idb-a');
    expect(restore.files[1].file_id).toBe('idb-sticker');
    // The photo with no id got one, and the snapshot was built with the same ids.
    expect(restore.files[2].file_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toEqual(['idb-a', restore.files[2].file_id, 'idb-sticker']);
  });

  it('a design too large to ride the submit is left out, and the photo ids still go', async () => {
    const buildEditorState = () => ({ blob: 'x'.repeat(MAX_RESTORE_STATE_CHARS + 1) });
    const { result } = setup({ buildEditorState });
    await run(() => result.current.executeBatchDownload());
    const body = renderBody();
    expect(body.restore).not.toHaveProperty('editor_state');
    expect(body.restore.files).toHaveLength(1);
    expect(body.canvases).toHaveLength(1);
  });

  it('sends no restore block when the page gave it no design to send', async () => {
    const { result } = setup();
    await run(() => result.current.executeBatchDownload());
    expect(renderBody()).not.toHaveProperty('restore');
  });

  it('flags a submitted shortfall', async () => {
    const { result } = setup({ qtyNeeded: 5, totalUploadedCount: 3 });
    await run(() => result.current.executeBatchDownload());
    expect(renderBody().qty_shortfall_acknowledged).toBe(true);
  });
});

describe('useServerRender — what stops a submit', () => {
  it('a photo that could not be loaded blocks the submit and is named', async () => {
    const { result } = setup({ canvases: [canvas([frame(photo('a.jpg'))]), canvas([frame(null, { fileName: 'b.jpg' })])] });
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('1 photo could not be loaded (page 2, photo 1). Please add it again here before continuing so your print matches your design.');
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(result.current.isDownloading).toBe(false);
  });

  it('an added image that could not be loaded blocks the submit and is named', async () => {
    // Restored on a device whose IndexedDB lacks it: the fileId is the browser's
    // own id, which the print can't resolve, so the image would silently drop.
    const lost = { type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png' } as unknown as Overlay;
    const { result } = setup({ canvases: [canvas([frame(photo('a.jpg'))]), canvas([frame(photo('b.jpg'))], { overlays: [lost] })] });
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('1 added image could not be loaded (page 2, "logo.png"). Please add it again here before continuing so your print matches your design.');
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('lost photos and lost added images are reported together; one never stored is lost too', async () => {
    // No fileId: storage was full when it was added, so only its dead blob src survived.
    const neverStored = { type: 'image', source: 'local', src: 'blob:dead', label: 'heart.png' } as unknown as Overlay;
    const { result } = setup({ canvases: [canvas([frame(null, { fileId: 'idb-a' })], { overlays: [neverStored] })] });
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('1 photo and 1 added image could not be loaded (photo 1; "heart.png"). Please add them again here before continuing so your print matches your design.');
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('an icon that can’t be prepared blocks the submit and is named; trying again redraws it', async () => {
    const overlays = [{ type: 'image', source: 'icon', src: 'https://api.iconify.design/logos/whatsapp.svg', label: 'logos:whatsapp', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1 }] as unknown as Overlay[];
    jest.mocked(rasterizeSvgUrl).mockRejectedValueOnce(new Error('offline'));
    const { result } = setup({ canvases: [canvas([frame(photo('a.jpg'))], { overlays })] });
    await run(() => result.current.executeBatchDownload());
    expect(result.current.error).toBe('1 icon could not be prepared for print (logos:whatsapp). Check your connection and try again, or remove it.');
    expect(uploadFiles).not.toHaveBeenCalled();
    await run(() => result.current.executeBatchDownload());
    expect(rasterizeSvgUrl).toHaveBeenCalledTimes(2);
    expect(renderBody().canvases[0].overlays[0].fileId).toBe('up-1-icon-logos-whatsapp.png');
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

describe('useServerRender — photos restored from an earlier order', () => {
  // On screen a restored photo is a preview of an original our server holds.
  const restored = (name: string, uploadId: string, fileId: string) => {
    const photos = new RestoredPhotos();
    const preview = photo(name);
    photos.addStandIn(preview, { uploadId, width: 3000, height: 4000, fileId });
    return { photos, preview };
  };

  it('is sent by the upload our server holds, and its preview is never uploaded', async () => {
    const { photos, preview } = restored('a.jpg', 'server-upload-1', 'f-1');
    const own = photo('new.jpg');
    const fileIds = { current: new WeakMap<File, string>([[preview, 'f-1'], [own, 'f-2']]) };
    const { result } = setup({
      canvases: [canvas([frame(preview)]), canvas([frame(own)])],
      restoredPhotos: photos, fileIdByFileRef: fileIds, buildEditorState: () => ({ surfaces: [] }),
    });
    await run(() => result.current.handleSubmitDesign());
    expect(jest.mocked(uploadFiles).mock.calls[0][0]).toEqual([own]);
    const body = renderBody();
    expect(body.canvases[0].frames[0].upload_id).toBe('server-upload-1');
    expect(body.canvases[1].frames[0].upload_id).toBe('up-0-new.jpg');
    expect(body.restore.files).toEqual([
      { file_id: 'f-1', upload_id: 'server-upload-1' },
      { file_id: 'f-2', upload_id: 'up-0-new.jpg' },
    ]);
  });

  it('a design of restored photos alone submits with nothing to upload', async () => {
    const { photos, preview } = restored('a.jpg', 'server-upload-1', 'f-1');
    const { result } = setup({ canvases: [canvas([frame(preview)])], restoredPhotos: photos });
    await run(() => result.current.handleSubmitDesign());
    expect(jest.mocked(uploadFiles).mock.calls[0][0]).toEqual([]);
    expect(renderBody().canvases[0].frames[0].upload_id).toBe('server-upload-1');
    expect(result.current.error).toBeNull();
  });

  it('a restored added image is sent by its server upload too', async () => {
    const { photos, preview } = restored('sticker.png', 'server-upload-9', 's-1');
    const overlay = { type: 'image', id: 1, src: 'blob:x', source: 'local', originalFile: preview, fileId: 's-1', label: '', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1 } as Overlay;
    const { result } = setup({ canvases: [canvas([frame(photo('a.jpg'))], { overlays: [overlay] })], restoredPhotos: photos });
    await run(() => result.current.handleSubmitDesign());
    expect(renderBody().canvases[0].overlays[0]).toMatchObject({ fileId: 'server-upload-9', src: null });
  });

  it('a preview with no upload on record stops the submit: it is never uploaded in the photo\'s place', async () => {
    const photos = new RestoredPhotos();
    const preview = photo('a.jpg');
    photos.addStandIn(preview, { uploadId: '', width: 0, height: 0, fileId: 'f-1' });
    const { result } = setup({ canvases: [canvas([frame(preview)])], restoredPhotos: photos });
    await run(() => result.current.handleSubmitDesign());
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(calls.some(c => c.url.endsWith('/editor/render'))).toBe(false);
    expect(result.current.error).toMatch(/not ready yet/);
  });

  it('photos still arriving hold the submit with a plain message, not "lost"', async () => {
    const { result } = setup({
      canvases: [canvas([frame(null, { fileId: 'f-1', fileName: 'a.jpg' })])],
      restoredPhotoStatus: new Map([['f-1', 'arriving']]),
    });
    await run(() => result.current.handleSubmitDesign());
    expect(result.current.error).toBe('Your photos are still loading. Please wait a moment and try again.');
    expect(calls.some(c => c.url.endsWith('/editor/render'))).toBe(false);
  });

  it('a restored photo that could not be loaded is named like any missing photo', async () => {
    const { result } = setup({
      canvases: [canvas([frame(null, { fileId: 'f-1', fileName: 'a.jpg' })])],
      restoredPhotoStatus: new Map([['f-1', 'failed']]),
    });
    await run(() => result.current.handleSubmitDesign());
    expect(result.current.error).toMatch(/1 photo could not be loaded/);
  });
});
