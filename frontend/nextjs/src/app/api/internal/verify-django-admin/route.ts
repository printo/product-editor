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
 * separate, unrelated credential system — this route is the only place that
 * can actually answer "is this the same person who's logged into the
 * dashboard, and are they a superuser".
 *
 * Deliberately narrower than session.user.role === 'admin' (which also
 * includes is_ops_team) — Django admin can read/edit/delete every table
 * (orders, uploads, API keys), a bigger blast radius than the ops/*
 * dashboard routes that role already gates.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/pia-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();

  if (!session || session.error === 'RefreshAccessTokenError' || !session.is_super_user) {
    console.warn(
      `[verify-django-admin] denied for ${session?.user?.email ?? 'anonymous'}`
    );
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ detail: 'ok' }, { status: 200 });
}
