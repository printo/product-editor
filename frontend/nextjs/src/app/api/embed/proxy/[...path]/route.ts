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
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const INTERNAL_API =
  process.env.INTERNAL_API_URL ||
  (process.env.NEXT_PUBLIC_API_BASE_URL
    ? process.env.NEXT_PUBLIC_API_BASE_URL
    : 'http://backend:8000/api');

const INTERNAL_SECRET = process.env.EMBED_INTERNAL_SECRET || '';

/** Exchange an embed token for the real API key. Result is cached per token per request. */
async function resolveApiKey(embedToken: string): Promise<string | null> {
  const url = `${INTERNAL_API}/embed/session/validate?token=${encodeURIComponent(embedToken)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (INTERNAL_SECRET) headers['X-Internal-Secret'] = INTERNAL_SECRET;

  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.api_key ?? null;
  } catch {
    return null;
  }
}

async function handler(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const embedToken = req.headers.get('X-Embed-Token');
  if (!embedToken) {
    return NextResponse.json({ detail: 'X-Embed-Token header required' }, { status: 401 });
  }

  const apiKey = await resolveApiKey(embedToken);
  if (!apiKey) {
    return NextResponse.json({ detail: 'Invalid or expired embed token' }, { status: 401 });
  }

  // Build the upstream URL — join the path segments
  const upstreamPath = (params.path || []).join('/');
  const upstreamUrl = `${INTERNAL_API}/${upstreamPath}${req.nextUrl.search}`;

  // Forward only safe, non-hop-by-hop headers
  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: req.headers.get('Accept') || 'application/json',
  };
  const contentType = req.headers.get('Content-Type');
  if (contentType) forwardHeaders['Content-Type'] = contentType;

  let body: BodyInit | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // For multipart/form-data (file uploads) stream the raw body bytes so the
    // multipart boundary is preserved exactly as the browser sent it.
    body = await req.arrayBuffer();
    // Re-use the original Content-Type (includes boundary= for multipart)
    if (contentType) forwardHeaders['Content-Type'] = contentType;
    else delete forwardHeaders['Content-Type']; // let fetch determine it
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
