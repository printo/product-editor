/**
 * Browser errors, sent to the backend's `POST /api/client-errors`, which
 * passes them to the team's Google Chat space (services/error_alerts.py).
 * The webhook address stays on the server.
 *
 * Kept small on purpose: at most MAX_PER_PAGE reports per page load, each
 * distinct message once, never the address's query string (the embed's
 * `?token=` is in it), and never awaited, so reporting cannot slow or break
 * what the customer is doing.
 */

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'heic' | 'photos-missing';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  level?: 'error' | 'warning';
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
}

export const CLIENT_ERROR_ENDPOINT = '/api/client-errors';
export const MAX_PER_PAGE = 5;

// Errors that say nothing about our code. The server filters the same list.
const NOISE =
  /^Script error\.?$|ResizeObserver loop|chrome-extension:\/\/|moz-extension:\/\/|safari-(web-)?extension:\/\/|webkit-masked-url:\/\//i;

const reported = new Set<string>();
let sentThisPage = 0;

/** Test hook: forget what this page has already reported. */
export function resetClientErrorReports(): void {
  reported.clear();
  sentThisPage = 0;
}

export function withoutQuery(text: string): string {
  return text.replace(/(https?:\/\/[^\s?"'()]+)\?[^\s"'()]*/g, '$1');
}

export function isNoise(report: Pick<ClientErrorReport, 'message' | 'source' | 'stack'>): boolean {
  return (
    !report.message ||
    NOISE.test(report.message) ||
    NOISE.test(report.source ?? '') ||
    NOISE.test((report.stack ?? '').slice(0, 2000))
  );
}

export function reportClientError(report: ClientErrorReport): void {
  try {
    if (typeof window === 'undefined') return;
    if (isNoise(report)) return;
    const key = `${report.kind}|${report.message}`;
    if (reported.has(key) || sentThisPage >= MAX_PER_PAGE) return;
    reported.add(key);
    sentThisPage += 1;

    const body = JSON.stringify({
      kind: report.kind,
      level: report.level ?? 'error',
      message: report.message.slice(0, 500),
      stack: withoutQuery(report.stack ?? '').slice(0, 4000),
      source: withoutQuery(report.source ?? '').slice(0, 300),
      line: report.line,
      column: report.column,
      page: window.location.pathname,
      embed: new URLSearchParams(window.location.search).has('token'),
      userAgent: navigator.userAgent.slice(0, 200),
    });
    void fetch(CLIENT_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {
      // Offline or blocked: the console already has the error.
    });
  } catch {
    // Reporting must never throw into the page.
  }
}

function messageOf(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack };
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value)?.slice(0, 300) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

export function reportWindowError(event: ErrorEvent): void {
  const { message, stack } = event.error ? messageOf(event.error) : { message: event.message, stack: undefined };
  reportClientError({
    kind: 'error',
    message: message || event.message,
    stack,
    source: event.filename,
    line: event.lineno || undefined,
    column: event.colno || undefined,
  });
}

export function reportUnhandledRejection(event: PromiseRejectionEvent): void {
  const { message, stack } = messageOf(event.reason);
  reportClientError({ kind: 'unhandledrejection', message, stack });
}
