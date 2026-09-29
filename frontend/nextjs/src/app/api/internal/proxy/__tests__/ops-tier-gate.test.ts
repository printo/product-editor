/**
 * Internal proxy: the Ops-tier gate is applied to the calendar aliases.
 *
 * `lib/__tests__/ops-guard.test.ts` pins which paths need the Ops tier; this
 * pins that the proxy actually consults it for them. Django routes
 * `calendar-styles/<name>` and `holidays/<locale>/<year>` to the same views
 * as their `ops/` twins, and every request from here carries the ops-flagged
 * INTERNAL_API_KEY — so if this gate lets an Editor-tier write through, the
 * only remaining check is Django's route-level method restriction.
 */
import { NextRequest } from 'next/server';

jest.mock('@/pia-auth', () => ({ auth: jest.fn() }));

import { auth } from '@/pia-auth';

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) => Promise<Response>;

let handlers: Record<string, Handler>;

const EDITOR = {
  user: { email: 'editor@printo.in' },
  is_staff: false,
  is_ops_team: false,
  registration_status: 'ACTIVE',
};
const OPS = { ...EDITOR, user: { email: 'ops@printo.in' }, is_ops_team: true };

const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeAll(async () => {
  // Read at module load, so it must be set before the route is imported.
  process.env.INTERNAL_API_KEY = 'test-internal-key';
  const { GET, PUT, DELETE } = await import('../[...path]/route');
  handlers = { GET, PUT, DELETE };
});

beforeEach(() => {
  fetchMock = jest.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function asSession(session: object) {
  (auth as unknown as jest.Mock).mockResolvedValue(session);
}

function call(method: string, path: string) {
  const req = new NextRequest(`http://localhost:3000/api/internal/proxy/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({ events: [] }),
  });
  return handlers[method](req, { params: Promise.resolve({ path: path.split('/') }) });
}

describe('Editor tier', () => {
  it.each([
    ['PUT', 'calendar-styles/modern-genz'],
    ['PUT', 'holidays/en-IN/2026'],
    ['DELETE', 'holidays/en-IN/2026'],
  ])('is refused on %s %s, and nothing reaches Django', async (method, path) => {
    asSession(EDITOR);
    const res = await call(method, path);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'calendar-styles/modern-genz',
    'holidays/en-IN/2026',
  ])('can still read %s — the editor loads it on mount', async path => {
    asSession(EDITOR);
    const res = await call('GET', path);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Ops tier', () => {
  it('is forwarded, leaving the alias-vs-ops/ decision to Django', async () => {
    asSession(OPS);
    const res = await call('PUT', 'calendar-styles/modern-genz');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/calendar-styles\/modern-genz$/);
  });
});
