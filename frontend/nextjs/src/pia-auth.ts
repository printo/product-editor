import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { decodeJwt } from "jose"

interface DecodedToken {
  exp: number;
  [key: string]: unknown;
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
        
        try {
            const res = await fetch(`${piaUrl}/auth/`, {
                method: 'POST',
                body: JSON.stringify({
                    email: credentials.username,
                    password: credentials.password
                }),
                headers: { "Content-Type": "application/json" }
            })
            
            if (res.ok) {
                const data = await res.json()
                if (data.access) {
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
                        is_ops_team: data.is_ops_team || false
                    }
                }
            }
        } catch (e) {
            console.error("Auth failed", e)
        }
        return null
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
  },
  pages: {
    signIn: "/login",
  }
})

export const { handlers, signIn, signOut, auth } = nextAuth
