import { auth } from "@/pia-auth"
import { NextResponse } from "next/server"
import { canManageTemplates, isRegistrationActive, type RoleFlags } from "@/lib/roles"

// Server-side auth gate (Next.js 16 "proxy.ts" convention — formerly middleware).
// Protected pages still keep their useEffect redirects as a defensive client-side
// check, but the proxy prevents the brief flash of protected UI before redirect.
//
// /editor/layout/[name] is intentionally NOT gated here because it serves both
// the dashboard editor (session-auth) and the embed iframe (token-auth). The
// page itself branches on the presence of an embed token.
export default auth((req) => {
  const { pathname } = req.nextUrl
  const isLoggedIn = !!req.auth
  const sessionError = (req.auth as { error?: string } | null)?.error
  const sessionInvalid = !isLoggedIn || sessionError === "RefreshAccessTokenError"

  const isProtected =
    pathname.startsWith("/dashboard") || pathname.startsWith("/editor/layouts")

  if (isProtected && sessionInvalid) {
    const signIn = new URL("/login", req.url)
    signIn.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(signIn)
  }

  const flags = req.auth as RoleFlags | null

  // A deactivated employee keeps a valid session for its whole lifetime, so the
  // active check is applied per request here too — same reason the internal
  // proxy and verify-django-admin re-check it. Back to /login rather than
  // /dashboard: there is nothing in the app they should still reach.
  if (isProtected && isLoggedIn && !isRegistrationActive(flags)) {
    const signIn = new URL("/login", req.url)
    signIn.searchParams.set("error", "AccountInactive")
    return NextResponse.redirect(signIn)
  }

  // /editor/layouts is the ops authoring UI — creating, editing and deleting
  // templates. The internal proxy already refuses those writes for the Editor
  // tier, but without this the page still loads and offers Create / Edit /
  // Delete controls that every click answers with a 403. That reads as a broken
  // app rather than a permission boundary.
  //
  // Editors reach layouts through /dashboard, which stays open to every
  // authenticated session — so this redirects there rather than to /login: they
  // are signed in correctly, just not entitled to this screen.
  //
  // Restores the page-level redirect PR #24 removed alongside the proxy's
  // ops/* gate; see "Role model" in CLAUDE.md.
  if (pathname.startsWith("/editor/layouts") && isLoggedIn && !canManageTemplates(flags)) {
    return NextResponse.redirect(new URL("/dashboard", req.url))
  }

  if (pathname === "/login" && isLoggedIn && !sessionError) {
    return NextResponse.redirect(new URL("/dashboard", req.url))
  }
})

export const config = {
  matcher: ["/dashboard/:path*", "/editor/layouts/:path*", "/login"],
}
