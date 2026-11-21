import type { Instrumentation } from 'next';

/**
 * Errors the Next.js server meets while rendering a page, running a route
 * handler or a server action go to the backend's `POST /api/client-errors`
 * with the internal API key, which passes them to the team's Google Chat
 * space (services/error_alerts.py groups repeats). Browser errors take the
 * other road, `lib/client-error-report.ts`.
 *
 * Never awaited by the request and never throws: an alert must not change
 * what the customer sees.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const apiKey = process.env.INTERNAL_API_KEY;
  const api = process.env.INTERNAL_API_URL || 'http://backend:8000/api';
  if (!apiKey) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const digest = (err as Error & { digest?: string }).digest;
    const body = JSON.stringify({
      kind: `server-${context.routeType}`,
      level: 'error',
      message: `${err.name}: ${err.message}`.slice(0, 500),
      stack: [err.stack ?? '', digest ? `digest ${digest}` : ''].filter(Boolean).join('\n').slice(0, 4000),
      source: context.routePath,
      page: `${request.method} ${request.path.split('?')[0]}`,
    });
    void fetch(`${api}/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // The error is in the container log either way.
    });
  } catch {
    // Never let reporting throw.
  }
};
