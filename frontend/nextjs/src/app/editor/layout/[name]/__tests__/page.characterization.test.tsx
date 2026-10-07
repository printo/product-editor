/**
 * Characterization tests for the editor page (editor/layout/[name]/page.tsx).
 *
 * They pin what the page does today — the requests it sends, in what order,
 * with what bodies, and what the customer sees — so page.tsx can be split
 * into components and hooks (docs/LARGE_FILE_SPLIT_PLAN.md, part 2) with the
 * same suite passing unchanged after every move. Stubbed: the canvas library
 * and image decoding (happy-dom has no 2D canvas), orientation detection,
 * HEIC/PDF conversion, auth and routing. Everything else — state, effects,
 * upload chunking, autosave, restore, the render request — runs for real
 * against FakeBackend. Timers are real, so the autosave debounce (2 s) and the
 * dashboard's status poll (first at ~2 s) are waited out, not faked.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BOOK_LAYOUT, CALENDAR_FINANCIAL_GENZ, CALENDAR_LAYOUT, CALENDAR_NO_HOLIDAYS, FakeBackend, LAYOUT_NAME, makePhoto, renderEditor, setEditorUrl,
} from './editor-page-harness';
import { isImageComplete } from '@/lib/image-utils';

jest.setTimeout(30000);

// Next's router and params are stable objects between renders; several of the
// page's effects depend on `router`, so a fresh object per render would loop.
const mockPush = jest.fn();
const mockRouter = { push: mockPush, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
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
jest.mock('@/lib/image-utils', () => ({
  getImageMetadata: jest.fn(async () => ({
    width: 1200, height: 1800, orientation: 1,
    element: { naturalWidth: 1200, naturalHeight: 1800, width: 1200, height: 1800 },
  })),
  getImageSize: jest.fn(async () => ({ width: 1200, height: 1800 })),
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

const ORDER_ID = 'TEST-ORDER-1';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend();
  global.fetch = jest.fn(backend.fetch) as unknown as typeof fetch;
  mockSession = { data: null, status: 'unauthenticated' };
  mockParams = { name: LAYOUT_NAME };
  mockPush.mockReset();
  localStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function photoInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  if (!input) throw new Error('multi-photo file input not found');
  return input;
}

async function addPhotos(names: string[]) {
  const user = userEvent.setup();
  await user.upload(photoInput(), names.map(makePhoto));
}

const cards = () => screen.queryAllByRole('button', { name: /^Edit canvas \d+/ });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openEditorWithPhotos(names: string[]) {
  renderEditor();
  await waitFor(() => expect(backend.callsTo('editor/init')).toHaveLength(1));
  await waitFor(() => photoInput());
  await addPhotos(names);
  await waitFor(() => expect(cards()).toHaveLength(names.length));
}

/** Every string anywhere in a JSON-ish value. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

type Frame = { fileName?: string; rotation?: number };
type PutBody = {
  layout_name: string;
  editor_state: {
    layoutName?: string;
    surfaces: Array<{ key: string; canvases: Array<{ frames: Frame[] }> }>;
    calendarState?: { themePreset?: string; calendarType?: string };
    bookState?: { pageCount?: number };
  };
};
const lastPut = (orderId: string) => backend.callsTo(`canvas-state/${orderId}/`, 'PUT').pop()?.body as PutBody | undefined;

describe('editor page — embed mode', () => {
  beforeEach(() => {
    setEditorUrl('embed');
    backend.editorInit = { order_id: ORDER_ID };
  });

  it('loads the layout through the embed proxy with the embed token, and adopts the session order id', async () => {
    renderEditor();
    await waitFor(() => expect(backend.callsTo('editor/init')).toHaveLength(1));
    const init = backend.callsTo('editor/init')[0];
    expect(init.query.get('layout')).toBe(LAYOUT_NAME);
    expect(init.headers['x-embed-token']).toBe('test-embed-token');
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')).toHaveLength(1));
    expect(backend.unexpected).toEqual([]);
  });

  it('adding photos twice appends — the second pick never replaces the first', async () => {
    await openEditorWithPhotos(['a.jpg', 'b.jpg']);
    await addPhotos(['c.jpg']);
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(backend.unexpected).toEqual([]);
  });

  it('autosaves the design once settled: PUT after the restore GET, layout named, no preview images', async () => {
    await openEditorWithPhotos(['a.jpg', 'b.jpg']);
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT').length).toBeGreaterThan(0), { timeout: 8000 });
    const restoreGet = backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')[0];
    const puts = backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT');
    for (const put of puts) expect(put.seq).toBeGreaterThan(restoreGet.seq);
    const last = puts[puts.length - 1].body as PutBody;
    expect(last.layout_name).toBe(LAYOUT_NAME);
    expect(last.editor_state.layoutName).toBe(LAYOUT_NAME);
    expect(last.editor_state.surfaces).toHaveLength(1);
    expect(last.editor_state.surfaces[0].canvases).toHaveLength(2);
    expect(allStrings(last).filter((s) => s.startsWith('data:'))).toEqual([]);
    expect(backend.unexpected).toEqual([]);
  });

  it('a slow restore is never overwritten: no autosave until the saved design has landed (PR #166)', async () => {
    // Session 1: build a design and capture what autosave stores.
    await openEditorWithPhotos(['a.jpg', 'b.jpg']);
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT').length).toBeGreaterThan(0), { timeout: 8000 });
    const saved = (backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT').pop()!.body as PutBody).editor_state;
    cleanup();

    // Session 2: the restore GET takes longer than the 2 s autosave debounce.
    backend = new FakeBackend();
    backend.editorInit = { order_id: ORDER_ID };
    backend.savedEditorState = saved;
    global.fetch = jest.fn(backend.fetch) as unknown as typeof fetch;
    const release = backend.holdNextRestore();
    renderEditor();
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')).toHaveLength(1));
    await sleep(3500);
    expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT')).toEqual([]);

    release();
    await waitFor(() => expect(cards()).toHaveLength(2), { timeout: 8000 });
    // Anything written after the restore carries the restored design, never a blank one.
    await sleep(2500);
    for (const put of backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT')) {
      expect((put.body as PutBody).editor_state.surfaces[0].canvases).toHaveLength(2);
    }
    expect(backend.unexpected).toEqual([]);
  });

  it('over the ordered quantity: the pick is held, "Keep first N" keeps exactly N', async () => {
    backend.editorInit = { order_id: ORDER_ID, qty: 2 };
    renderEditor();
    await waitFor(() => expect(backend.callsTo('editor/init')).toHaveLength(1));
    await waitFor(() => photoInput());
    await addPhotos(['a.jpg', 'b.jpg', 'c.jpg']);
    const dialog = await screen.findByRole('alertdialog', { name: 'More images than ordered' });
    expect(cards()).toHaveLength(0);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: /Keep first 2/i }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.queryByRole('alertdialog', { name: 'More images than ordered' })).toBeNull();
  });

  it('under the ordered quantity: warns with the counts but still allows submitting', async () => {
    backend.editorInit = { order_id: ORDER_ID, qty: 3 };
    await openEditorWithPhotos(['a.jpg']);
    await waitFor(() => expect(document.body.textContent).toMatch(/\b1\b[^\d]{1,40}\b3\b/));
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
  });

  it('removing a photo asks first, then removes exactly that card', async () => {
    await openEditorWithPhotos(['a.jpg', 'b.jpg']);
    const user = userEvent.setup();
    await user.click(screen.getAllByTitle('Remove Photo')[0]);
    await screen.findByText('Remove image?');
    expect(cards()).toHaveLength(2);
    const dialog = screen.getByText('Remove image?').closest('[role="dialog"]') ?? document.body;
    const confirm = within(dialog as HTMLElement).getAllByRole('button').find((b) => /remove|delete|yes/i.test(b.textContent || ''));
    await user.click(confirm!);
    await waitFor(() => expect(cards()).toHaveLength(1));
  });

  it('an incomplete photo asks first: the prompt takes focus, and Escape cancels the pick', async () => {
    renderEditor();
    await waitFor(() => expect(backend.callsTo('editor/init')).toHaveLength(1));
    await waitFor(() => photoInput());
    jest.mocked(isImageComplete).mockResolvedValueOnce(false);
    await addPhotos(['cut-off.jpg']);
    const prompt = await screen.findByRole('alertdialog', { name: 'Incomplete image detected' });
    expect(prompt).toContainElement(document.activeElement as HTMLElement);
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cards()).toHaveLength(0);
  });

  it('quick rotate turns the photo 90° and the autosave carries it', async () => {
    await openEditorWithPhotos(['a.jpg']);
    await waitFor(() => expect(lastPut(ORDER_ID)).toBeDefined(), { timeout: 8000 });
    await userEvent.setup().click(screen.getByTitle('Rotate 90°'));
    await waitFor(() => expect(lastPut(ORDER_ID)!.editor_state.surfaces[0].canvases[0].frames[0].rotation).toBe(90), { timeout: 8000 });
  });

  it('tap-to-swap exchanges two photos and the autosave carries the new order', async () => {
    await openEditorWithPhotos(['a.jpg', 'b.jpg']);
    await waitFor(() => expect(lastPut(ORDER_ID)).toBeDefined(), { timeout: 8000 });
    const order = () => lastPut(ORDER_ID)!.editor_state.surfaces[0].canvases.map((c) => c.frames[0].fileName);
    expect(order()).toEqual(['a.jpg', 'b.jpg']);
    const user = userEvent.setup();
    await user.click(screen.getAllByTitle('Swap Photo')[0]);
    await screen.findByText('Tap another photo to swap');
    await user.click(cards()[1]);
    await waitFor(() => expect(order()).toEqual(['b.jpg', 'a.jpg']), { timeout: 8000 });
  });

  it('Save & Continue uploads each photo, submits the render with real upload ids, and tells the parent page', async () => {
    const postMessage = jest.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    await openEditorWithPhotos(['a.jpg', 'b.jpg']);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Ready to Submit?');
    await user.click(screen.getAllByRole('checkbox').pop()!);
    await user.click(screen.getByRole('button', { name: 'Yes, Proceed' }));

    await waitFor(() => expect(backend.callsTo('editor/render', 'POST')).toHaveLength(1), { timeout: 10000 });
    const inits = backend.callsTo('upload/init', 'POST');
    expect(inits.map((c) => (c.body as { filename: string }).filename).sort()).toEqual(['a.jpg', 'b.jpg']);
    for (const c of inits) expect(c.headers['x-embed-token']).toBe('test-embed-token');
    const render = backend.callsTo('editor/render', 'POST')[0];
    const body = render.body as {
      layout_name: string; order_id: string;
      canvases: Array<{ surface_key: string; frames: Array<{ upload_id: string }> }>;
    };
    expect(body.layout_name).toBe(LAYOUT_NAME);
    expect(body.order_id).toBe(ORDER_ID);
    expect(body.canvases).toHaveLength(2);
    const uploadIds = new Set(
      backend.callsTo('upload/', 'POST').filter((c) => c.path.endsWith('/complete')).map((c) => c.path.split('/')[1]),
    );
    for (const c of body.canvases) {
      expect(c.surface_key).toBe('default');
      expect(uploadIds.has(c.frames[0].upload_id)).toBe(true);
    }
    // Uploads finish before the render is submitted.
    const lastComplete = Math.max(...backend.callsTo('upload/', 'POST').filter((c) => c.path.endsWith('/complete')).map((c) => c.seq));
    expect(render.seq).toBeGreaterThan(lastComplete);

    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const [message, targetOrigin] = postMessage.mock.calls[0];
    expect(message).toEqual(expect.objectContaining({ type: 'pe:render_job', jobId: JOB_ID, orderID: ORDER_ID }));
    expect(targetOrigin).toBe('https://printo.in');
    expect(targetOrigin).not.toBe('*');
    expect(backend.unexpected).toEqual([]);
  });
});

describe('editor page — dashboard mode', () => {
  beforeEach(() => {
    setEditorUrl('dashboard', ORDER_ID);
    mockSession = {
      status: 'authenticated',
      data: { user: { id: 'TEST', name: 'Test User', email: 'test@printo.in', role: 'user' }, accessToken: 'x', is_ops_team: false },
    };
  });

  it('loads through the internal proxy, with no embed token', async () => {
    renderEditor();
    await waitFor(() => expect(backend.callsTo('editor/init')).toHaveLength(1));
    expect(backend.callsTo('editor/init')[0].headers['x-embed-token']).toBeUndefined();
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toMatch(/^\/api\/internal\/proxy\/editor\/init\?/);
  });

  it('redirects to /login when signed out', async () => {
    mockSession = { data: null, status: 'unauthenticated' };
    renderEditor();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
    expect(backend.callsTo('editor/init')).toHaveLength(0);
  });

  it('Download renders on the server, polls the status, then hands the ZIP URL to the browser', async () => {
    const clicks: Array<{ href: string; download: string; attached: boolean }> = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute('href') || '', download: this.download, attached: this.isConnected });
    });
    await openEditorWithPhotos(['a.jpg']);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByText('Ready to Download?');
    await user.click(screen.getAllByRole('checkbox')[0]);
    await user.click(screen.getByText('ZIP Archive'));

    // The first status poll is ~2 s after submit; a completed job triggers the download.
    await waitFor(() => expect(clicks).toHaveLength(1), { timeout: 15000 });
    expect(clicks[0].href).toMatch(new RegExp(`^/api/internal/proxy/jobs/${JOB_ID}/download/\\?include_uploads=[01]$`));
    expect(clicks[0].download).toBe(`${LAYOUT_NAME}.zip`);
    // The link is never attached to the React-owned document.
    expect(clicks[0].attached).toBe(false);
    const render = backend.callsTo('editor/render', 'POST')[0];
    expect((render.body as { canvases: unknown[] }).canvases).toHaveLength(1);
    const polls = backend.callsTo(`render-status/${JOB_ID}/`, 'GET');
    expect(polls.length).toBeGreaterThan(0);
    expect(polls[0].seq).toBeGreaterThan(render.seq);
    expect(backend.unexpected).toEqual([]);
  });
});

describe('editor page — calendar layouts', () => {
  beforeEach(() => {
    setEditorUrl('embed');
    mockParams = { name: 'test_calendar' };
    backend.editorInit = { order_id: ORDER_ID };
  });

  it('loads holidays when the print carries them', async () => {
    backend.layout = CALENDAR_LAYOUT as unknown as Record<string, unknown>;
    renderEditor();
    await waitFor(() => expect(backend.callsTo('holidays/', 'GET').length).toBeGreaterThan(0));
    expect(backend.callsTo('holidays/')[0].path).toMatch(/^holidays\/en-IN\/\d{4}$/);
    expect(backend.unexpected).toEqual([]);
  });

  it('a slow restore is never overwritten by the layout-default autosave (the PR #166 calendar path)', async () => {
    backend.layout = CALENDAR_FINANCIAL_GENZ as unknown as Record<string, unknown>;
    // Session 1: a calendar design with one photo; capture what autosave stores.
    await openEditorWithPhotos(['a.jpg']);
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT').length).toBeGreaterThan(0), { timeout: 8000 });
    const saved = (backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT').pop()!.body as PutBody).editor_state;
    expect(saved.surfaces[0].canvases).toHaveLength(1);
    expect(saved.calendarState).toMatchObject({ calendarType: 'financial', themePreset: 'modern-genz' });
    cleanup();

    // Session 2: applying the layout's calendar defaults asks for an autosave
    // while the restore GET is still in flight. It must wait for the restore.
    backend = new FakeBackend();
    backend.layout = CALENDAR_FINANCIAL_GENZ as unknown as Record<string, unknown>;
    backend.editorInit = { order_id: ORDER_ID };
    backend.savedEditorState = saved;
    global.fetch = jest.fn(backend.fetch) as unknown as typeof fetch;
    const release = backend.holdNextRestore();
    renderEditor();
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')).toHaveLength(1));
    await sleep(3500);
    expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT')).toEqual([]);

    release();
    await sleep(3000);
    for (const put of backend.callsTo(`canvas-state/${ORDER_ID}/`, 'PUT')) {
      expect((put.body as PutBody).editor_state.surfaces[0].canvases).toHaveLength(1);
    }
    expect(backend.unexpected).toEqual([]);
  });

  it('never loads holidays when the print has none', async () => {
    backend.layout = CALENDAR_NO_HOLIDAYS as unknown as Record<string, unknown>;
    renderEditor();
    await waitFor(() => expect(backend.callsTo('editor/init')).toHaveLength(1));
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')).toHaveLength(1));
    await sleep(500);
    expect(backend.callsTo('holidays/')).toEqual([]);
    expect(backend.unexpected).toEqual([]);
  });
});

describe('editor page — book layouts', () => {
  beforeEach(() => {
    setEditorUrl('embed');
    mockParams = { name: 'test_book' };
    backend.editorInit = { order_id: ORDER_ID };
    backend.layout = BOOK_LAYOUT as unknown as Record<string, unknown>;
  });

  it('the page-count control steps the count and the autosave carries it', async () => {
    renderEditor();
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')).toHaveLength(1));
    const more = await screen.findByRole('button', { name: 'More pages' });
    await userEvent.setup().click(more);
    await waitFor(() => expect(lastPut(ORDER_ID)?.editor_state.bookState?.pageCount).toBe(12), { timeout: 8000 });
    expect(backend.unexpected).toEqual([]);
  });

  it('more photos than pages asks to extend: the prompt takes focus, and Escape cancels the pick', async () => {
    renderEditor();
    await waitFor(() => expect(backend.callsTo(`canvas-state/${ORDER_ID}/`, 'GET')).toHaveLength(1));
    await waitFor(() => photoInput());
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i + 1}.jpg`);
    await addPhotos(twelve);
    let prompt = await screen.findByRole('alertdialog', { name: /won't fit on 8 pages/ });
    expect(prompt).toContainElement(document.activeElement as HTMLElement);
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await sleep(4000); // past the 2 s autosave debounce: nothing from the pick may be saved
    expect(allStrings(lastPut(ORDER_ID)?.editor_state)).not.toContain('p1.jpg');
    // Cancelled, not decided: the same pick asks again, and a decision does place the photos.
    await addPhotos(twelve);
    prompt = await screen.findByRole('alertdialog', { name: /won't fit on 8 pages/ });
    await userEvent.setup().click(within(prompt).getByRole('button', { name: 'Keep 8 pages' }));
    await waitFor(() => expect(allStrings(lastPut(ORDER_ID)?.editor_state)).toContain('p1.jpg'), { timeout: 8000 });
  });
});
