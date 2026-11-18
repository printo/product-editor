/**
 * Internal proxy: a failed upstream call answers 502 with no cause in the body.
 *
 * The body used to carry `err.message`, which for a refused connection names the
 * internal host and port ("connect ECONNREFUSED 172.18.0.4:8000"). The cause
 * stays in the server log.
 */
import { NextRequest } from 'next/server';

jest.mock('@/pia-auth', () => ({ auth: jest.fn() }));

import { auth } from '@/pia-auth';

const SESSION = {
  user: { email: 'editor@printo.in' },
  is_staff: false,
  is_ops_team: false,
  registration_status: 'ACTIVE',
};

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

it('answers 502 without the error message, and logs it', async () => {
  process.env.INTERNAL_API_KEY = 'test-internal-key';
  (auth as unknown as jest.Mock).mockResolvedValue(SESSION);
  global.fetch = jest.fn(async () => {
    throw new Error('connect ECONNREFUSED 172.18.0.4:8000');
  }) as unknown as typeof fetch;
  const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

  const { GET } = await import('../[...path]/route');
  const res = await GET(
    new NextRequest('http://localhost:3000/api/internal/proxy/layouts'),
    { params: Promise.resolve({ path: ['layouts'] }) },
  );

  expect(res.status).toBe(502);
  const body = await res.text();
  expect(JSON.parse(body)).toEqual({ detail: 'Proxy error' });
  expect(body).not.toMatch(/ECONNREFUSED|172\.18|8000/);
  expect(logged).toHaveBeenCalled();
});
