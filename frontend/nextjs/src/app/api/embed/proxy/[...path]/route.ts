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
interface CacheEntry { apiKey: string; orderId: string | null; callbackUrl: string | null; exp: number }
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

interface SessionInfo { apiKey: string; orderId: string | null; callbackUrl: string | null }

/**
 * Exchange an embed token for the real API key, order_id, and callback_url.
 * Returns the cached value if still valid; otherwise hits Django's internal
 * validate endpoint and stores the result.
 */
async function resolveSession(embedToken: string): Promise<SessionInfo | null> {
  const now = Date.now();

  // Fast path: valid cached entry.
  const cached = tokenCache.get(embedToken);
  if (cached && cached.exp > now) {
    return { apiKey: cached.apiKey, orderId: cached.orderId, callbackUrl: cached.callbackUrl };
  }

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
      const callbackUrl: string | null = data.callback_url || null;
      tokenCache.set(embedToken, { apiKey, orderId, callbackUrl, exp: now + CACHE_TTL_MS });
      return { apiKey, orderId, callbackUrl };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Path allowlist ───────────────────────────────────────────────────────────
// Embed sessions are scoped to customer-facing endpoints only. This guards
// against a stolen / replayed embed token being used to call ops or admin
// surfaces with the upstream API key.
const ALLOWED_PATH_PREFIXES = [
  'layouts',           // GET layout details (no list/manage)
  'canvas-state',      // editor auto-save / restore
  'editor/render',     // server-side render submission
  'editor/init',       // batched layout + fonts on editor mount (C6)
  'render-status',     // poll render status
  'jobs',              // download completed render
  'upload',            // chunked file upload
  'fonts',             // GET only — list fonts (PUT requires ops auth at backend)
  'sku-layouts',       // GET only — resolve SKU → layout
  'embed/session',     // self-validate (rare; mostly internal)
] as const;

function isPathAllowed(p: string): boolean {
  if (!p) return false;
  // Exact match or prefix match with a `/` boundary
  return ALLOWED_PATH_PREFIXES.some(allowed =>
    p === allowed || p.startsWith(`${allowed}/`)
  );
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const embedToken = req.headers.get('X-Embed-Token');
  if (!embedToken) {
    return NextResponse.json({ detail: 'X-Embed-Token header required' }, { status: 401 });
  }

  // Build the upstream URL — join the path segments
  const { path } = await params;
  const upstreamPath = (path || []).join('/');

  // Path allowlist — reject ops/admin/anything not customer-facing BEFORE
  // we even validate the token, so attackers can't probe Django auth surfaces.
  if (!isPathAllowed(upstreamPath)) {
    return NextResponse.json(
      { detail: 'Path not permitted via embed proxy' },
      { status: 403 },
    );
  }

  const session = await resolveSession(embedToken);
  if (!session) {
    return NextResponse.json({ detail: 'Invalid or expired embed token' }, { status: 401 });
  }
  const { apiKey, orderId, callbackUrl } = session;

  const upstreamUrl = `${INTERNAL_API}/${upstreamPath}${req.nextUrl.search}`;

  // Forward only safe, non-hop-by-hop headers. Accept-Encoding: identity
  // — see the matching note in /api/internal/proxy/[...path]/route.ts —
  // prevents the gzip-on-streaming-chunked truncation when nginx gzips the
  // browser-facing response.
  const contentType = req.headers.get('Content-Type');
  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: req.headers.get('Accept') || 'application/json',
    'Accept-Encoding': 'identity',
  };
  // Inject the caller's order_id for the render endpoint so Django can track the job
  if (orderId) forwardHeaders['X-Order-ID'] = orderId;
  // Callback URL flows through the same header pattern. EditorRenderView reads
  // it and stamps onto CanvasData.callback_url; the Celery task POSTs the
  // completion payload to it. The customer in the iframe never sees this.
  if (callbackUrl) forwardHeaders['X-Callback-URL'] = callbackUrl;
  // Only set Content-Type when we'll actually have a body — for GET/HEAD
  // it's meaningless and some upstreams reject the combination.
  if (contentType && req.method !== 'GET' && req.method !== 'HEAD') {
    forwardHeaders['Content-Type'] = contentType;
  }

  let body: BodyInit | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // For multipart/form-data (file uploads) stream the raw body bytes so the
    // multipart boundary is preserved exactly as the browser sent it.
    //
    // Wrap in a Blob (re-readable) instead of using the ArrayBuffer directly:
    // Node's undici-based fetch DETACHES an ArrayBuffer when it's transferred
    // to the network layer, so any 3xx redirect from the upstream (e.g.
    // Django's 301 to add a trailing slash on /api/canvas-state/<id>/) fails
    // the body re-send with "Cannot perform ArrayBuffer.prototype.slice on a
    // detached ArrayBuffer". A Blob owns its bytes and can be read again on
    // each retry, so redirects flow through transparently.
    const arrayBuf = await req.arrayBuffer();
    body = arrayBuf.byteLength > 0 ? new Blob([arrayBuf]) : null;
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    // Stream the response body through unbuffered. The previous
    // `await upstream.arrayBuffer()` pinned the entire ZIP (up to ~500 MB
    // for a 200-photo render) in the Next.js worker on every download.
    // Forward content-relevant response headers verbatim so the browser
    // sees the right filename (Content-Disposition) and progress
    // indicator (Content-Length).
    const passthroughHeaders = new Headers();
    const upstreamCT = upstream.headers.get('Content-Type');
    passthroughHeaders.set('Content-Type', upstreamCT || 'application/json');
    const upstreamCL = upstream.headers.get('Content-Length');
    if (upstreamCL) passthroughHeaders.set('Content-Length', upstreamCL);
    const upstreamCD = upstream.headers.get('Content-Disposition');
    if (upstreamCD) passthroughHeaders.set('Content-Disposition', upstreamCD);

    const responseStream = upstream.status === 204 || upstream.status === 304
      ? null
      : upstream.body;

    return new NextResponse(responseStream, {
      status: upstream.status,
      headers: passthroughHeaders,
    });
  } catch (err: any) {
    console.error('[embed-proxy] upstream error:', err);
    return NextResponse.json({ detail: 'Proxy error' }, { status: 502 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
