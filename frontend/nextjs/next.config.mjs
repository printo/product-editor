/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true, // next/image not used — disable optimizer to mitigate GHSA-3x4c-7xq6-9pq8
  },
  transpilePackages: ['lucide-react', 'pica', 'smartcrop'],
  allowedDevOrigins: ['product-editor.printo.in'],
  turbopack: {}, // ✅ Required in Next 16 if 'webpack' block is present
  async rewrites() {
    return [
      {
        // /api/embed/proxy/* and /api/upload-layout are handled by Next.js Route Handlers — must NOT be
        // forwarded to Django.  All other /api/* routes go to the backend.
        source: '/api/:path((?!auth|embed/proxy|upload-layout).*)',
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
        // Layout preview page (uses ?apiKey=, separate from the embed editor).
        source: '/layout/:name*',
        headers: [
          { key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors}` },
        ],
      },
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
      {
        // Layout preview path under /embed/
        source: '/embed/layout/:name*',
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
