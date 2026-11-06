/**
 * Direct calls to the backend for test setup and cleanup — never through the UI.
 * Every order id the suite creates is appended to E2E_ORDERS_FILE so
 * global-teardown can purge it (uploads, exports and rows) afterwards.
 */
import fs from 'node:fs';
import { e2eEnv } from './env';

let seq = 0;

export function newOrderId(prefix = 'E2E'): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${process.pid}-${seq}`;
}

export function rememberOrder(orderId: string) {
  const file = process.env.E2E_ORDERS_FILE;
  if (file) fs.appendFileSync(file, `${orderId}\n`);
}

async function api(path: string, init: RequestInit = {}) {
  const { apiUrl, apiKey } = e2eEnv();
  const res = await fetch(`${apiUrl}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return res;
}

export async function createEmbedSession(opts: {
  orderId?: string; qty?: number; includeUploads?: boolean; templateId?: string; templateFlow?: boolean;
} = {}) {
  const orderId = opts.orderId ?? newOrderId();
  const body: Record<string, unknown> = { order_id: orderId };
  if (opts.qty != null) body.qty = opts.qty;
  if (opts.includeUploads != null) body.include_uploads = opts.includeUploads;
  if (opts.templateId != null) body.template_id = opts.templateId;
  if (opts.templateFlow != null) body.template_flow = opts.templateFlow;
  const res = await api('embed/session', { method: 'POST', body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`embed session: ${res.status} ${await res.text()}`);
  rememberOrder(orderId);
  const data = (await res.json()) as { token: string; editor_url: string | null; embed_url_template: string };
  return { orderId, token: data.token, editorUrl: data.editor_url, embedUrlTemplate: data.embed_url_template };
}

/** Test templates are named `e2e-…`, so a crashed run's leftovers can be found. */
export const E2E_TEMPLATE_PREFIX = 'e2e-';

/** Store a sticker PNG the way the ops template editor does. Returns its address. */
export async function uploadSticker(png: Buffer): Promise<string> {
  const { apiUrl, apiKey } = e2eEnv();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'sticker.png');
  const res = await fetch(`${apiUrl}/ops/templates/assets`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  if (res.status !== 201) throw new Error(`sticker upload: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { url: string }).url;
}

export async function createTemplate(t: { id: string; layout: string; displayName: string; decoration: unknown; status?: 'draft' | 'published' }) {
  const res = await api('ops/templates', {
    method: 'POST',
    body: JSON.stringify({ id: t.id, layout: t.layout, display_name: t.displayName, decoration: t.decoration, status: t.status ?? 'published' }),
  });
  if (res.status !== 201) throw new Error(`create template: ${res.status} ${await res.text()}`);
}

export async function hideTemplate(id: string) {
  const res = await api(`ops/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.status;
}

/** Hide any `e2e-` template a crashed run left published. */
export async function hideLeftoverTemplates() {
  const res = await api('ops/templates');
  if (!res.ok) return;
  const { templates } = (await res.json()) as { templates: Array<{ id: string }> };
  for (const t of templates) if (t.id.startsWith(E2E_TEMPLATE_PREFIX)) await hideTemplate(t.id);
}

/** A template as ops read it (drafts included), or null when there is none. */
export async function getTemplate(id: string): Promise<{
  id: string; status: string; layoutName: string;
  decoration: { surfaces: Record<string, { bgColor?: string; paperColor?: string; overlays: Array<Record<string, unknown>> }> };
} | null> {
  const res = await api(`ops/templates/${encodeURIComponent(id)}`);
  return res.ok ? res.json() : null;
}

export async function setTemplateStatus(id: string, status: 'draft' | 'published') {
  const res = await api(`ops/templates/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ status }) });
  if (!res.ok) throw new Error(`template status: ${res.status} ${await res.text()}`);
}

/** Test layouts are named `zz_e2e_…`: last in every list, and easy to find after a crashed run. */
export const E2E_LAYOUT_PREFIX = 'zz_e2e_';

/** A layout as the editor is served it, or null when there is none. */
export async function getLayout(name: string): Promise<{
  name: string; canvas: Record<string, number>; frames: Array<Record<string, number | string>>; frameMaskUrl?: string | null;
} | null> {
  const res = await api(`layouts/${encodeURIComponent(name)}`);
  return res.ok ? res.json() : null;
}

/** Create (or update) a layout the way the ops layout editor does. */
export async function createLayout(name: string, definition: unknown) {
  const { apiUrl, apiKey } = e2eEnv();
  const form = new FormData();
  form.append('name', name);
  form.append('layout_data', JSON.stringify(definition));
  const res = await fetch(`${apiUrl}/ops/layouts/${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  if (!res.ok) throw new Error(`create layout: ${res.status} ${await res.text()}`);
}

/** Retire a layout (the server never hard-deletes one). */
export async function deleteLayout(name: string) {
  const res = await api(`ops/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return res.status;
}

/** The text of a stored sticker (an SVG), from its `/api/templates/assets/<file>` address. Local storage only. */
export async function stickerText(src: string): Promise<string> {
  const { apiUrl } = e2eEnv();
  const res = await fetch(`${apiUrl}${src.replace(/^\/api/, '')}`);
  if (!res.ok) throw new Error(`sticker ${src}: ${res.status}`);
  return res.text();
}

/** Wait for a render to finish and return its print archive. */
export async function printArchive(jobId: string, timeoutMs = 120_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let status = '';
  while (Date.now() < deadline) {
    const res = await api(`render-status/${jobId}/`);
    const data = (await res.json()) as { status?: string; error?: string };
    status = data.status ?? '';
    if (status === 'completed') break;
    if (status === 'failed') throw new Error(`render failed: ${data.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== 'completed') throw new Error(`render did not finish in ${timeoutMs / 1000}s (last status: ${status || 'unknown'})`);
  const res = await api(`jobs/${jobId}/download/?content=print`);
  if (!res.ok) throw new Error(`print archive: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function listLayouts(): Promise<Array<{ name: string; productType?: string | null; templateCount?: number }>> {
  const res = await api('layouts');
  if (!res.ok) throw new Error(`layouts: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.layouts ?? data.results ?? [];
}

export async function purgeOrder(orderId: string, opts: { force?: boolean } = {}) {
  const qs = `all_tenants=true${opts.force ? '&force=true' : ''}`;
  const res = await api(`ops/orders/${encodeURIComponent(orderId)}/purge?${qs}`, { method: 'DELETE' });
  return res.status;
}

/** Celery workers the backend can see (GET /api/celery/monitor/ → workers.total). */
export async function workerCount(): Promise<number> {
  const res = await api('celery/monitor/');
  if (!res.ok) return 0;
  const data = (await res.json()) as { workers?: { total?: number } };
  return data.workers?.total ?? 0;
}
