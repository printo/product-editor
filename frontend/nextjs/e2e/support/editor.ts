/**
 * Shared steps for driving the editor page in a real browser.
 */
import http from 'node:http';
import path from 'node:path';
import { expect, type Frame, type FrameLocator, type Page, type Request } from '@playwright/test';
import { PARENT_ORIGIN } from './env';

export const PHOTOS = {
  portrait: path.join(__dirname, '..', 'fixtures', 'portrait-3000x4000.jpg'),
  landscape: path.join(__dirname, '..', 'fixtures', 'landscape-4000x3000.jpg'),
  square: path.join(__dirname, '..', 'fixtures', 'square-2400x2400.jpg'),
  heic: path.join(__dirname, '..', 'fixtures', 'iphone-3000x4000.heic'),
};

type Surface = Page | Frame | FrameLocator;

/** The layout most specs run against (resolved by global-setup). */
export const layoutName = () => process.env.E2E_LAYOUT as string;

export function cards(surface: Surface) {
  return surface.getByRole('button', { name: /^Edit canvas \d+/ });
}

/** The multi-photo picker (the single-file input is the per-frame replace). */
export async function addPhotos(surface: Surface, files: string[]) {
  await surface.locator('input[type="file"][multiple]').setInputFiles(files);
}

/** Where the editor toolbar sits: found through its Blur Effect button, which
 *  both the embed and the dashboard toolbar carry. */
export function toolbarPlacement(surface: Page) {
  return surface.getByRole('button', { name: 'Toggle blur effect' }).evaluate((button) => {
    const bar = button.closest('.backdrop-blur-3xl') as HTMLElement;
    return { position: getComputedStyle(bar).position, top: Math.round(bar.getBoundingClientRect().top) };
  });
}

/** Scrolls to the bottom (or top) and checks the page can actually scroll. */
export async function scrollPage(page: Page, to: 'bottom' | 'top') {
  const scrolled = await page.evaluate((where) => {
    window.scrollTo(0, where === 'bottom' ? document.documentElement.scrollHeight : 0);
    return window.scrollY;
  }, to);
  if (to === 'bottom') expect(scrolled).toBeGreaterThan(20);
}

export async function openEmbedEditor(page: Page, token: string, layout = layoutName()) {
  await page.goto(`/editor/layout/${encodeURIComponent(layout)}?token=${encodeURIComponent(token)}`);
  await expect(page.locator('input[type="file"][multiple]')).toBeAttached();
}

export type Recorded = { method: string; url: string; at: number; body: string | null };

/** Record API requests the page issues (any frame), in order, with when they were issued. */
export function recordApi(page: Page): Recorded[] {
  const log: Recorded[] = [];
  page.on('request', (r: Request) => {
    if (r.url().includes('/api/')) log.push({ method: r.method(), url: r.url(), at: Date.now(), body: r.postData() });
  });
  return log;
}

export type Autosave = {
  layout_name: string;
  editor_state: { surfaces: Array<{ canvases: Array<{ frames: Array<{ fileName?: string; rotation?: number }> }> }> };
};

/** Collect every successful canvas-state autosave (any frame), in order. */
export function recordAutosaves(page: Page): Autosave[] {
  const saves: Autosave[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && /\/canvas-state\/[^/]+\/$/.test(new URL(r.url()).pathname) && r.ok()) {
      saves.push(JSON.parse(r.request().postData() || '{}'));
    }
  });
  return saves;
}

export const canvasCount = (s: Autosave | undefined) => s?.editor_state.surfaces[0]?.canvases.length ?? -1;
export const photoOrder = (s: Autosave | undefined) =>
  s?.editor_state.surfaces[0]?.canvases.map((c) => c.frames[0]?.fileName) ?? [];

/**
 * Record, inside the page, when each canvas-state fetch was *issued* and when it
 * settled. Chrome can hold a same-URL PUT behind an in-flight GET, which hides
 * an early write at the network layer; the page's own clock does not.
 */
export async function logCanvasStateFetches(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __peFetchLog: Array<{ method: string; url: string; start: number; end: number | null }> };
    w.__peFetchLog = [];
    const orig = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const entry = { method: (init?.method || 'GET').toUpperCase(), url, start: Date.now(), end: null as number | null };
      if (url.includes('/canvas-state/')) w.__peFetchLog.push(entry);
      try {
        return await orig.call(this, input, init);
      } finally {
        entry.end = Date.now();
      }
    };
  });
}

export async function canvasStateFetches(page: Page) {
  return page.evaluate(() => (window as unknown as { __peFetchLog: Array<{ method: string; url: string; start: number; end: number | null }> }).__peFetchLog);
}

/**
 * A fake parent page (like printo.in's storefront) that iframes the editor and
 * records the messages it posts. Served by a real local HTTP server rather than
 * page.route(): Chrome treats a route-fulfilled document as public and its
 * Local Network Access checks then refuse to frame localhost.
 */
export async function startParentServer(port: number): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    const src = new URL(req.url || '/', `http://localhost:${port}`).searchParams.get('src') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="margin:0">
      <iframe id="pe" src="${src.replace(/"/g, '&quot;')}" style="width:1300px;height:880px;border:0"></iframe>
      <script>window.__messages=[];addEventListener('message',e=>window.__messages.push({origin:e.origin,data:e.data}));</script>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

export function parentPageUrl(origin: string, editorUrl: string) {
  return `${origin}/checkout?src=${encodeURIComponent(editorUrl)}`;
}

export async function openInParentPage(page: Page, editorUrl: string) {
  await page.goto(parentPageUrl(PARENT_ORIGIN, editorUrl));
  const frame = page.frameLocator('#pe');
  await expect(frame.locator('input[type="file"][multiple]')).toBeAttached();
  return frame;
}

export async function parentMessages(page: Page): Promise<Array<{ origin: string; data: Record<string, unknown> }>> {
  return page.evaluate(() => (window as unknown as { __messages: Array<{ origin: string; data: Record<string, unknown> }> }).__messages);
}
