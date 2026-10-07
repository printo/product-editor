/**
 * Where the smoke suite points, and the secrets it needs — resolved from env
 * vars first, then from the developer's own (gitignored) env files.
 *
 *   E2E_BASE_URL   frontend under test        (default http://localhost:3057)
 *   E2E_API_URL    backend, for test setup     (default http://127.0.0.1:8001/api)
 *   E2E_API_KEY    an ops-flagged API key      (default DIRECT_API_KEY from the root .env)
 *   E2E_ENV_LOCAL  frontend env file           (default ./.env.local)
 *   E2E_ROOT_ENV   repo-root env file          (default ../../.env)
 *
 * Refuses to run against anything but this machine unless E2E_ALLOW_REMOTE=1:
 * the suite creates sessions, uploads photos and purges orders.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The fake storefront page that iframes the editor (see support/editor.ts).
 * A local origin on another port: still cross-origin to the editor, like
 * printo.in in production, but Chrome's Local Network Access checks block a
 * public-looking origin from framing localhost (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS).
 */
export const PARENT_ORIGIN = 'http://localhost:3999';
/** The editor's default frame-ancestors, plus the fake storefront — test builds only. */
export const TEST_FRAME_ANCESTORS = `'self' https://printo.in https://*.printo.in ${PARENT_ORIGIN}`;

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const key = s.slice(0, i).replace(/^export\s+/, '').trim();
    let value = s.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    out[key] = value;
  }
  return out;
}

function assertLocal(url: string, what: string) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.E2E_ALLOW_REMOTE !== '1') {
    throw new Error(`${what} (${url}) is not this machine. The smoke suite writes data; set E2E_ALLOW_REMOTE=1 only if you mean it.`);
  }
}

export function e2eEnv() {
  const root = path.resolve(__dirname, '..', '..');
  const envLocal = readEnvFile(process.env.E2E_ENV_LOCAL ?? path.join(root, '.env.local'));
  const rootEnv = readEnvFile(process.env.E2E_ROOT_ENV ?? path.join(root, '..', '..', '.env'));
  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3057';
  const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8001/api';
  assertLocal(baseUrl, 'E2E_BASE_URL');
  assertLocal(apiUrl, 'E2E_API_URL');
  const port = new URL(baseUrl).port || '3057';
  return {
    baseUrl,
    apiUrl,
    apiKey: process.env.E2E_API_KEY ?? rootEnv.DIRECT_API_KEY ?? '',
    authSecret: process.env.E2E_AUTH_SECRET ?? envLocal.AUTH_SECRET ?? '',
    startServer: process.env.E2E_SKIP_SERVER !== '1',
    // A production build: the dev bundler has broken paths the real app doesn't
    // (pica's workers die under Turbopack), and production is what ships.
    serverCommand: process.env.E2E_SERVER_COMMAND ?? `pnpm build && pnpm start -p ${port}`,
    serverEnv: {
      INTERNAL_API_URL: apiUrl,
      NEXT_PUBLIC_API_BASE_URL: apiUrl,
      AUTH_SECRET: process.env.E2E_AUTH_SECRET ?? envLocal.AUTH_SECRET ?? '',
      INTERNAL_API_KEY: envLocal.INTERNAL_API_KEY ?? rootEnv.INTERNAL_API_KEY ?? '',
      EMBED_INTERNAL_SECRET: envLocal.EMBED_INTERNAL_SECRET ?? rootEnv.EMBED_INTERNAL_SECRET ?? '',
      AUTH_TRUST_HOST: 'true',
      // Inlined at build time. Without it Chrome (correctly) refuses to load the
      // editor inside the fake storefront page.
      NEXT_PUBLIC_EMBED_FRAME_ANCESTORS: process.env.E2E_FRAME_ANCESTORS ?? TEST_FRAME_ANCESTORS,
    },
  };
}
