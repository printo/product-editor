/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone build: ships only the modules the app actually imports + a
  // minimal Node server, instead of the full node_modules tree. Cuts the
  // runner image by ~200 MB and starts faster (no pnpm dispatch).
  output: 'standalone',
  reactStrictMode: true,
  images: {
    unoptimized: true, // next/image not used — disable optimizer to mitigate GHSA-3x4c-7xq6-9pq8
  },
  transpilePackages: ['lucide-react', 'pica', 'smartcrop'],
  allowedDevOrigins: ['product-editor.printo.in'],
  // Next.js strips a trailing slash with a 308 BEFORE a route handler runs.
  // Both API proxies deliberately preserve the trailing slash when building the
  // upstream URL (`hasTrailingSlash`), because Django's URLconf requires it —
  // but that code could never fire, since the slash was already gone. Django
  // then answered the slash-less URL with its own APPEND_SLASH 301.
  //
  // The cost of that round trip is paid three times over: the BROWSER re-sends
  // the whole body on the 308 (autosave payloads carry per-canvas previews, on
  // a customer base that is mostly phone/tablet), the proxy re-sends it again
  // on Django's 301, and the audit trail records a junk 404 row per save.
  // It also made autosave fail outright until the body was made re-readable —
  // undici detaches an ArrayBuffer on the first send, so the redirect retry
  // threw (see the Blob wrapper in both proxy routes).
  //
  // Disabling the redirect lets the proxies' existing preservation logic work
  // as designed: one hop, one upload, no APPEND_SLASH.
  skipTrailingSlashRedirect: true,
  turbopack: {}, // ✅ Required in Next 16 if 'webpack' block is present
  async rewrites() {
    return [
      {
        // /api/auth/*, /api/embed/proxy/*, /api/internal/proxy/* and
        // /api/upload-layout are handled by Next.js Route Handlers — they must
        // NOT be forwarded to Django. All other /api/* routes go to the backend.
        //
        // A bare rewrites() array is `afterFiles`, which is evaluated BEFORE
        // dynamic routes. Both proxies are catch-all ([...path]) routes, i.e.
        // dynamic — so anything this pattern matches beats its route handler.
        // internal/proxy was missing here, so every dashboard/editor call was
        // rewritten to Django as /api/internal/proxy/<path> and came back 404.
        source: '/api/:path((?!auth|embed/proxy|internal/proxy|upload-layout).*)',
        destination: process.env.INTERNAL_API_URL
          ? `${process.env.INTERNAL_API_URL}/:path`
          : process.env.NEXT_PUBLIC_API_BASE_URL
            ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/:path`
            : 'http://backend:8000/api/:path',
      },
    ]
  },
  async headers() {
    // CSP frame-ancestors limited to printo.in by default; override at deploy
    // time via NEXT_PUBLIC_EMBED_FRAME_ANCESTORS for staging or partner hosts.
    const frameAncestors = process.env.NEXT_PUBLIC_EMBED_FRAME_ANCESTORS
      || "'self' https://printo.in https://*.printo.in";
    return [
      {
        // Embed editor entry — printo.in iframes /editor/layout/<name>?token=...
        // X-Frame-Options is the legacy fallback; modern browsers use CSP
        // frame-ancestors which lets us scope to printo.in (X-Frame-Options
        // ALLOW-FROM is deprecated and unsupported in most browsers, so the
        // frame-ancestors directive is the real gate).
        source: '/editor/layout/:name*',
        headers: [
          { key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors}` },
        ],
      },
    ]
  },
  // ✅ Fix HMR WebSocket for tunneled/proxied development
  webpack: (config, { dev, isServer }) => {
    if (dev && !isServer) {
      if (config.devServer) {
        config.devServer.client = {
          ...config.devServer.client,
          webSocketURL: 'wss://product-editor.printo.in/_next/webpack-hmr',
        };
      }
    }
    return config;
  },
}
export default nextConfig
