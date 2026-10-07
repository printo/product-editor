/**
 * A dashboard session without a password: mint the NextAuth cookie with the
 * local AUTH_SECRET (the CLAUDE.md recipe). PIA credentials are never typed
 * into the login form — that would send them to the production PIA service.
 */
import { encode } from 'next-auth/jwt';
import type { BrowserContext } from '@playwright/test';
import { e2eEnv } from './env';

export type Tier = 'editor' | 'ops' | 'admin';

export async function signIn(context: BrowserContext, tier: Tier = 'editor') {
  const { authSecret, baseUrl } = e2eEnv();
  if (!authSecret) throw new Error('No AUTH_SECRET (set E2E_AUTH_SECRET or provide frontend/nextjs/.env.local)');
  const now = Math.floor(Date.now() / 1000);
  const thirtyDays = 30 * 24 * 3600;
  const value = await encode({
    salt: 'authjs.session-token',
    secret: authSecret,
    token: {
      id: 'E2E', name: 'E2E Tester', email: 'e2e@printo.in', role: 'user',
      is_staff: tier === 'admin',
      is_ops_team: tier !== 'editor',
      registration_status: 'ACTIVE',
      accessToken: 'e2e', refreshToken: 'e2e',
      // Far in the future: a near expiry triggers a refresh with the fake token,
      // which fails and bounces every protected page to /login.
      accessTokenExpires: (now + thirtyDays) * 1000,
      sub: 'E2E', iat: now, exp: now + thirtyDays,
    },
  });
  await context.addCookies([{
    name: 'authjs.session-token', value, url: baseUrl, httpOnly: true, sameSite: 'Lax',
  }]);
}
