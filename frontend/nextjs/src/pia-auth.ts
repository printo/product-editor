import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { decodeJwt } from "jose"

interface DecodedToken {
  exp: number;
  [key: string]: unknown;
}

const PIA_AUTH_TIMEOUT_MS = 10_000;

// Google sign-in is restricted to this Workspace domain. Enforced server-side
// (the client `hd` hint is only advisory and can be bypassed).
const ALLOWED_GOOGLE_DOMAIN = "printo.in";

// PIA endpoint that exchanges a Google ID token for PIA access/refresh tokens.
// Same response shape as POST /auth/. Path is relative to PIA_API_BASE_URL.
const PIA_GOOGLE_AUTH_PATH = "/auth/google/login/";

// Refresh the access token this many ms before its `exp`. Without a buffer,
// every concurrent request that lands at the exact instant of expiry sees an
// expired token and independently fires its own refresh against PIA. With
// PIA's rotating refresh tokens, only the first succeeds; the rest hit a
// now-invalid refresh token, mark the session as errored, and the browser
// ends up with whichever Set-Cookie response wins the race — sometimes
// healthy, sometimes broken. 60 s gives the first crossing request enough
// time to refresh before any sibling request hits the same threshold.
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;

type RefreshResult = {
  accessToken?: string;
  accessTokenExpires?: number;
  refreshToken?: string;
  error?: string;
};

// In-process singleflight cache: dedupes concurrent refresh attempts for the
// same refresh token. The Next.js process is a singleton in our container
// (one Node runtime, all requests share heap), so an in-memory Map is the
// right granularity here — no need for Redis. If we ever scale the frontend
// horizontally, swap this for a Redis-backed lock; the existing per-IP login
// rate limiter in `app/actions/auth.ts` will need the same treatment.
const refreshInFlight = new Map<string, Promise<RefreshResult>>();

class PiaServiceUnavailableError extends CredentialsSignin {
  code = "PiaServiceUnavailable";
}

class PiaTimeoutError extends CredentialsSignin {
  code = "PiaTimeout";
}

// Raised when a Google sign-in succeeds against PIA but the account is outside
// the allowed Workspace domain. Surfaced to the UI as a specific message.
class GoogleDomainNotAllowedError extends CredentialsSignin {
  code = "GoogleDomainNotAllowed";
}

/**
 * Record what PIA actually returned about a successful sign-in.
 *
 * `is_super_user` is captured here and nowhere else — the `jwt` callback sets
 * it only on the first-login branch, and a token refresh preserves whatever
 * was already there. So this line is the only evidence of why a session has
 * the privileges it has, and its absence cost a real diagnosis: on 2026-09-04
 * a superuser could not see the Django admin link, and answering "what did PIA
 * say about this person?" needed three round trips through the browser because
 * nothing server-side had written it down.
 *
 * Logs the flags and the identity, never the tokens: `data.access` and
 * `data.refresh` are bearer credentials for PIA and must not reach a log
 * aggregator. `typeof` on the raw flag is deliberate — "PIA omitted the field"
 * and "PIA sent false" are different bugs with different owners, and they are
 * indistinguishable once coerced with `|| false`.
 */
function logPiaLogin(
  provider: 'password' | 'google',
  data: { employee_id?: unknown; is_super_user?: unknown; is_ops_team?: unknown },
  email: string,
): void {
  console.info(
    `[pia-login] provider=${provider} employee_id=${String(data.employee_id ?? '(none)')} ` +
      `email=${email || '(none)'} ` +
      `is_super_user=${String(data.is_super_user)}(${typeof data.is_super_user}) ` +
      `is_ops_team=${String(data.is_ops_team)}(${typeof data.is_ops_team}) ` +
      `role=${data.is_super_user || data.is_ops_team ? 'admin' : 'user'}`,
  );
}

const nextAuth = NextAuth({
  secret: process.env.AUTH_SECRET,
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const piaUrl = process.env.PIA_API_BASE_URL || "https://pia.printo.in/api/v1"

        let res: Response;
        try {
          res = await fetch(`${piaUrl}/auth/`, {
            method: 'POST',
            body: JSON.stringify({
              email: credentials.username,
              password: credentials.password,
            }),
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(PIA_AUTH_TIMEOUT_MS),
          })
        } catch (e: unknown) {
          // AbortSignal.timeout() raises a DOMException with name 'TimeoutError'.
          if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
            console.error("PIA auth timed out after", PIA_AUTH_TIMEOUT_MS, "ms")
            throw new PiaTimeoutError()
          }
          // Network error (DNS, ECONNREFUSED, TLS) — service-down, not bad creds.
          console.error("PIA auth network error", e)
          throw new PiaServiceUnavailableError()
        }

        // 5xx → upstream is down; surface as service-unavailable, not bad creds.
        if (res.status >= 500) {
          console.error("PIA auth returned", res.status)
          throw new PiaServiceUnavailableError()
        }

        // 4xx (incl. 401/403) → genuine credential failure; return null so
        // NextAuth surfaces it as "CredentialsSignin".
        if (!res.ok) {
          return null
        }

        const data = await res.json()
        if (!data.access) {
          return null
        }

        const decoded = decodeJwt(data.access) as unknown as DecodedToken
        const isAdmin = data.is_super_user || data.is_ops_team
        logPiaLogin('password', data, credentials.username as string)

        return {
          id: data.employee_id ? String(data.employee_id) : "unknown",
          name: data.full_name || (credentials.username as string),
          email: credentials.username as string,
          role: isAdmin ? 'admin' : 'user',
          accessToken: data.access,
          refreshToken: data.refresh,
          accessTokenExpires: decoded.exp * 1000,
          is_ops_team: data.is_ops_team || false,
          is_super_user: data.is_super_user || false,
        }
      },
    }),
    // Google sign-in. The browser obtains a Google ID token via the Google
    // Identity Services button (client-id only, no secret) and hands it here.
    // PIA validates the token (signature/audience/expiry) and returns the same
    // access/refresh payload as the password flow, so everything downstream
    // (jwt/session callbacks, refresh, Django Bearer auth) is identical.
    Credentials({
      id: "google",
      name: "Google",
      credentials: {
        id_token: { label: "Google ID Token", type: "text" },
      },
      authorize: async (credentials) => {
        const idToken = credentials?.id_token as string | undefined
        if (!idToken) return null
        const piaUrl = process.env.PIA_API_BASE_URL || "https://pia.printo.in/api/v1"

        let res: Response;
        try {
          res = await fetch(`${piaUrl}${PIA_GOOGLE_AUTH_PATH}`, {
            method: 'POST',
            body: JSON.stringify({ id_token: idToken }),
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(PIA_AUTH_TIMEOUT_MS),
          })
        } catch (e: unknown) {
          if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
            console.error("PIA google auth timed out after", PIA_AUTH_TIMEOUT_MS, "ms")
            throw new PiaTimeoutError()
          }
          console.error("PIA google auth network error", e)
          throw new PiaServiceUnavailableError()
        }

        if (res.status >= 500) {
          console.error("PIA google auth returned", res.status)
          throw new PiaServiceUnavailableError()
        }
        // 4xx → PIA rejected the token / unknown user. Return null so NextAuth
        // surfaces a generic credential failure.
        if (!res.ok) {
          return null
        }

        const data = await res.json()
        if (!data.access) {
          return null
        }

        // PIA has now validated the Google token's authenticity, so claims
        // decoded from it are trustworthy. Enforce the Workspace-domain policy
        // on top — PIA may not gate the domain itself. Fail closed if the token
        // can't be parsed (this gate must never be skipped).
        let claims: { email?: string; email_verified?: boolean; hd?: string; name?: string }
        try {
          claims = decodeJwt(idToken) as unknown as typeof claims
        } catch {
          console.warn("Google sign-in rejected: unparseable ID token")
          throw new GoogleDomainNotAllowedError()
        }
        const email = (claims.email || "").toLowerCase()
        const domainOk =
          claims.hd === ALLOWED_GOOGLE_DOMAIN || email.endsWith(`@${ALLOWED_GOOGLE_DOMAIN}`)
        if (claims.email_verified === false || !domainOk) {
          console.warn("Google sign-in rejected (domain not allowed):", email || "(no email)")
          throw new GoogleDomainNotAllowedError()
        }

        const decoded = decodeJwt(data.access) as unknown as DecodedToken
        const isAdmin = data.is_super_user || data.is_ops_team
        logPiaLogin('google', data, email)

        return {
          id: data.employee_id ? String(data.employee_id) : "unknown",
          name: data.full_name || claims.name || email,
          email: email,
          role: isAdmin ? 'admin' : 'user',
          accessToken: data.access,
          refreshToken: data.refresh,
          accessTokenExpires: decoded.exp * 1000,
          is_ops_team: data.is_ops_team || false,
          is_super_user: data.is_super_user || false,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // First login: populate token from user object returned by authorize()
      if (user) {
        return {
          ...token,
          id: user.id,
          role: user.role,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          accessTokenExpires: user.accessTokenExpires,
          is_ops_team: user.is_ops_team,
          is_super_user: user.is_super_user,
        }
      }

      // Fast path — token has at least one full buffer window of life left.
      // Refreshing *before* expiry (not after) is what prevents the storm:
      // only the first request to cross the buffer threshold fires a refresh;
      // every other concurrent request still sees a valid token and skips
      // the upstream call entirely.
      const expiresAt = token.accessTokenExpires as number;
      if (Date.now() < expiresAt - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
        return token
      }

      // Refresh window open — singleflight on (current refresh token).
      // Multiple concurrent `auth()` invocations sharing the same starting
      // JWT will hit this branch within milliseconds of each other; the
      // first installs a pending promise in the Map and the rest await it.
      // After the promise settles the Map entry is cleared so the next
      // refresh window can start its own request.
      const currentRefreshToken = token.refreshToken as string;
      let pending = refreshInFlight.get(currentRefreshToken);
      if (!pending) {
        pending = (async (): Promise<RefreshResult> => {
          const piaUrl = process.env.PIA_API_BASE_URL || "https://pia.printo.in/api/v1"
          try {
            const res = await fetch(`${piaUrl}/auth/token/refresh/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh: currentRefreshToken }),
              signal: AbortSignal.timeout(PIA_AUTH_TIMEOUT_MS),
            })
            if (res.ok) {
              const refreshed = await res.json()
              const decoded = decodeJwt(refreshed.access) as unknown as DecodedToken
              return {
                accessToken: refreshed.access,
                accessTokenExpires: decoded.exp * 1000,
                // Rotating refresh tokens: pick up the new one if PIA rotated.
                ...(refreshed.refresh ? { refreshToken: refreshed.refresh } : {}),
              }
            }
            console.error("PIA token refresh returned", res.status)
          } catch (e) {
            console.error("PIA token refresh failed", e)
          }
          // Refresh genuinely failed (expired refresh token, PIA outage,
          // network error). The error flows to every awaiting caller so they
          // all surface the same state to the UI.
          return { error: 'RefreshAccessTokenError' }
        })().finally(() => {
          // Always clear so the next expiry window can refresh again.
          refreshInFlight.delete(currentRefreshToken);
        });
        refreshInFlight.set(currentRefreshToken, pending);
      }

      const result = await pending;
      if (result.error) {
        return { ...token, error: result.error }
      }
      return {
        ...token,
        accessToken: result.accessToken,
        accessTokenExpires: result.accessTokenExpires,
        ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
        error: undefined, // clear any previous refresh error
      }
    },
    async session({ session, token }) {
        if (token) {
            session.user.id = token.id as string
            session.user.name = (token.name as string) || ''
            session.user.email = (token.email as string) || ''
            session.user.role = token.role as string | undefined
            session.accessToken = token.accessToken as string | undefined
            session.is_ops_team = token.is_ops_team as boolean | undefined
            session.is_super_user = token.is_super_user as boolean | undefined
            // Surface refresh errors to the client so the app can prompt re-login
            if (token.error) {
                session.error = token.error as string
            }
        }
      return session
    },
    // Open-redirect protection: clamp callbackUrl to baseUrl. Relative paths
    // join to baseUrl; absolute URLs only allowed if they share the host.
    //
    // Quirk: NextAuth in Next.js standalone mode behind a reverse proxy
    // sometimes derives `baseUrl` from the server's bind address
    // (HOSTNAME=0.0.0.0:3000 from the standalone Dockerfile) instead of
    // the public Host header. Symptom: clicking "Logout" redirected the
    // browser to https://0.0.0.0:3000/login. We override with PUBLIC_HOST
    // (an env var we already set in production) when we detect the bug.
    // Local dev: PUBLIC_HOST is unset / non-public, so baseUrl stays as-is.
    async redirect({ url, baseUrl }) {
      let effectiveBase = baseUrl
      try {
        const parsed = new URL(baseUrl)
        if (parsed.hostname === "0.0.0.0" && process.env.PUBLIC_HOST) {
          effectiveBase = process.env.PUBLIC_HOST.startsWith("http")
            ? process.env.PUBLIC_HOST
            : `https://${process.env.PUBLIC_HOST}`
        }
      } catch {
        // baseUrl wasn't a valid URL — leave it unchanged
      }

      if (url.startsWith("/")) return `${effectiveBase}${url}`
      try {
        if (new URL(url).origin === effectiveBase) return url
      } catch {
        // Malformed URL — fall through to effectiveBase.
      }
      return effectiveBase
    },
  },
  pages: {
    signIn: "/login",
  }
})

export const { handlers, signIn, signOut, auth } = nextAuth
