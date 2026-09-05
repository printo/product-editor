import { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    accessToken?: string
    is_ops_team?: boolean
    /** Raw PIA is_super_user flag — narrower than role === 'admin' (which
     *  also includes is_ops_team). Used to gate surfaces with a bigger blast
     *  radius than the ops/* dashboard routes, e.g. Django admin. */
    is_super_user?: boolean
    /** PIA product-access flags. Carried because the Django-admin rule needs
     *  every one of them — see lib/django-admin-access.ts. */
    is_deliveryq?: boolean
    pia_access?: boolean
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
    is_super_user?: boolean
    /** PIA product-access flags. Carried because the Django-admin rule needs
     *  every one of them — see lib/django-admin-access.ts. */
    is_deliveryq?: boolean
    pia_access?: boolean
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
    is_super_user?: boolean
    /** PIA product-access flags. Carried because the Django-admin rule needs
     *  every one of them — see lib/django-admin-access.ts. */
    is_deliveryq?: boolean
    pia_access?: boolean
    /** Propagated from the token refresh failure to the session callback. */
    error?: string
  }
}
