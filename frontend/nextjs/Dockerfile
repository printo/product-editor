# syntax=docker/dockerfile:1.6
# (Enables BuildKit cache-mount syntax used in stages 1 and 2.)

# ── Stage 1: Install dependencies with pnpm ──────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Enable corepack so pnpm is available without a separate install step
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY frontend/nextjs/package.json frontend/nextjs/pnpm-lock.yaml ./
# pnpm store cache survives between builds, dropping cold-install time from
# ~90 s to ~10 s when only package.json is unchanged. package-import-method=copy
# is required here: pnpm's default (hardlink from the store) links node_modules
# files to inodes inside this transient cache mount, which vanish once the
# RUN step's mount detaches — leaving broken files (e.g. next/dist/bin/next
# missing) in the persisted layer even though the install reported success.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --config.package-import-method=copy

# ── Stage 2: Build the Next.js app ───────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy all source files from frontend/nextjs to /app
COPY frontend/nextjs/ ./

ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID

# Build the app. Persist .next/cache between builds so SWC + Webpack module
# graph survive across `docker compose build` runs. Cuts incremental
# rebuilds from ~3-4 min to ~30-45 s.
RUN --mount=type=cache,id=next-build-cache,target=/app/.next/cache \
    pnpm build

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

# Prints the actual host-reachable URL before handing off to Next's server —
# see the script for why (Next's own banner reports the container-internal
# port, which is misleading once Docker Compose remaps it on the host).
COPY frontend/nextjs/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
