/**
 * /api/embed/proxy/[...path]
 *
 * Server-side proxy for the embed editor.  The browser never holds the real
 * API key — it only has the short-lived embed token (a UUID).
 *
 * Flow:
 *   1. Browser sends request with header `X-Embed-Token: <uuid>`
 *   2. This handler calls Django's internal validate endpoint to exchange the
 *      token for the real API key (server → server, never client-visible).
 *   3. The real request is forwarded to Django with `Authorization: Bearer <key>`.
 *   4. The response is streamed back to the browser.
 *
 * Token cache:
 *   Embed sessions live for 2 hours.  Without caching, every proxied request
 *   (including canvas-state auto-saves every 2 s) hits the Django validate
 *   endpoint and therefore the DB.  The in-process Map below makes that a
 *   single DB round-trip per session instead of one per request.
 *
 *   TTL is set to 110 minutes so we re-validate 10 minutes before the session
 *   would naturally expire, preventing stale cache entries serving a revoked token.
 *   Expired entries are lazily evicted on each cache miss to keep memory bounded.
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const INTERNAL_API =
  process.env.INTERNAL_API_URL ||
  (process.env.NEXT_PUBLIC_API_BASE_URL
    ? process.env.NEXT_PUBLIC_API_BASE_URL
    : 'http://backend:8000/api');

const INTERNAL_SECRET = process.env.EMBED_INTERNAL_SECRET || '';

// ── In-process token → API key cache ─────────────────────────────────────────
// Module-level so it persists across requests within the same Next.js worker
// process (Node.js keeps module scope alive between hot invocations).
interface CacheEntry { apiKey: string; orderId: string | null; exp: number }
const tokenCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 110 * 60 * 1000; // 110 minutes (session TTL is 120 min)
// Hard cap to prevent unbounded growth in pathological scenarios
// (e.g. an attacker spraying random tokens — each miss creates no entry,
// but legitimate concurrent embeds across many tenants could still accumulate).
const CACHE_MAX_ENTRIES = 10_000;

/** Remove all entries whose TTL has elapsed — called on every cache miss. */
function evictExpired(): void {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (entry.exp <= now) tokenCache.delete(token);
  }
  // If still over the cap after expiry sweep, drop oldest insertion order
  // entries (Map preserves insertion order in JS) until we're back under.
  if (tokenCache.size > CACHE_MAX_ENTRIES) {
    const overflow = tokenCache.size - CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const token of tokenCache.keys()) {
      tokenCache.delete(token);
      if (++removed >= overflow) break;
    }
  }
}

interface SessionInfo { apiKey: string; orderId: string | null }

/**
 * Exchange an embed token for the real API key and order_id.
 * Returns the cached value if still valid; otherwise hits Django's internal
 * validate endpoint and stores the result.
 */
async function resolveSession(embedToken: string): Promise<SessionInfo | null> {
  const now = Date.now();

  // Fast path: valid cached entry.
  const cached = tokenCache.get(embedToken);
  if (cached && cached.exp > now) return { apiKey: cached.apiKey, orderId: cached.orderId };

  // Cache miss — purge stale entries then fetch from Django.
  evictExpired();

  const url = `${INTERNAL_API}/embed/session/validate?token=${encodeURIComponent(embedToken)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (INTERNAL_SECRET) headers['X-Internal-Secret'] = INTERNAL_SECRET;

  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) {
      // Token is invalid or revoked — remove any stale cache entry.
      tokenCache.delete(embedToken);
      return null;
    }
    const data = await res.json();
    const apiKey: string | null = data.api_key ?? null;
    if (apiKey) {
      const orderId: string | null = data.order_id || null;
      tokenCache.set(embedToken, { apiKey, orderId, exp: now + CACHE_TTL_MS });
      return { apiKey, orderId };
    }
    return null;
  } catch {
    return null;
  }
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const embedToken = req.headers.get('X-Embed-Token');
  if (!embedToken) {
    return NextResponse.json({ detail: 'X-Embed-Token header required' }, { status: 401 });
  }

  const session = await resolveSession(embedToken);
  if (!session) {
    return NextResponse.json({ detail: 'Invalid or expired embed token' }, { status: 401 });
  }
  const { apiKey, orderId } = session;

  // Build the upstream URL — join the path segments
  const { path } = await params;
  const upstreamPath = (path || []).join('/');
  const upstreamUrl = `${INTERNAL_API}/${upstreamPath}${req.nextUrl.search}`;

  // Forward only safe, non-hop-by-hop headers
  const contentType = req.headers.get('Content-Type');
  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: req.headers.get('Accept') || 'application/json',
  };
  // Inject the caller's order_id for the render endpoint so Django can track the job
  if (orderId) forwardHeaders['X-Order-ID'] = orderId;
  // Only set Content-Type when we'll actually have a body — for GET/HEAD
  // it's meaningless and some upstreams reject the combination.
  if (contentType && req.method !== 'GET' && req.method !== 'HEAD') {
    forwardHeaders['Content-Type'] = contentType;
  }

  let body: BodyInit | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // For multipart/form-data (file uploads) stream the raw body bytes so the
    // multipart boundary is preserved exactly as the browser sent it.
    body = await req.arrayBuffer();
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    const responseContentType = upstream.headers.get('Content-Type') || 'application/json';
    const responseBody = await upstream.arrayBuffer();

    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: { 'Content-Type': responseContentType },
    });
  } catch (err: any) {
    console.error('[embed-proxy] upstream error:', err);
    return NextResponse.json({ detail: 'Proxy error' }, { status: 502 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
