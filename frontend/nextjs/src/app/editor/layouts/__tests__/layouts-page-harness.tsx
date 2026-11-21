/**
 * Test harness for the ops layouts page characterization suite
 * (page.characterization.test.tsx), modelled on the customer editor's
 * editor-page-harness.tsx.
 *
 * FakeLayoutsBackend answers every request the page makes through the
 * internal proxy, records each one in order (method, path, parsed body; a
 * multipart save is unpacked into its fields, its layout JSON and its files)
 * and can fail one. The suite pins that network contract, so it holds however
 * page.tsx is split (docs/LAYOUTS_PAGE_SPLIT_PLAN.md).
 */
import React from 'react';
import { render } from '@testing-library/react';
import { HeaderProvider, useHeader } from '@/context/HeaderContext';
import LayoutCreatorPage from '@/app/editor/layouts/page';

// ── Fixtures ────────────────────────────────────────────────────────────────

export const TAGS = [
  { key: 'photo_prints', name: 'Photo Prints', isActive: true, layoutCount: 1 },
  { key: 'gifts', name: 'Gifts', isActive: true, layoutCount: 1 },
  { key: 'old_tag', name: 'Old Tag', isActive: false, layoutCount: 0 },
];

/** A plain 4x6 in print, two print areas with bleed, a frame picture, whole-canvas print. */
export const CLASSIC = {
  name: 'classic_4x6',
  displayName: 'Classic 4x6',
  tags: ['Photo Prints', 'Old Tag'],
  tagKeys: ['photo_prints', 'old_tag'],
  canvas: { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4, dpi: 300 },
  frames: [
    { id: 'a', x: 0.05, y: 0.05, width: 0.9, height: 0.4, xMm: 8, yMm: 10, widthMm: 85.6, heightMm: 60, bleedMm: 3 },
    { id: 'b', x: 0.05, y: 0.55, width: 0.9, height: 0.4, xMm: 8, yMm: 82.4, widthMm: 85.6, heightMm: 60, bleedMm: 3 },
  ],
  frameMaskUrl: 'https://cdn.example/masks/classic_4x6_mask_abc1234567.png',
  printSheet: { mode: 'canvas' },
  frameCaptionsEnabled: false,
  orientationRotatable: true,
  version: 4,
};

/** A two-sided product: the back prints its bleed area and has a frame picture. */
export const MUG = {
  name: 'mug_wrap',
  displayName: 'Mug Wrap',
  type: 'product',
  tags: ['Gifts'],
  tagKeys: ['gifts'],
  frameCaptionsEnabled: false,
  orientationRotatable: false,
  surfaces: [
    {
      key: 'front', label: 'Front',
      canvas: { width: 2400, height: 1200, widthMm: 203.2, heightMm: 101.6, dpi: 300 },
      frames: [{ id: 'f', x: 0.1, y: 0.1, width: 0.8, height: 0.8, xMm: 20.32, yMm: 10.16, widthMm: 162.56, heightMm: 81.28, bleedMm: 0 }],
      printSheet: { mode: 'canvas' },
    },
    {
      key: 'back', label: 'Back',
      canvas: { width: 1200, height: 1200, widthMm: 101.6, heightMm: 101.6, dpi: 300 },
      frames: [{ id: 'g', x: 0.2, y: 0.2, width: 0.6, height: 0.6, xMm: 20, yMm: 20, widthMm: 61.6, heightMm: 61.6, bleedMm: 2 }],
      frameMaskUrl: 'https://cdn.example/masks/mug_wrap_back_mask_def1234567.png',
      printSheet: { mode: 'bleed' },
    },
  ],
};

/** An old layout that only has a grid block, no frames. */
export const OLD_GRID = {
  name: 'old_grid',
  displayName: '',
  tags: [],
  tagKeys: [],
  canvas: { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4, dpi: 300 },
  grid: { rows: 2, cols: 1, padding: 24 },
};

export const CALENDAR_ROW = { name: 'wall_calendar', displayName: 'Wall Calendar', productType: 'calendar', tags: [], tagKeys: [] };
export const BOOK_ROW = { name: 'photo_book', displayName: 'Photo Book', productType: 'book', tags: [], tagKeys: [] };
export const RETIRED_ROW = { name: 'retired_print', displayName: 'Retired Print', tags: [], tagKeys: [], isDeprecated: true, renamedTo: null };

export const ALL_LAYOUTS = [CLASSIC, MUG, OLD_GRID, CALENDAR_ROW, BOOK_ROW, RETIRED_ROW];

// ── Fake backend ────────────────────────────────────────────────────────────

export type SavedFile = { field: string; name: string; type: string };
export type SaveBody = {
  fields: Record<string, string>;
  layout: Record<string, any>;
  files: SavedFile[];
};

export type Call = { seq: number; method: string; path: string; init: RequestInit; body: unknown };

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function unpackFormData(fd: FormData): SaveBody {
  const fields: Record<string, string> = {};
  const files: SavedFile[] = [];
  fd.forEach((value, key) => {
    if (typeof value === 'string') fields[key] = value;
    else files.push({ field: key, name: (value as File).name, type: (value as File).type });
  });
  return { fields, layout: fields.layout ? JSON.parse(fields.layout) : {}, files };
}

export class FakeLayoutsBackend {
  calls: Call[] = [];
  unexpected: string[] = [];
  layouts: Array<Record<string, any>> = ALL_LAYOUTS.map((l) => ({ ...l }));
  fonts: string[] = ['Inter', 'Lato'];
  tags = TAGS;
  /** Next response for POST ops/layouts, else 201. */
  saveResponse: { status: number; body: unknown } | null = null;
  /** Next response for DELETE ops/layouts/<name>, else 204. */
  deleteResponse: { status: number; body: unknown } | null = null;
  private seq = 0;

  callsTo(path: string, method?: string): Call[] {
    return this.calls.filter((c) => c.path === path && (!method || c.method === method));
  }

  saves(): SaveBody[] {
    return this.callsTo('ops/layouts', 'POST').map((c) => c.body as SaveBody);
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/internal\/proxy\//, '');
    let body: unknown = init.body;
    if (init.body instanceof FormData) body = unpackFormData(init.body);
    else if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    this.calls.push({ seq: ++this.seq, method, path, init, body });

    if (path === 'ops/layouts' && method === 'GET') {
      return fakeResponse(200, { layouts: this.layouts });
    }
    if (path === 'ops/layouts' && method === 'POST') {
      const r = this.saveResponse;
      this.saveResponse = null;
      return fakeResponse(r?.status ?? 201, r?.body ?? { status: 'saved' });
    }
    const m = path.match(/^ops\/layouts\/([^/]+)$/);
    if (m && method === 'GET') {
      const found = this.layouts.find((l) => l.name === decodeURIComponent(m[1]));
      return found ? fakeResponse(200, found) : fakeResponse(404, { detail: 'Not found' });
    }
    if (m && method === 'DELETE') {
      const r = this.deleteResponse;
      this.deleteResponse = null;
      return fakeResponse(r?.status ?? 204, r?.body ?? '');
    }
    if (path === 'layout-tags' && method === 'GET') return fakeResponse(200, { tags: this.tags });
    if (path === 'fonts' && method === 'GET') return fakeResponse(200, { fonts: this.fonts });
    if (path === 'fonts' && method === 'PUT') return fakeResponse(200, { fonts: (body as { fonts: string[] }).fonts });
    this.unexpected.push(`${method} ${url.pathname}${url.search}`);
    return fakeResponse(404, { detail: 'not handled by FakeLayoutsBackend' });
  };
}

// ── The preview stub ────────────────────────────────────────────────────────

/** The props the page last handed the (stubbed) Fabric preview. */
export const previewPropsRef: { current: Record<string, any> | null } = { current: null };

function recordPreviewProps(props: Record<string, any>) {
  previewPropsRef.current = props;
}

export function PreviewStub(props: Record<string, any>) {
  recordPreviewProps(props);
  return <div data-testid="layout-preview" />;
}

// ── Header probe ────────────────────────────────────────────────────────────

/** The page puts its title, search box and links in the app header; this renders them. */
function HeaderProbe() {
  const { title, centerActions, rightActions } = useHeader();
  return (
    <div data-testid="header">
      <span data-testid="header-title">{title}</span>
      <div data-testid="header-center">{centerActions}</div>
      <div data-testid="header-right">{rightActions}</div>
    </div>
  );
}

/** The page inside the header context, as the app mounts it. Also what a rerender passes. */
export function layoutsPageTree() {
  return (
    <HeaderProvider>
      <HeaderProbe />
      <LayoutCreatorPage />
    </HeaderProvider>
  );
}

export function renderLayoutsPage() {
  return render(layoutsPageTree());
}

export function setPageUrl(search = '') {
  window.history.replaceState(null, '', `/editor/layouts${search}`);
}
