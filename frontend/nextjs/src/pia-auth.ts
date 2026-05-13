import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { decodeJwt } from "jose"

interface DecodedToken {
  exp: number;
  [key: string]: unknown;
}

const PIA_AUTH_TIMEOUT_MS = 10_000;

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

        return {
          id: data.employee_id ? String(data.employee_id) : "unknown",
          name: data.full_name || (credentials.username as string),
          email: credentials.username as string,
          role: isAdmin ? 'admin' : 'user',
          accessToken: data.access,
          refreshToken: data.refresh,
          accessTokenExpires: decoded.exp * 1000,
          is_ops_team: data.is_ops_team || false,
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
