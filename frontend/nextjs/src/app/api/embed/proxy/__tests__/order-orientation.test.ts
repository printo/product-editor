/**
 * Embed proxy: the session's print orientation reaches Django as a header, or
 * not at all.
 *
 * Same path as `qty`: session row, this proxy's in-process cache, an injected
 * header. Only the two known words are forwarded; anything else reads as "serve
 * the layout as authored". The cache is the part worth pinning: a field left
 * out of the cached tuple would turn the layout on the first request and not
 * on the 110 minutes of requests after it.
 */
import { NextRequest } from 'next/server';

import { POST } from '../[...path]/route';

const UPSTREAM_OK = { json: 'ok' };

type ValidatePayload = Record<string, unknown>;

/** Mock Django: the validate endpoint answers with `session`, everything else 200s. */
function mockUpstream(session: ValidatePayload) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url: String(url), headers });
    if (String(url).includes('/embed/session/validate')) {
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(UPSTREAM_OK), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return {
    /** Headers the proxy forwarded on the render call (not the validate call). */
    renderHeaders: () => calls.filter(c => !c.url.includes('/validate')).map(c => c.headers),
  };
}

/** One render submission through the proxy, carrying the given embed token. */
async function submitRender(token: string) {
  const req = new NextRequest('http://localhost:3000/api/embed/proxy/editor/render', {
    method: 'POST',
    headers: { 'X-Embed-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout_name: 'classic_4x6', canvases: [] }),
  });
  return POST(req, { params: Promise.resolve({ path: ['editor', 'render'] }) });
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('X-Order-Orientation injection', () => {
  it.each(['portrait', 'landscape'])('forwards %s from the session', async (value) => {
    const upstream = mockUpstream({ api_key: 'k', order_id: 'EXT-1', orientation: value });
    await submitRender(`tok-orient-${value}`);
    expect(upstream.renderHeaders()[0]['X-Order-Orientation']).toBe(value);
  });

  it.each([null, undefined, '', 'sideways', 7, {}])(
    'omits the header for %p, so the layout is served as authored',
    async (bad) => {
      const upstream = mockUpstream({ api_key: 'k', orientation: bad });
      await submitRender(`tok-orient-bad-${JSON.stringify(bad) ?? 'undefined'}`);
      expect(upstream.renderHeaders()[0]).not.toHaveProperty('X-Order-Orientation');
    },
  );

  it('keeps forwarding it on cache hits, not just the first request', async () => {
    const upstream = mockUpstream({ api_key: 'k', order_id: 'EXT-2', orientation: 'portrait' });
    await submitRender('tok-orient-cached');
    await submitRender('tok-orient-cached');
    await submitRender('tok-orient-cached');
    const headers = upstream.renderHeaders();
    expect(headers).toHaveLength(3);
    headers.forEach(h => expect(h['X-Order-Orientation']).toBe('portrait'));
    expect((global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => String(url).includes('/validate'),
    )).toHaveLength(1);
  });
});
