import "./globals.css"
import { ReactNode } from "react"
import type { Viewport } from "next"
import { AuthProvider } from "@/components/AuthProvider"
import { AppWrapper } from "@/components/AppWrapper"
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration"
import { auth } from "@/pia-auth"

// viewportFit:'cover' makes env(safe-area-inset-*) live on notched phones —
// without it the CSS safe-area padding on the editor's mobile bottom sheet
// evaluates to 0 and the home indicator overlaps the Save button (Phase 3).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolve the NextAuth session server-side and pass it into SessionProvider
  // as the initial value. Without this the client mounts with no session,
  // useSession() returns null until /api/auth/session resolves, and components
  // that key on session.user.name / role show fallback text ("User",
  // "0 templates") until the network round-trip completes — visible as a
  // post-login flash that only "hard refresh" appeared to fix.
  const session = await auth()

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.png" type="image/png" />
        <link rel="apple-touch-icon" href="/favicon.png" />
        <meta name="theme-color" content="#4f46e5" />
        {/* Resource hints — Google Fonts is the only cross-origin host the
            editor talks to (loadGoogleFont in editor/[name]/page.tsx). DNS
            prefetch + TLS handshake start as soon as the iframe mounts so
            the first font request lands ~150-300 ms sooner. The crossOrigin
            attr on gstatic is required because the actual woff2 files are
            fetched anonymously. */}
        <link rel="dns-prefetch" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="min-h-screen bg-white text-slate-900 antialiased" suppressHydrationWarning>
        <ServiceWorkerRegistration />
        <AuthProvider session={session}>
          <AppWrapper>
            {children}
          </AppWrapper>
        </AuthProvider>
      </body>
    </html>
  )
}
