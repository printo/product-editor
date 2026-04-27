import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { decodeJwt } from "jose"

interface DecodedToken {
  exp: number;
  [key: string]: unknown;
}

const PIA_AUTH_TIMEOUT_MS = 10_000;

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

      // Access token still valid — return as-is (fast path)
      if (Date.now() < (token.accessTokenExpires as number)) {
        return token
      }

      // Access token has expired — attempt a silent refresh via PIA.
      // PIA uses Django REST Framework SimpleJWT, so the refresh endpoint
      // follows the standard pattern: POST /auth/token/refresh/ → { access, refresh? }
      const piaUrl = process.env.PIA_API_BASE_URL || "https://pia.printo.in/api/v1"
      try {
        const res = await fetch(`${piaUrl}/auth/token/refresh/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh: token.refreshToken }),
          signal: AbortSignal.timeout(PIA_AUTH_TIMEOUT_MS),
        })
        if (res.ok) {
          const refreshed = await res.json()
          const decoded = decodeJwt(refreshed.access) as unknown as DecodedToken
          return {
            ...token,
            accessToken: refreshed.access,
            accessTokenExpires: decoded.exp * 1000,
            // Rotating refresh tokens: update if the server returns a new one
            ...(refreshed.refresh ? { refreshToken: refreshed.refresh } : {}),
            error: undefined, // clear any previous refresh error
          }
        }
      } catch (e) {
        console.error("PIA token refresh failed", e)
      }

      // Refresh failed (refresh token expired / revoked / network error).
      // Propagate an error so the session callback can surface it to the UI,
      // allowing the app to redirect to login instead of silently failing.
      return { ...token, error: 'RefreshAccessTokenError' }
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
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`
      try {
        if (new URL(url).origin === baseUrl) return url
      } catch {
        // Malformed URL — fall through to baseUrl.
      }
      return baseUrl
    },
  },
  pages: {
    signIn: "/login",
  }
})

export const { handlers, signIn, signOut, auth } = nextAuth
