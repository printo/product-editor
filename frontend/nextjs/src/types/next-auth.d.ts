import { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    accessToken?: string
    is_ops_team?: boolean
    /** Set to 'RefreshAccessTokenError' when the PIA refresh token has expired.
     *  The app should check for this and redirect to /login. */
    error?: string
    user: {
      id: string
      role?: string
    } & DefaultSession["user"]
  }

  interface User {
    id: string
    role?: string
    accessToken?: string
    refreshToken?: string
    accessTokenExpires?: number
    is_ops_team?: boolean
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string
    role?: string
    accessToken?: string
    refreshToken?: string
    accessTokenExpires?: number
    is_ops_team?: boolean
    /** Propagated from the token refresh failure to the session callback. */
    error?: string
  }
}
