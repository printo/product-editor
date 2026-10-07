/**
 * Fail fast with a useful message if the local stack isn't ready, pick the
 * layouts the specs use, and start the list of orders to purge afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { e2eEnv } from './support/env';
import { listLayouts, workerCount } from './support/api';

export default async function globalSetup() {
  const env = e2eEnv();
  if (!env.apiKey) throw new Error('No API key: set E2E_API_KEY or provide DIRECT_API_KEY in the repo-root .env');
  const health = await fetch(`${env.apiUrl}/health`).catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(`Backend not reachable at ${env.apiUrl}/health — start the local stack (docker-compose up -d db redis backend).`);
  }
  const layouts = await listLayouts();
  const plain = layouts.filter((l) => !l.productType || !['calendar', 'book'].includes(l.productType)).map((l) => l.name).sort();
  process.env.E2E_LAYOUT = process.env.E2E_LAYOUT ?? plain[0];
  if (!process.env.E2E_LAYOUT) throw new Error('No non-calendar layout in the local catalogue to test against.');
  process.env.E2E_CALENDAR_LAYOUT = process.env.E2E_CALENDAR_LAYOUT
    ?? layouts.find((l) => l.productType === 'calendar')?.name ?? '';
  process.env.E2E_WORKERS = String(await workerCount());
  process.env.E2E_ORDERS_FILE = path.join(os.tmpdir(), `pe-e2e-orders-${Date.now()}.txt`);
  fs.writeFileSync(process.env.E2E_ORDERS_FILE, '');
  console.log(`[e2e] layout=${process.env.E2E_LAYOUT} calendar=${process.env.E2E_CALENDAR_LAYOUT || '(none)'} celery workers=${process.env.E2E_WORKERS}`);
}
