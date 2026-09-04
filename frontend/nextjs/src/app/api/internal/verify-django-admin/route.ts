/**
 * /api/internal/verify-django-admin
 *
 * Not called by the browser directly — this is the target of nginx's
 * `auth_request` directive on the /django-admin/ location (see nginx.conf).
 * nginx asks "is this request allowed through?" by issuing a GET subrequest
 * here with the original request's cookies attached; a 200 lets the real
 * request proceed to Django, anything else sends the visitor to the
 * /django-admin-denied page instead.
 *
 * Why this has to live in Next.js and not nginx or Django: the PIA/Google
 * session is a NextAuth JWT cookie signed with AUTH_SECRET, which only this
 * app holds. nginx can't decode it, and Django's own admin login is a
 * separate credential system — this route is the only place that can actually
 * answer "is this the same person who's logged into the dashboard, and are
 * they a superuser".
 *
 * Deliberately narrower than session.user.role === 'admin' (which also
 * includes is_ops_team) — Django admin can read/edit/delete every table
 * (orders, uploads, API keys), a bigger blast radius than the ops/*
 * dashboard routes that role already gates.
 *
 * ── Identity handoff ───────────────────────────────────────────────────────
 * A 200 also carries WHO the caller is, signed, so Django can log them into
 * the admin without a second password. nginx lifts these off the subrequest
 * response with `auth_request_set` and forwards them to Django, which
 * provisions a matching auth_user (see product_editor/admin_sso.py).
 *
 * The signature is the point. `proxy_set_header` already stops a client
 * forging these *through nginx*, but anything that reaches backend:8000
 * directly on the Docker network could otherwise mint itself `is_superuser`
 * over every table. Signing with the secret Django already shares means a
 * forged header fails regardless of the route it arrived by, so this does not
 * rest on the network topology being what we assume.
 */

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { auth } from '@/pia-auth';

export const dynamic = 'force-dynamic';

/** Must match product_editor/admin_sso.py — key derivation and payload shape. */
const KEY_PURPOSE = 'django-admin-sso/v1';
/** Must stay <= admin_sso.MAX_AGE_SECONDS, which rejects a longer-lived one. */
const TTL_SECONDS = 60;

function signIdentity(userId: string, email: string, expiresAt: number): string | null {
  const secret = process.env.EMBED_INTERNAL_SECRET || '';
  if (!secret) return null;
  const key = createHmac('sha256', secret).update(KEY_PURPOSE).digest();
  return createHmac('sha256', key).update(`${userId}\n${email}\n${expiresAt}`).digest('hex');
}

export async function GET() {
  const session = await auth();

  if (!session || session.error === 'RefreshAccessTokenError' || !session.is_super_user) {
    console.warn(
      `[verify-django-admin] denied for ${session?.user?.email ?? 'anonymous'}`
    );
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 });
  }

  const res = NextResponse.json({ detail: 'ok' }, { status: 200 });

  // A newline would let two different identities produce one signed payload,
  // so anything carrying one is not handed over at all — the request still
  // passes the gate, it just falls back to Django's own login.
  const userId = String(session.user?.id ?? '').trim();
  const email = String(session.user?.email ?? '').trim();
  if (userId && !userId.includes('\n') && !email.includes('\n')) {
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const sig = signIdentity(userId, email, expiresAt);
    if (sig) {
      res.headers.set('X-PE-Admin-Id', userId);
      res.headers.set('X-PE-Admin-Email', email);
      res.headers.set('X-PE-Admin-Exp', String(expiresAt));
      res.headers.set('X-PE-Admin-Sig', sig);
    } else {
      console.warn('[verify-django-admin] EMBED_INTERNAL_SECRET unset — admin SSO unavailable');
    }
  }
  return res;
}
