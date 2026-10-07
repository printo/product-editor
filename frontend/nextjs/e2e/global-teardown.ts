/**
 * Purge every order the run created — rows, uploads and exports — through the
 * same ops erasure endpoint the DPDP purge uses. The endpoint answers 409 while
 * an order's render is still running, so those are retried for up to a minute
 * and only then forced.
 */
import fs from 'node:fs';
import { purgeOrder } from './support/api';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalTeardown() {
  const file = process.env.E2E_ORDERS_FILE;
  if (!file || !fs.existsSync(file)) return;
  const orders = [...new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean))];
  const status = new Map<string, number>();
  for (const o of orders) status.set(o, await purgeOrder(o));
  for (let i = 0; i < 20 && [...status.values()].includes(409); i++) {
    await sleep(3000);
    for (const [o, s] of status) if (s === 409) status.set(o, await purgeOrder(o));
  }
  for (const [o, s] of status) if (s === 409) status.set(o, await purgeOrder(o, { force: true }));
  const failed = [...status].filter(([, s]) => ![200, 404].includes(s));
  console.log(`[e2e] purged ${orders.length - failed.length}/${orders.length} test orders${failed.length ? `; failed: ${failed.map(([o, s]) => `${o}=${s}`).join(', ')}` : ''}`);
  fs.unlinkSync(file);
}
