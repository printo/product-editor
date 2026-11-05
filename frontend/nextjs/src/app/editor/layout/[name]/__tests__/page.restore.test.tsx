/**
 * The whole editor page restoring a design from the copy the embedding
 * company keeps: the page is opened with `restore_order_id` on its address, a
 * stand-in for the embedding page answers `pe:restore_request`, and FakeBackend
 * plays our server (upload by link, photo previews, the render). Same stubs as
 * the characterization suite; timers are real.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CALENDAR_NO_HOLIDAYS, FakeBackend, LAYOUT_NAME, makePhoto, renderEditor, setEditorUrl } from './editor-page-harness';

jest.setTimeout(30000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
let mockParams = { name: 'test_4x6' };
jest.mock('next/navigation', () => ({
  useParams: () => mockParams,
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));
let mockSession: { data: unknown; status: string } = { data: null, status: 'unauthenticated' };
jest.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signOut: jest.fn(),
  SessionProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/app/editor/layout/[name]/fabric-renderer', () => ({
  renderCanvas: jest.fn(async () => 'data:image/png;base64,UFJFVklFVw=='),
  calculateSmartCropOffsets: jest.fn(async () => ({ x: 0, y: 0 })),
}));
jest.mock('@/app/editor/layout/[name]/CanvasEditorModal', () => ({ CanvasEditorModal: () => null }));
jest.mock('@/components/GoogleFontLinks', () => ({
  ...jest.requireActual('@/components/GoogleFontLinks'),
  GoogleFontLinks: () => null,
}));
const mockRememberImageSize = jest.fn();
jest.mock('@/lib/image-utils', () => ({
  getImageMetadata: jest.fn(async () => ({
    width: 1200, height: 1800, orientation: 1,
    element: { naturalWidth: 1200, naturalHeight: 1800, width: 1200, height: 1800 },
  })),
  getImageSize: jest.fn(async () => ({ width: 1200, height: 1800 })),
  rememberImageSize: (...args: unknown[]) => mockRememberImageSize(...args),
  detectJpegColorSpace: jest.fn(async () => null),
  isImageComplete: jest.fn(async () => true),
}));
jest.mock('@/lib/ml-orientation', () => ({ detectFileOrientation: jest.fn(async () => 'no-rotate') }));
jest.mock('@/lib/heic-convert', () => ({
  convertHeicFileIfNeeded: jest.fn(async (f: File) => f),
  convertAndPartitionFiles: jest.fn(async (files: File[]) => ({ accepted: files, warning: null })),
  isHeicFile: () => false,
  createServerHeicConverter: () => async (f: File) => f,
}));
jest.mock('@/lib/pdf-import', () => ({ pdfDerivedFiles: new WeakSet<File>() }));
jest.mock('@/components/use-pdf-page-import', () => ({
  usePdfPageImport: () => ({ expandPdfPages: async (files: File[]) => files, pdfPickerElement: null }),
}));
jest.mock('@/lib/zip-utils', () => ({
  createZipFromDataUrls: jest.fn(async () => new Blob(['zip'])),
  downloadBlob: jest.fn(),
}));

const ORDER_ID = 'NEW-ORDER-2';
const OLD_ORDER = 'OLD-ORDER-1';
const LINK = (n: number) => `https://files.example.com/user/photo-${n}.jpg`;

const savedFrame = (fileId: string, name: string, over: Record<string, unknown> = {}) => ({
  id: 0, originalFile: null, fileId, fileName: name, fileSize: 4_000_000,
  offset: { x: 12, y: -4 }, scale: 1.4, rotation: 90, fitMode: 'cover', fillStyle: 'blur', ...over,
});
const savedCard = (id: number, fileId: string, name: string, over: Record<string, unknown> = {}) => ({
  id, frames: [savedFrame(fileId, name, over)], overlays: [], bgColor: '#ffffff', paperColor: '#ffffff', dataUrl: null,
});
/** The design as the earlier order's restore.json holds it. */
const earlierDesign = (cards = [savedCard(0, 'f-1', 'a.jpg'), savedCard(1, 'f-2', 'b.jpg')]) => ({
  layoutName: LAYOUT_NAME, activeSurfaceKey: 'default', template: null,
  surfaces: [{ key: 'default', canvases: cards, globalFitMode: 'cover' }],
});
const earlierPhotos = [
  { file_id: 'f-1', name: 'a.jpg', url: LINK(1) },
  { file_id: 'f-2', name: 'b.jpg', url: LINK(2) },
];

type Posted = { message: Record<string, any>; targetOrigin: string };

/** Stands in for the page that embeds the editor: records what the editor
 *  posts to it and answers `pe:restore_request` with `answer` after `delayMs`. */
function embedInPage(answer: (request: Record<string, any>) => Record<string, unknown> | null, delayMs = 20) {
  const posted: Posted[] = [];
  const parent = {
    postMessage(message: Record<string, any>, targetOrigin: string) {
      posted.push({ message, targetOrigin });
      if (message?.type !== 'pe:restore_request') return;
      const data = answer(message);
      if (!data) return;
      setTimeout(() => {
        act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: parent as unknown as Window, origin: 'https://shop.example.com' })); });
      }, delayMs);
    },
  };
  const original = Object.getOwnPropertyDescriptor(window, 'parent');
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
  const restore = () => {
    if (original) Object.defineProperty(window, 'parent', original);
    else delete (window as unknown as { parent?: unknown }).parent;
  };
  const ofType = (type: string) => posted.filter(p => p.message?.type === type);
  return { posted, ofType, restore };
}

const cards = () => screen.queryAllByRole('button', { name: /^Edit canvas \d+/ });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type SavedDesign = { restoredFrom?: string; calendarState?: { cells?: Record<string, Array<{ type: string; uploadId?: string; text?: string }>> }; surfaces: Array<{ canvases: Array<{ frames: Array<{ fileId?: string; rotation?: number; scale?: number; originalFile: unknown }> }> }> };

let backend: FakeBackend;
let page: ReturnType<typeof embedInPage> | null = null;
const lastPut = () => (backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT').pop()?.body as { editor_state: SavedDesign } | undefined)?.editor_state;

beforeEach(() => {
  backend = new FakeBackend();
  backend.editorInit = { order_id: ORDER_ID };
  global.fetch = jest.fn(backend.fetch) as unknown as typeof fetch;
  mockSession = { data: null, status: 'unauthenticated' };
  mockParams = { name: LAYOUT_NAME };
  mockRememberImageSize.mockClear();
  localStorage.clear();
});
afterEach(() => {
  page?.restore();
  page = null;
  jest.restoreAllMocks();
});

const restoreReply = (over: Record<string, unknown> = {}) => (request: Record<string, any>) => ({
  type: 'pe:restore_data', orderId: request.orderId, schema_version: 1,
  editor_state: earlierDesign(), photos: earlierPhotos, ...over,
});

async function submit() {
  const user = userEvent.setup();
  const save = screen.getByRole('button', { name: 'Save and continue' }) as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false));
  await user.click(save);
  await screen.findByText('Ready to Submit?');
  await user.click(screen.getAllByRole('checkbox').pop()!);
  await user.click(screen.getByRole('button', { name: 'Yes, Proceed' }));
}

describe('editor page — restoring an earlier order from the embedding page', () => {
  it('asks the page, shows the earlier design, loads each photo through our server, and submits by the server\'s copies', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    page = embedInPage(restoreReply(), 2500);
    renderEditor();

    // The page is asked once, for this session's order and the earlier one,
    // at its own origin.
    await waitFor(() => expect(page!.ofType('pe:restore_request')).toHaveLength(1));
    const asked = page.ofType('pe:restore_request')[0];
    expect(asked.message).toEqual({ type: 'pe:restore_request', orderId: ORDER_ID, restoreOrderId: OLD_ORDER });
    expect(asked.targetOrigin).toBe('https://printo.in');
    // Nothing of the reference went to our server.
    for (const call of backend.calls) {
      expect(`${call.path}?${call.query}`).not.toContain(OLD_ORDER);
      expect(JSON.stringify(call.body ?? '')).not.toContain(OLD_ORDER);
    }

    // While the page has not answered, nothing is saved: an empty design must
    // never be written over the one about to arrive.
    await sleep(2300);
    expect(backend.callsTo('canvas-state/', 'PUT')).toHaveLength(0);

    // Both cards come back, and each photo is fetched by our server from the
    // page's link, then read back as a preview. The browser never loads the link.
    await waitFor(() => expect(cards()).toHaveLength(2));
    await waitFor(() => expect(backend.callsTo('photos/', 'GET')).toHaveLength(2));
    const fetched = backend.callsTo('upload/from-url', 'POST');
    expect(fetched.map(c => (c.body as { url: string }).url)).toEqual([LINK(1), LINK(2)]);
    expect(fetched.map(c => (c.body as { filename: string }).filename)).toEqual(['a.jpg', 'b.jpg']);
    for (const c of fetched) expect(c.headers['x-embed-token']).toBe('test-embed-token');
    expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u).includes('files.example.com'))).toBe(false);
    // Each preview is recorded at the original's size, so the low-resolution
    // warning judges what will print.
    expect(mockRememberImageSize.mock.calls.map(c => c.slice(1))).toEqual([[3000, 4000], [3000, 4000]]);
    await waitFor(() => expect(screen.queryByText('Loading photo…')).toBeNull());
    expect(screen.queryByText(/not on this device/)).toBeNull();

    // The page is told how it went.
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0]).toEqual({
      targetOrigin: 'https://printo.in',
      message: { type: 'pe:restore_result', orderId: ORDER_ID, restoreOrderId: OLD_ORDER, status: 'restored', mode: 'design', photos: { total: 2, loaded: 2, failed: 0 } },
    });

    // The design is now this order's own: saved with the earlier crop and
    // turn, the photos by id only, and a note of where it came from.
    await waitFor(() => expect(lastPut()?.surfaces[0].canvases).toHaveLength(2), { timeout: 6000 });
    const saved = lastPut()!;
    expect(saved.restoredFrom).toBe(OLD_ORDER);
    expect(saved.surfaces[0].canvases.map(c => c.frames[0])).toEqual([
      expect.objectContaining({ fileId: 'f-1', rotation: 90, scale: 1.4, originalFile: null }),
      expect.objectContaining({ fileId: 'f-2', rotation: 90, scale: 1.4, originalFile: null }),
    ]);
    expect(JSON.stringify(saved)).not.toContain('files.example.com');

    // Save & Continue: nothing is uploaded; every photo goes by the copy our
    // server fetched.
    await submit();
    await waitFor(() => expect(backend.callsTo('editor/render', 'POST')).toHaveLength(1), { timeout: 10000 });
    expect(backend.callsTo('upload/init', 'POST')).toHaveLength(0);
    const body = backend.callsTo('editor/render', 'POST')[0].body as {
      canvases: Array<{ frames: Array<{ upload_id: string; rotation: number; offset_x: number }> }>;
      restore: { files: Array<{ file_id: string; upload_id: string }> };
    };
    const serverIds = ['ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002'];
    expect(body.canvases.map(c => c.frames[0].upload_id)).toEqual(serverIds);
    expect(body.canvases[0].frames[0]).toEqual(expect.objectContaining({ rotation: 90, offset_x: 12 }));
    expect(body.restore.files).toEqual([
      { file_id: 'f-1', upload_id: serverIds[0] },
      { file_id: 'f-2', upload_id: serverIds[1] },
    ]);
    expect(backend.unexpected).toEqual([]);
  });

  it('opening a restored card loads that card\'s full-size photo first', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    page = embedInPage(restoreReply());
    renderEditor();
    await waitFor(() => expect(backend.callsTo('photos/', 'GET')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Loading photo…')).toBeNull());

    await userEvent.setup().click(cards()[1]);
    await waitFor(() => expect(backend.callsTo('photos/', 'GET').filter(c => c.query.get('size') === 'full')).toHaveLength(1));
    const full = backend.callsTo('photos/', 'GET').find(c => c.query.get('size') === 'full')!;
    expect(full.path).toBe('photos/ffffffff-0000-4000-8000-000000000002/preview');
  });

  it('a photo our server could not fetch says so on its card, a tap tries again, and the page hears "partial"', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    backend.failingPhotoLinks.add(LINK(2));
    page = embedInPage(restoreReply());
    renderEditor();

    const retry = await screen.findByRole('button', { name: "Couldn't load this photo. Tap to try again." }, { timeout: 8000 });
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({
      status: 'partial', photos: { total: 2, loaded: 1, failed: 1 },
    }));
    // Tried twice before giving up.
    expect(backend.callsTo('upload/from-url', 'POST').filter(c => (c.body as { url: string }).url === LINK(2))).toHaveLength(2);

    // The design cannot go to print with that photo missing.
    await submit();
    await screen.findByText(/1 photo could not be loaded/);
    expect(backend.callsTo('editor/render', 'POST')).toHaveLength(0);

    backend.failingPhotoLinks.clear();
    await userEvent.setup().click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Couldn't load this photo/ })).toBeNull());
    expect(backend.callsTo('photos/', 'GET')).toHaveLength(2);
  });

  it('this order\'s own saved design wins; the page is asked only for the photos it names', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    // Saved on an earlier visit to this same reorder, after the customer
    // turned the first photo and removed the second card.
    backend.savedEditorState = { ...earlierDesign([savedCard(0, 'f-1', 'a.jpg', { rotation: 180 })]), restoredFrom: OLD_ORDER };
    page = embedInPage(restoreReply());
    renderEditor();

    await waitFor(() => expect(backend.callsTo('photos/', 'GET')).toHaveLength(1));
    expect(cards()).toHaveLength(1);
    expect(backend.callsTo('upload/from-url', 'POST').map(c => (c.body as { url: string }).url)).toEqual([LINK(1)]);
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'restored', photos: { total: 1, loaded: 1, failed: 0 } }));

    await submit();
    await waitFor(() => expect(backend.callsTo('editor/render', 'POST')).toHaveLength(1), { timeout: 10000 });
    const body = backend.callsTo('editor/render', 'POST')[0].body as { canvases: Array<{ frames: Array<{ rotation: number }> }> };
    expect(body.canvases).toHaveLength(1);
    expect(body.canvases[0].frames[0].rotation).toBe(180);
  });

  it('a design the customer cleared after restoring is not brought back by a refresh', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    backend.savedEditorState = { ...earlierDesign([]), restoredFrom: OLD_ORDER };
    page = embedInPage(restoreReply());
    renderEditor();
    await waitFor(() => expect(backend.callsTo('canvas-state/', 'GET')).toHaveLength(1));
    await sleep(300);
    expect(page.ofType('pe:restore_request')).toHaveLength(0);
    expect(cards()).toHaveLength(0);
  });

  it('when the page declines, the editor opens empty and works as usual', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    page = embedInPage(request => ({ type: 'pe:restore_data', orderId: request.orderId, error: 'not_found' }));
    renderEditor();

    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'none', reason: 'declined' }));
    expect(backend.callsTo('upload/from-url', 'POST')).toHaveLength(0);

    const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    await userEvent.setup().upload(input, [makePhoto('fresh.jpg')]);
    await waitFor(() => expect(cards()).toHaveLength(1));
    await waitFor(() => expect(lastPut()?.surfaces[0].canvases).toHaveLength(1), { timeout: 6000 });
    expect(lastPut()!.restoredFrom).toBeUndefined();
  });

  it('an order from before designs were kept: its photos are placed again, in order, with a notice', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    // No design and no photo ids: all the page has is the files.
    page = embedInPage(restoreReply({ editor_state: null, photos: [{ name: 'a.jpg', url: LINK(1) }, { name: 'b.jpg', url: `${LINK(2)}?sig=abc` }] }));
    renderEditor();

    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 8000 });
    await screen.findByText(/We brought back your photos from last time\. Cropping may look different, and text or stickers were not saved\./);
    expect(backend.callsTo('upload/from-url', 'POST').map(c => (c.body as { filename: string }).filename)).toEqual(['a.jpg', 'b.jpg']);
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({
      status: 'restored', mode: 'photos', photos: { total: 2, loaded: 2, failed: 0 },
    }));

    // Saved as this order's design, each photo under an id made from its
    // link, so a refresh can match them again. Not stored in the browser:
    // a stored copy would have been given a new random id.
    await waitFor(() => expect(lastPut()?.surfaces[0].canvases).toHaveLength(2), { timeout: 6000 });
    await waitFor(() => expect(lastPut()!.surfaces[0].canvases.every(c => /^u-[0-9a-f]{16}$/.test(c.frames[0].fileId ?? ''))).toBe(true), { timeout: 6000 });
    expect(lastPut()!.restoredFrom).toBe(OLD_ORDER);

    await submit();
    await waitFor(() => expect(backend.callsTo('editor/render', 'POST')).toHaveLength(1), { timeout: 10000 });
    expect(backend.callsTo('upload/init', 'POST')).toHaveLength(0);
    const body = backend.callsTo('editor/render', 'POST')[0].body as { canvases: Array<{ frames: Array<{ upload_id: string }> }> };
    expect(body.canvases.map(c => c.frames[0].upload_id)).toEqual([
      'ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002',
    ]);
    expect(backend.unexpected).toEqual([]);
  });

  it('a refresh after that asks again and matches the photos by the same link-made ids', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    const idFor = (await import('../restore-messages')).fileIdFromLink;
    backend.savedEditorState = {
      ...earlierDesign([savedCard(0, idFor(new URL(LINK(1))), 'a.jpg'), savedCard(1, idFor(new URL(LINK(2))), 'b.jpg')]),
      restoredFrom: OLD_ORDER,
    };
    page = embedInPage(restoreReply({ editor_state: null, photos: [{ name: 'a.jpg', url: `${LINK(1)}?sig=new` }, { name: 'b.jpg', url: LINK(2) }] }));
    renderEditor();
    await waitFor(() => expect(backend.callsTo('photos/', 'GET')).toHaveLength(2));
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'restored', mode: 'design' }));
    expect(screen.queryByText(/not on this device/)).toBeNull();
    // The notice belongs to the first opening, not to every refresh.
    expect(screen.queryByText(/We brought back your photos/)).toBeNull();
  });

  it('a product saved since the order: the design comes back, with a notice to look it over', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    backend.editorInit = { order_id: ORDER_ID, layout_version: 5 };
    page = embedInPage(restoreReply({ layout_version: 3 }));
    renderEditor();
    await waitFor(() => expect(cards()).toHaveLength(2));
    await screen.findByText('This product has changed a little since your last order. Your photos may sit differently. Please look at each one before you continue.');
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'restored', mode: 'design' }));
    // Dismissible.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/This product has changed a little/)).toBeNull();
  });

  it('the same version says nothing', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    backend.editorInit = { order_id: ORDER_ID, layout_version: 3 };
    page = embedInPage(restoreReply({ layout_version: 3 }));
    renderEditor();
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(cards()).toHaveLength(2);
    expect(screen.queryByText(/This product has changed a little/)).toBeNull();
  });

  it('a design the product no longer fits: the photos are placed again, with the changed-product notice', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    // Made when each card held two photos; the product now has one window.
    const twoPerCard = earlierDesign([{
      ...savedCard(0, 'f-1', 'a.jpg'),
      frames: [savedFrame('f-1', 'a.jpg'), { ...savedFrame('f-2', 'b.jpg'), id: 1 }],
    }]);
    page = embedInPage(restoreReply({ editor_state: twoPerCard }));
    renderEditor();
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 8000 });
    await screen.findByText(/This product has changed a little since your last order/);
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'restored', mode: 'photos' }));
    // Placed afresh: the earlier turn and zoom are not carried onto a different window.
    await waitFor(() => expect(lastPut()?.surfaces[0].canvases).toHaveLength(2), { timeout: 6000 });
    expect(lastPut()!.surfaces[0].canvases.map(c => c.frames[0].scale)).toEqual([1, 1]);
  });

  it('a design made for another layout: the photos are placed on this one, with the notice', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    page = embedInPage(restoreReply({ editor_state: { ...earlierDesign(), layoutName: 'some_other_layout' } }));
    renderEditor();
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 8000 });
    await screen.findByText(/This product has changed a little since your last order/);
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1));
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'restored', mode: 'photos' }));
  });

  it('when none of the photos can be fetched, the editor opens empty and says so to the page', async () => {
    setEditorUrl('embed', undefined, { restore_order_id: OLD_ORDER });
    backend.failingPhotoLinks.add(LINK(1));
    backend.failingPhotoLinks.add(LINK(2));
    page = embedInPage(restoreReply({ editor_state: null }));
    renderEditor();
    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1), { timeout: 8000 });
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({ status: 'none', mode: 'photos', photos: { total: 2, loaded: 0, failed: 2 } }));
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText(/We brought back your photos/)).toBeNull();
    expect(screen.queryByText(/Bringing back your photos/)).toBeNull();
  });

  it('without restore_order_id on the address the page is never asked', async () => {
    setEditorUrl('embed');
    page = embedInPage(restoreReply());
    renderEditor();
    await waitFor(() => expect(backend.callsTo('canvas-state/', 'GET')).toHaveLength(1));
    await sleep(300);
    expect(page.posted).toEqual([]);
  });

  it('the dashboard ignores restore_order_id', async () => {
    mockSession = { data: { user: { id: 'u1', name: 'Ops', email: 'ops@printo.in', role: 'user' }, accessToken: 'a' }, status: 'authenticated' };
    setEditorUrl('dashboard', 'PE-AAAA1111', { restore_order_id: OLD_ORDER });
    backend.editorInit = {};
    page = embedInPage(restoreReply());
    renderEditor();
    await waitFor(() => expect(backend.callsTo('canvas-state/', 'GET')).toHaveLength(1));
    await sleep(300);
    expect(page.posted).toEqual([]);
  });

  it('a calendar: a photo placed on a date is fetched again and the date is pointed at the new copy', async () => {
    mockParams = { name: 'test_calendar' };
    backend.layout = CALENDAR_NO_HOLIDAYS as unknown as Record<string, unknown>;
    window.history.replaceState(null, '', `/editor/layout/test_calendar?token=test-embed-token&restore_order_id=${OLD_ORDER}`);
    // The earlier design names the date's photo by an upload of the earlier
    // order, which our server no longer holds.
    const design = {
      ...earlierDesign([savedCard(0, 'f-1', 'a.jpg')]),
      layoutName: 'test_calendar',
      calendarState: {
        themePreset: 'modern-minimalist', calendarType: 'english',
        cells: { '2026-01-05': [{ type: 'event', text: 'Party' }, { type: 'image', uploadId: 'old-upload-1' }] },
      },
    };
    page = embedInPage(restoreReply({
      editor_state: design,
      photos: [
        { file_id: 'f-1', name: 'a.jpg', url: LINK(1), kind: 'frame' },
        { file_id: 'old-upload-1', name: 'date.jpg', url: LINK(3), kind: 'calendar' },
      ],
    }));
    renderEditor();

    await waitFor(() => expect(page!.ofType('pe:restore_result')).toHaveLength(1), { timeout: 8000 });
    expect(page.ofType('pe:restore_result')[0].message).toEqual(expect.objectContaining({
      status: 'restored', mode: 'design', photos: { total: 2, loaded: 2, failed: 0 },
    }));
    const fetched = backend.callsTo('upload/from-url', 'POST').map(c => (c.body as { url: string }).url).sort();
    expect(fetched).toEqual([LINK(1), LINK(3)]);
    const dateFetch = backend.callsTo('upload/from-url', 'POST').find(c => (c.body as { url: string }).url === LINK(3))!;
    expect(dateFetch).toBeDefined();
    // The date's small preview is read back from our server.
    const small = backend.callsTo('photos/', 'GET').filter(c => c.query.get('size') === '512');
    expect(small).toHaveLength(1);
    const newUpload = small[0].path.split('/')[1];
    expect(newUpload).toMatch(/^ffffffff-0000-4000-8000-/);

    // Saved (and so printed) under the new upload; the event on that date is untouched.
    await waitFor(() => expect(lastPut()?.calendarState?.cells?.['2026-01-05']?.some(e => e.uploadId === newUpload)).toBe(true), { timeout: 6000 });
    expect(lastPut()!.calendarState!.cells!['2026-01-05']).toEqual([
      { type: 'event', text: 'Party' }, { type: 'image', uploadId: newUpload },
    ]);
    expect(JSON.stringify(lastPut())).not.toContain('old-upload-1');
  });
});
