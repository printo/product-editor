/**
 * Where /login sends a user once signed in. The address carries its query
 * (`/dashboard?tag=photo_frame`) so a filtered link survives the login, but it
 * must stay on this site: the login actions hand it straight to
 * `window.location`, which NextAuth's `redirect` callback never sees.
 */

const FALLBACK = '/dashboard';

export function safeCallbackPath(raw: string | null | undefined): string {
  if (!raw) return FALLBACK;
  // One leading slash only: `//host` and `/\host` are other sites to a browser.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return FALLBACK;
  try {
    const base = 'http://same.invalid';
    const url = new URL(raw, base);
    if (url.origin !== base) return FALLBACK;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return FALLBACK;
  }
}

/** `/login?callbackUrl=<path+query>` for the page being left. */
export function loginHref(pathname: string, search: string): string {
  return `/login?callbackUrl=${encodeURIComponent(`${pathname}${search}`)}`;
}
