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

export async function createEmbedSession(opts: { orderId?: string; qty?: number; includeUploads?: boolean } = {}) {
  const orderId = opts.orderId ?? newOrderId();
  const body: Record<string, unknown> = { order_id: orderId };
  if (opts.qty != null) body.qty = opts.qty;
  if (opts.includeUploads != null) body.include_uploads = opts.includeUploads;
  const res = await api('embed/session', { method: 'POST', body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`embed session: ${res.status} ${await res.text()}`);
  rememberOrder(orderId);
  const data = (await res.json()) as { token: string };
  return { orderId, token: data.token };
}

export async function listLayouts(): Promise<Array<{ name: string; productType?: string | null }>> {
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
