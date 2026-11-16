/**
 * Guard for the catch-all path both proxies forward upstream.
 *
 * The embed allowlist and the ops-tier gate judge the path as a string, but the
 * upstream URL is parsed afterwards, and a URL parser collapses `.` and `..`
 * segments (also when written `%2e%2e`). `layouts/../ops/layouts/x` therefore
 * passed the check as `layouts/...` and reached `ops/layouts/x` with the
 * session's real key. A segment that could move the path is refused outright,
 * so what was checked is what is requested.
 */
function decodesTo(segment: string): string[] {
  const forms = [segment];
  let current = segment;
  // Decode repeatedly: `%252e%252e` is a dot segment one hop further on.
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      forms.push(next);
      current = next;
    } catch {
      // A lone `%` is not an escape; the raw form was already recorded.
      break;
    }
  }
  return forms;
}

export function isSafeProxyPath(segments: readonly string[] | undefined): boolean {
  for (const segment of segments ?? []) {
    for (const form of decodesTo(segment)) {
      if (form === '.' || form === '..') return false;
      if (form.includes('/') || form.includes('\\') || form.includes('\0')) return false;
    }
  }
  return true;
}
