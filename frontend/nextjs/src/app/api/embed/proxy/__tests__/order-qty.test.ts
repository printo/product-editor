/**
 * Embed proxy: the ordered quantity reaches Django as a header, or not at all.
 *
 * `qty` used to travel on the iframe URL, where the customer's browser could
 * edit it. It now rides the same path `order_id` does — session row → this
 * proxy's in-process cache → an injected header — so the number the render
 * endpoint enforces is the caller's, not the browser's.
 *
 * The cache is the part worth pinning. Entries live for 110 minutes, so a
 * field left out of the cached tuple would be present on the first request of
 * a session and silently absent for every one after it: the quantity would be
 * enforced once and then not, which is far worse than never enforcing it.
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

describe('X-Order-Qty injection', () => {
  it('forwards a session quantity that the browser never supplied', async () => {
    const upstream = mockUpstream({ api_key: 'k', order_id: 'EXT-1', qty: 12 });
    const res = await submitRender('tok-qty-basic');
    expect(res.status).toBe(202);
    expect(upstream.renderHeaders()[0]['X-Order-Qty']).toBe('12');
    // Sanity: it travels beside order_id, by the same mechanism.
    expect(upstream.renderHeaders()[0]['X-Order-ID']).toBe('EXT-1');
  });

  it('omits the header when the session carries no quantity', async () => {
    // Absent means "do not enforce" — an omitted header, not a 0 that would
    // cap the order at nothing. Every session created before qty existed
    // resolves this way, so this is the backward-compatible path.
    const upstream = mockUpstream({ api_key: 'k', order_id: 'EXT-2', qty: null });
    await submitRender('tok-qty-null');
    expect(upstream.renderHeaders()[0]).not.toHaveProperty('X-Order-Qty');
  });

  it('omits the header for an older Django build that returns no qty field', async () => {
    const upstream = mockUpstream({ api_key: 'k', order_id: 'EXT-3' });
    await submitRender('tok-qty-missing');
    expect(upstream.renderHeaders()[0]).not.toHaveProperty('X-Order-Qty');
  });

  it.each([0, -5, 1.5, '12', true, {}])(
    'drops a %p quantity rather than forwarding it as a cap',
    async (bad) => {
      const upstream = mockUpstream({ api_key: 'k', qty: bad });
      await submitRender(`tok-qty-bad-${JSON.stringify(bad)}`);
      expect(upstream.renderHeaders()[0]).not.toHaveProperty('X-Order-Qty');
    },
  );

  it('keeps forwarding the quantity on cache hits, not just the first request', async () => {
    // The regression this file exists for: qty must be part of the cached
    // tuple. If it were resolved fresh but not stored, request 1 would carry
    // the header and requests 2..n — the whole 110-minute session — would not.
    const upstream = mockUpstream({ api_key: 'k', order_id: 'EXT-4', qty: 3 });
    await submitRender('tok-qty-cached');
    await submitRender('tok-qty-cached');
    await submitRender('tok-qty-cached');
    const headers = upstream.renderHeaders();
    expect(headers).toHaveLength(3);
    headers.forEach(h => expect(h['X-Order-Qty']).toBe('3'));
    // And the cache did its job: one validate call for three submissions.
    expect((global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => String(url).includes('/validate'),
    )).toHaveLength(1);
  });
});
