/**
 * Test harness for the editor page characterization suite
 * (page.characterization.test.tsx).
 *
 * FakeBackend answers every request the page makes, records each one in order
 * (method, path, parsed body) and can hold a response back, so a test can pin
 * the network contract — what the page sends, and when — independently of how
 * the page's code is organised. That is what makes the suite a safety net for
 * splitting page.tsx: the same assertions must hold before and after each move.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { HeaderProvider } from '@/context/HeaderContext';
import LayoutEditorPage from '@/app/editor/layout/[name]/page';

export const LAYOUT_NAME = 'test_4x6';

/** One full-bleed frame on a 4x6 in portrait canvas — the simplest real layout shape. */
export const LAYOUT_4X6 = {
  name: LAYOUT_NAME,
  displayName: 'Test 4x6',
  tags: ['Photo Prints'],
  canvas: { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4, dpi: 300 },
  frames: [
    { id: 'f1', x: 0, y: 0, width: 1, height: 1, xMm: 0, yMm: 0, widthMm: 101.6, heightMm: 152.4 },
  ],
};

/**
 * A real 12-month calendar layout (the local test_verification_calendar),
 * renamed. Holidays are on, in en-IN — CALENDAR_NO_HOLIDAYS drops the block,
 * which the print reads as "no holidays".
 */
export const CALENDAR_LAYOUT = {
  "name": "test_calendar",
  "displayName": "Test Calendar",
  "productType": "calendar",
  "tags": [],
  "canvas": {
    "dpi": 300,
    "width": 1500,
    "height": 2100,
    "widthMm": 127,
    "heightMm": 177.8
  },
  "frames": [
    {
      "x": 0.05,
      "y": 0.05,
      "id": "top",
      "width": 0.9,
      "height": 0.42
    }
  ],
  "calendars": [
    {
      "x": 0.05,
      "y": 0.55,
      "width": 0.9,
      "height": 0.42
    }
  ],
  "calendar": {
    "weekStart": "sunday",
    "themePreset": "modern-minimalist",
    "calendarType": "english",
    "holidaySource": {
      "locale": "en-IN",
      "enabled": true,
      "showInCells": true
    },
    "defaultGenzPalette": "butter"
  },
  "monthRange": {
    "count": 12,
    "defaultYear": 2026
  }
} as const;

export const CALENDAR_NO_HOLIDAYS = {
  ...CALENDAR_LAYOUT,
  calendar: Object.fromEntries(
    Object.entries(CALENDAR_LAYOUT.calendar).filter(([k]) => k !== 'holidaySource'),
  ),
};

/**
 * The same calendar with ops defaults that differ from the editor's starting
 * state (Financial year, Gen-Z theme). Loading it changes calendar state, which
 * asks for an autosave while the restore may still be in flight — the path
 * that wiped saved designs before PR #166.
 */
export const CALENDAR_FINANCIAL_GENZ = {
  ...CALENDAR_LAYOUT,
  calendar: { ...CALENDAR_LAYOUT.calendar, calendarType: 'financial', themePreset: 'modern-genz' },
};

/** A book: 8 pages by default, 4–16 in steps of 4 (same shape as book-pages.test.ts). */
export const BOOK_LAYOUT = {
  name: 'test_book',
  displayName: 'Test Book',
  productType: 'book',
  book: {
    pageCount: { min: 4, max: 16, step: 4, default: 8 },
    gutterMm: 10,
    cover: { canvas: { width: 1000, height: 800, widthMm: 210, heightMm: 168 }, frames: [{ id: 'c0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
    innerPage: { canvas: { width: 900, height: 700, widthMm: 190, heightMm: 148 }, frames: [{ id: 'p0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
  },
};

export type Call = {
  seq: number;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
};

type Hold = { promise: Promise<void>; release: () => void };

function makeHold(): Hold {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else if (Array.isArray(h)) h.forEach(([k, v]) => { out[k.toLowerCase()] = v; });
  else Object.entries(h).forEach(([k, v]) => { out[k.toLowerCase()] = String(v); });
  return out;
}

function fakeResponse(status: number, body: unknown, contentType = 'application/json') {
  const isBlob = body instanceof Blob;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    blob: async () => (isBlob ? body : new Blob([JSON.stringify(body)])),
    arrayBuffer: async () => (isBlob ? (body as Blob).arrayBuffer() : new ArrayBuffer(0)),
  } as unknown as Response;
}

export class FakeBackend {
  calls: Call[] = [];
  unexpected: string[] = [];
  layout: Record<string, unknown> = LAYOUT_4X6;
  /** Extra fields merged into the /editor/init payload (order_id, qty, fonts). */
  editorInit: Record<string, unknown> = {};
  /** editor_state served by GET canvas-state; null means 404 (first visit). */
  savedEditorState: unknown | null = null;
  /** When set, GET canvas-state waits for release() before answering. */
  holdRestore: Hold | null = null;
  renderStatus: 'queued' | 'processing' | 'completed' | 'failed' = 'completed';
  holidays: Array<{ date: string; name: string }> = [];
  private seq = 0;
  private uploadSeq = 0;
  private uploads = new Map<string, { filename: string; total: number }>();
  private canvasStatePuts = 0;

  holdNextRestore(): () => void {
    this.holdRestore = makeHold();
    return this.holdRestore.release;
  }

  /** Requests to an API path (relative to the proxy prefix), optionally by method. */
  callsTo(pathPrefix: string, method?: string): Call[] {
    return this.calls.filter((c) => c.path.startsWith(pathPrefix) && (!method || c.method === method));
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/(embed|internal)\/proxy\//, '');
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: Call = { seq: ++this.seq, method, path, query: url.searchParams, headers: headersToObject(init.headers), body };
    this.calls.push(call);

    if (path === 'editor/init' && method === 'GET') {
      return fakeResponse(200, { layout: this.layout, fonts: [], ...this.editorInit });
    }
    let m = path.match(/^canvas-state\/([^/]+)\/$/);
    if (m && method === 'GET') {
      if (this.holdRestore) await this.holdRestore.promise;
      if (this.savedEditorState == null) return fakeResponse(404, { detail: 'No saved state for this order' });
      return fakeResponse(200, {
        order_id: m[1], layout_name: this.layout.name, fit_mode: 'cover',
        editor_state: this.savedEditorState, image_paths: [], updated_at: '2026-10-07T00:00:00Z',
      });
    }
    if (m && method === 'PUT') {
      this.canvasStatePuts += 1;
      return fakeResponse(this.canvasStatePuts === 1 ? 201 : 200, { order_id: m[1], status: 'saved' });
    }
    if (path === 'upload/init' && method === 'POST') {
      const b = body as { filename: string; total_chunks: number };
      const id = `00000000-0000-4000-8000-${String(++this.uploadSeq).padStart(12, '0')}`;
      this.uploads.set(id, { filename: b.filename, total: b.total_chunks });
      return fakeResponse(201, { upload_id: id, chunk_size: 2 * 1024 * 1024 });
    }
    m = path.match(/^upload\/([^/]+)\/chunk$/);
    if (m && method === 'PUT') {
      const index = Number(url.searchParams.get('index'));
      return fakeResponse(200, { chunk_index: index, received: index + 1, total: this.uploads.get(m[1])?.total ?? 1 });
    }
    m = path.match(/^upload\/([^/]+)\/complete$/);
    if (m && method === 'POST') {
      const u = this.uploads.get(m[1]);
      return fakeResponse(201, { file_path: `/app/storage/uploads/test/${u?.filename}`, filename: u?.filename, file_size: 3, upload_id: m[1] });
    }
    if (path === 'editor/render' && method === 'POST') {
      return fakeResponse(202, { job_id: '11111111-1111-4111-8111-111111111111', order_id: (body as { order_id?: string })?.order_id, status_url: '/api/render-status/11111111-1111-4111-8111-111111111111/', queue: 'standard' });
    }
    m = path.match(/^render-status\/([^/]+)\/$/);
    if (m && method === 'GET') {
      return fakeResponse(200, { job_id: m[1], status: this.renderStatus, progress: this.renderStatus === 'completed' ? 100 : 10, file_count: 1 });
    }
    m = path.match(/^jobs\/([^/]+)\/download\/$/);
    if (m && method === 'GET') {
      return fakeResponse(200, new Blob(['PK-fake-zip'], { type: 'application/zip' }), 'application/zip');
    }
    if (path === 'calendar-styles/modern-genz' && method === 'GET') {
      return fakeResponse(200, { name: 'modern-genz', palettes: [] });
    }
    if (path.startsWith('holidays/') && method === 'GET') {
      return fakeResponse(200, { events: this.holidays });
    }
    this.unexpected.push(`${method} ${url.pathname}${url.search}`);
    return fakeResponse(404, { detail: 'not handled by FakeBackend' });
  };
}

/** A tiny JPEG-looking file. Image decoding is mocked, so only the name, type and size matter. */
export function makePhoto(name: string): File {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0xff, 0xd9]);
  return new File([bytes], name, { type: 'image/jpeg', lastModified: 1700000000000 + name.length });
}

export type Mode = 'embed' | 'dashboard';

/**
 * Point window.location at the editor route for the given mode. Embed mode is
 * a ?token= in the URL (that is how the page itself decides); dashboard mode
 * has none and relies on the mocked NextAuth session.
 */
export function setEditorUrl(mode: Mode, orderId?: string) {
  const sp = new URLSearchParams();
  if (mode === 'embed') sp.set('token', 'test-embed-token');
  if (orderId) sp.set('order_id', orderId);
  window.history.replaceState(null, '', `/editor/layout/${LAYOUT_NAME}${sp.toString() ? `?${sp}` : ''}`);
}

export function renderEditor() {
  return render(
    <HeaderProvider>
      <LayoutEditorPage />
    </HeaderProvider>,
  );
}
