# ── Stage 1: Install dependencies with pnpm ──────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Enable corepack so pnpm is available without a separate install step
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY frontend/nextjs/package.json frontend/nextjs/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build the Next.js app ───────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy all source files from frontend/nextjs to /app
COPY frontend/nextjs/ ./

ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_DIRECT_API_KEY
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_DIRECT_API_KEY=$NEXT_PUBLIC_DIRECT_API_KEY

# Build the app
RUN pnpm build

# ── Stage 3: Minimal production runner ───────────────────────────────────────
# Uses Next.js `output: 'standalone'` — copies only the deps the app actually
# imports, plus a tiny Node server (server.js). Drops ~200 MB vs shipping the
# full node_modules; no pnpm in this stage.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output: server.js + minimal node_modules at /app/.next/standalone/
COPY --from=builder /app/.next/standalone ./
# Static assets live outside the standalone bundle
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
