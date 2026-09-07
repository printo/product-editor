import { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    accessToken?: string
    is_ops_team?: boolean
    /** PIA's "may administer" flag — the Django-admin gate. See lib/roles.ts. */
    is_staff?: boolean
    /** Other PIA products' access flags. Nothing in this app gates on them —
     *  see lib/roles.ts — they are carried so the login log can report them. */
    is_deliveryq?: boolean
    pia_access?: boolean
    /** PIA employee registration state, e.g. "ACTIVE". */
    registration_status?: string
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
    /** PIA's "may administer" flag — the Django-admin gate. See lib/roles.ts. */
    is_staff?: boolean
    /** Other PIA products' access flags. Nothing in this app gates on them —
     *  see lib/roles.ts — they are carried so the login log can report them. */
    is_deliveryq?: boolean
    pia_access?: boolean
    /** PIA employee registration state, e.g. "ACTIVE". */
    registration_status?: string
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
    /** PIA's "may administer" flag — the Django-admin gate. See lib/roles.ts. */
    is_staff?: boolean
    /** Other PIA products' access flags. Nothing in this app gates on them —
     *  see lib/roles.ts — they are carried so the login log can report them. */
    is_deliveryq?: boolean
    pia_access?: boolean
    /** PIA employee registration state, e.g. "ACTIVE". */
    registration_status?: string
    /** Propagated from the token refresh failure to the session callback. */
    error?: string
  }
}
