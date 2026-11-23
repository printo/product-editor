/**
 * Both proxies pass nginx's X-Real-IP on to Django, so the per-IP rate limit
 * sees the customer and not the frontend container.
 */
import { NextRequest } from 'next/server';

jest.mock('@/pia-auth', () => ({ auth: jest.fn() }));

import { auth } from '@/pia-auth';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function capture() {
  const seen: Record<string, string>[] = [];
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return seen;
}

it('internal proxy forwards X-Real-IP when present, nothing when absent', async () => {
  process.env.INTERNAL_API_KEY = 'k';
  (auth as unknown as jest.Mock).mockResolvedValue({
    user: { email: 'a@printo.in' }, is_staff: false, is_ops_team: false, registration_status: 'ACTIVE',
  });
  const { GET } = await import('../../../internal/proxy/[...path]/route');
  const seen = capture();
  const ctx = { params: Promise.resolve({ path: ['layouts'] }) };
  await GET(new NextRequest('http://localhost/api/internal/proxy/layouts', { headers: { 'x-real-ip': '203.0.113.9' } }), ctx);
  await GET(new NextRequest('http://localhost/api/internal/proxy/layouts'), ctx);
  expect(seen[0]['X-Real-IP']).toBe('203.0.113.9');
  expect(seen[1]['X-Real-IP']).toBeUndefined();
});

it('embed proxy forwards X-Real-IP on the upstream call', async () => {
  const seen = capture();
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    const body = String(url).includes('/embed/session/validate')
      ? { api_key: 'key', order_id: 'O-1', callback_url: null, include_uploads: true, qty: null }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const { GET } = await import('../[...path]/route');
  await GET(
    new NextRequest('http://localhost/api/embed/proxy/layouts', {
      headers: { 'x-real-ip': '203.0.113.9', 'x-embed-token': 'tok-ip-1' },
    }),
    { params: Promise.resolve({ path: ['layouts'] }) },
  );
  expect(seen.some((h) => h['X-Real-IP'] === '203.0.113.9')).toBe(true);
});
