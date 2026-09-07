"use client"

import * as Sentry from "@sentry/nextjs"

let isInitialized = false

export function initObservability() {
  if (typeof window === "undefined" || isInitialized) return

  // Sentry only. Grafana Faro RUM was removed on 2026-09-07 along with the
  // rest of the self-hosted Grafana stack — monitoring is maintained outside
  // this repo now.
  const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN
  if (sentryDsn) {
    try {
      Sentry.init({
        dsn: sentryDsn,
        environment: process.env.NODE_ENV || "development",
        tracesSampleRate: 0.1,
        initialScope: (scope) => {
          scope.setTag("app", "product-editor")
          scope.setTag("component", "frontend")
          return scope
        },
      })
      console.log("[Observability] Sentry client initialized.")
    } catch (err) {
      console.warn("[Observability] Failed to initialize Sentry client:", err)
    }
  }

  isInitialized = true
}
