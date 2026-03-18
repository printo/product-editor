/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true, // next/image not used — disable optimizer to mitigate GHSA-3x4c-7xq6-9pq8
  },
  async rewrites() {
    return [
      {
        // /api/embed/proxy/* is handled by a Next.js Route Handler — must NOT be
        // forwarded to Django.  All other /api/* routes go to the backend.
        source: '/api/:path((?!auth|embed/proxy).*)',
        destination: process.env.INTERNAL_API_URL
          ? `${process.env.INTERNAL_API_URL}/:path`
          : process.env.NEXT_PUBLIC_API_BASE_URL
            ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/:path`
            : 'http://backend:8000/api/:path',
      },
    ]
  },
  async headers() {
    return [
      {
        // Allow /layout/[name] to be embedded in external iframes.
        // When ?token= is absent the page requires a PIA session, so there's
        // nothing sensitive an unauthenticated party can access.
        source: '/layout/:name*',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'Content-Security-Policy', value: "frame-ancestors *" },
        ],
      },
    ]
  },
}
export default nextConfig
