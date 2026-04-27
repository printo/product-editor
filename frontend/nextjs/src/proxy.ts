import { auth } from "@/pia-auth"
import { NextResponse } from "next/server"

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

  if (pathname === "/login" && isLoggedIn && !sessionError) {
    return NextResponse.redirect(new URL("/dashboard", req.url))
  }
})

export const config = {
  matcher: ["/dashboard/:path*", "/editor/layouts/:path*", "/login"],
}
