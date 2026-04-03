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

COPY --from=deps /app/node_modules ./node_modules
COPY frontend/nextjs /app

ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_DIRECT_API_KEY
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_DIRECT_API_KEY=$NEXT_PUBLIC_DIRECT_API_KEY

# Build the app
RUN pnpm build

# ── Stage 3: Minimal production runner ───────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000
CMD ["pnpm", "start"]
