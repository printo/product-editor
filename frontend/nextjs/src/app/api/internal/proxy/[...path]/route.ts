/**
 * /api/internal/proxy/[...path]
 *
 * Server-side proxy for *authenticated* dashboard / editor users.
 *
 * Why this exists:
 *   The dashboard and editor pages used to read NEXT_PUBLIC_DIRECT_API_KEY
 *   directly in the browser to call Django.  Anything prefixed NEXT_PUBLIC_
 *   gets baked into the client JS bundle, so the bearer token was extractable
 *   from DevTools and could be replayed by anyone who visited the site.
 *
 *   This proxy keeps the API key strictly server-side (env var INTERNAL_API_KEY,
 *   never exposed to the client) and gates every call behind a valid NextAuth
 *   session.  The browser only ever holds its NextAuth session cookie.
 *
 * Relationship to /api/embed/proxy:
 *   The embed flow is a completely separate code path — it uses an X-Embed-Token
 *   header (a UUID) and exchanges it for an API key via Django's validate
 *   endpoint.  This file does NOT touch the embed flow at all.  Iframes still
 *   call /api/embed/proxy/... unchanged.
 *
 * Auth model:
 *   1. Browser must have a valid NextAuth session cookie
 *      (set by the PIA login flow in /app/actions/auth.ts).
 *   2. auth() resolves the session server-side; no session → 401.
 *   3. The request is forwarded to Django with the server-side INTERNAL_API_KEY
 *      as the Bearer token.  Django's BearerTokenAuthentication resolves it
 *      to the corresponding APIKey row.
 *
 *   We use the API key (not the user's session.accessToken) because some
 *   endpoints — notably the render/generate endpoint — require an APIKeyUser
 *   on the backend, not a PIAUser.  Using the API key uniformly here keeps
 *   the proxy a single code path that can serve every endpoint the dashboard
 *   needs without per-route branching.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/pia-auth';

export const dynamic = 'force-dynamic';

const INTERNAL_API =
  process.env.INTERNAL_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'http://backend:8000/api';

// Server-only — must NOT be prefixed NEXT_PUBLIC_.
// Falls back to the legacy public var during migration so the proxy keeps
// working before the env file is updated; remove the fallback once
// INTERNAL_API_KEY is set in every environment.
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || process.env.NEXT_PUBLIC_DIRECT_API_KEY || '';

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // 1. Gate: must have a valid NextAuth session.
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { detail: 'Authentication required' },
      { status: 401 }
    );
  }
  // Surface refresh failures to the client so it can re-authenticate.
  if (session.error === 'RefreshAccessTokenError') {
    return NextResponse.json(
      { detail: 'Session expired — please log in again' },
      { status: 401 }
    );
  }

  if (!INTERNAL_API_KEY) {
    console.error(
      '[internal-proxy] INTERNAL_API_KEY is not configured — refusing to proxy'
    );
    return NextResponse.json(
      { detail: 'Server misconfigured: internal API key missing' },
      { status: 500 }
    );
  }

  // 2. Build upstream URL from the captured path segments + original querystring.
  const { path } = await params;
  const upstreamPath = (path || []).join('/');

  // Preserve trailing slash if present in the original URL
  const hasTrailingSlash = req.nextUrl.pathname.endsWith('/');
  const fullUpstreamPath = hasTrailingSlash ? `${upstreamPath}/` : upstreamPath;

  // 2a. Privilege guard for ops endpoints.
  //
  // Backend ops/* views use IsOpsTeam, which inspects the *authenticated user*.
  // When the request flows through this proxy, the backend sees the injected
  // INTERNAL_API_KEY's APIKeyUser — which is ops-flagged on purpose so that
  // ops actions work at all.  That means without an explicit gate here, ANY
  // logged-in PIA user could trigger ops mutations (delete layout, etc.).
  //
  // We replicate the IsOpsTeam check in the proxy itself: only sessions
  // flagged is_ops_team may proxy to /ops/* paths.
  if (upstreamPath.startsWith('ops/') || upstreamPath === 'ops') {
    if (!session.is_ops_team) {
      return NextResponse.json(
        { detail: 'Operations team membership required' },
        { status: 403 }
      );
    }
  }

  const upstreamUrl = `${INTERNAL_API}/${fullUpstreamPath}${req.nextUrl.search}`;

  // 3. Build forwarded headers — only safe, non-hop-by-hop ones.
  const contentType = req.headers.get('Content-Type');
  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${INTERNAL_API_KEY}`,
    Accept: req.headers.get('Accept') || 'application/json',
  };
  if (contentType && req.method !== 'GET' && req.method !== 'HEAD') {
    // Preserve multipart boundary etc. exactly.
    forwardHeaders['Content-Type'] = contentType;
  }

  // 4. Pipe the body through unchanged for write methods.
  let body: BodyInit | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer();
  }

  // 5. Forward and stream the response back.
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
      // Don't let Next cache anything — every call is request-scoped.
      cache: 'no-store',
    });

    const responseContentType =
      upstream.headers.get('Content-Type') || 'application/json';
    
    // Read body as arrayBuffer. If 204/304, it will be empty.
    let responseBody: ArrayBuffer | null = null;
    if (upstream.status !== 204 && upstream.status !== 304) {
      responseBody = await upstream.arrayBuffer();
    }

    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: { 
        'Content-Type': responseContentType,
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (err: any) {
    console.error('[internal-proxy] upstream error:', err);
    return NextResponse.json(
      { detail: 'Proxy error', error: err.message },
      { status: 502 }
    );
  }
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
