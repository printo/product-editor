'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { createServerHeicConverter } from '@/lib/heic-convert';

/** Where the editor is running and for whom: the layout name, the embed token
 *  and parent origin, the order id (adopted from the embed session later, by
 *  useLayoutLoader) and ordered quantity, and which proxy requests go through. */
export function useEditorEnvironment() {
  const params = useParams();
  const layoutName = Array.isArray(params.name) ? params.name[0] : (params.name as string);
  const router = useRouter();
  const { data: session, status } = useSession();

  const embedToken = useMemo<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  }, []);

  // Resolve the parent window's origin for postMessage. Strict targetOrigin
  // prevents an unrelated outer page from eavesdropping on completion payloads
  // (which include order_id, job_id, and dataUrls for client-rendered jobs).
  // Resolution order: ancestorOrigins (Chromium/Safari) → document.referrer
  // → NEXT_PUBLIC_EMBED_PARENT_ORIGIN env. Falls back to a defaulted printo.in
  // host so production never silently leaks via '*'.
  const parentOrigin = useMemo<string>(() => {
    if (typeof window === 'undefined') return 'https://printo.in';
    const ancestors = (window.location as unknown as { ancestorOrigins?: { length: number; [i: number]: string } }).ancestorOrigins;
    if (ancestors && ancestors.length > 0 && ancestors[0]) return ancestors[0];
    if (document.referrer) {
      try { return new URL(document.referrer).origin; } catch { /* fall through */ }
    }
    return process.env.NEXT_PUBLIC_EMBED_PARENT_ORIGIN || 'https://printo.in';
  }, []);

  // Quantity enforcement (single-surface only). Two sources, in priority order:
  //
  //   1. EmbedSession.qty — set by the caller server-side, injected upstream as
  //      X-Order-Qty and echoed back by /editor/init below. This is the number
  //      POST /api/editor/render actually enforces, so it is the one the editor
  //      must cap against.
  //   2. the legacy ?qty=N URL param, kept as a fallback so callers that have
  //      not moved the value into the session body keep working during rollout.
  //      It lives in a URL the customer's browser owns, which is precisely why
  //      (1) exists — nothing server-side honours it.
  const urlQty = useMemo<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const v = new URLSearchParams(window.location.search).get('qty');
    const n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) || n <= 0 ? null : n;
  }, []);
  const [sessionQty, setSessionQty] = useState<number | null>(null);
  const orderQty = sessionQty ?? urlQty;

  // Stable order ID — read from URL or generate a new friendly ID.
  // Written back to the URL immediately so a refresh / share keeps the same ID.
  const [orderId, setOrderId] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const sp = new URLSearchParams(window.location.search);
    let id = sp.get('order_id');
    if (!id) {
      // Generate PE-XXXXXXXX (8 uppercase hex chars)
      const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      id = `PE-${hex}`;
    }
    return id;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !orderId) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('order_id') !== orderId) {
      sp.set('order_id', orderId);
      window.history.replaceState(null, '', `?${sp.toString()}`);
    }
  }, [orderId]);

  // Two distinct request paths, deliberately kept separate:
  //
  //   1. EMBED iframe flow → /api/embed/proxy/* with X-Embed-Token header.
  //      The proxy exchanges the short-lived UUID token for the real API key
  //      server-side; the browser never holds a real key.
  //
  //   2. PIA-LOGGED-IN dashboard/editor flow → /api/internal/proxy/* with no
  //      auth header at all.  The proxy uses the NextAuth session cookie to
  //      gate access and injects the server-side INTERNAL_API_KEY.  The
  //      browser never holds a real key here either — replacing the previous
  //      NEXT_PUBLIC_DIRECT_API_KEY which leaked into the client bundle.
  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (embedToken) return { 'X-Embed-Token': embedToken };
    // Internal proxy reads the session cookie automatically; no header needed.
    return {};
  }, [embedToken]);

  const apiBase = embedToken ? '/api/embed/proxy' : '/api/internal/proxy';

  // Last-resort HEIC decoder, running current libheif on the server. Needed
  // because the in-browser decoders cannot read the gain-map HDR photos
  // current iPhones write, and Chrome/Firefox have no HEIC codec at all.
  // Routed through whichever proxy this flow already uses, so the embed
  // iframe never sees an API key. See lib/heic-convert.ts.
  const serverHeicConvert = useMemo(
    () => createServerHeicConverter(apiBase, getAuthHeaders),
    [apiBase, getAuthHeaders],
  );

  return {
    layoutName, router, session, status, embedToken, parentOrigin, setSessionQty, orderQty,
    orderId, setOrderId, getAuthHeaders, apiBase, serverHeicConvert,
  };
}

/** Dashboard only: send a signed-out (or expired) session to the login page. */
export function useLoginRedirect({ status, session, embedToken, router }: {
  status: ReturnType<typeof useSession>['status'];
  session: ReturnType<typeof useSession>['data'];
  embedToken: string | null;
  router: { push(href: string): void };
}) {
  useEffect(() => {
    if ((status === 'unauthenticated' || session?.error === 'RefreshAccessTokenError') && !embedToken) {
      router.push('/login');
    }
  }, [status, session, embedToken, router]);
}
