/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path((?!auth).*)',
        destination: process.env.INTERNAL_API_URL 
          ? `${process.env.INTERNAL_API_URL}/:path`
          : process.env.NEXT_PUBLIC_API_BASE_URL 
            ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/:path` 
            : 'http://backend:8000/api/:path',
      },
    ]
  },
}
export default nextConfig
