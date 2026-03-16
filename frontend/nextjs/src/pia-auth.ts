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
      if (user) {
        return {
          ...token,
          id: user.id,
          role: user.role,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          accessTokenExpires: user.accessTokenExpires,
          is_ops_team: user.is_ops_team
        }
      }
      return token
    },
    async session({ session, token }) {
        if (token) {
            session.user.id = token.id as string
            session.user.role = token.role as string | undefined
            session.accessToken = token.accessToken as string | undefined
            session.is_ops_team = token.is_ops_team as boolean | undefined
        }
      return session
    },
  },
  pages: {
    signIn: "/login",
  }
})

export const { handlers, signIn, signOut, auth } = nextAuth
