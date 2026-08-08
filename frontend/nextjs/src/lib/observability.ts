"use client"

import { initializeFaro, getWebInstrumentations } from "@grafana/faro-web-sdk"
import * as Sentry from "@sentry/nextjs"

let isInitialized = false

export function initObservability() {
  if (typeof window === "undefined" || isInitialized) return

  // 1. Initialize Grafana Faro Web SDK (RUM & Web Vitals)
  const faroUrl = process.env.NEXT_PUBLIC_FARO_URL
  if (faroUrl) {
    try {
      initializeFaro({
        url: faroUrl,
        app: {
          name: "product-editor-frontend",
          version: process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0",
          environment: process.env.NODE_ENV || "development",
        },
        instrumentations: [
          ...getWebInstrumentations({
            captureConsole: true,
          }),
        ],
      })
      console.log("[Observability] Grafana Faro Web SDK initialized.")
    } catch (err) {
      console.warn("[Observability] Failed to initialize Grafana Faro:", err)
    }
  }

  // 2. Initialize Sentry (Exception Tracking for Printo Sentry Account)
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
