/**
 * The dashboard's tag filter and search live in its address
 * (`/dashboard?tag=photo_frame&q=gold`), so the browser's Back button and the
 * editor's "Back to Layouts" return to the same filtered list. The tag is its
 * fixed key, never its renameable name, so a saved link survives a rename.
 */

export type DashboardFilter = { tag: string; q: string };

const STORAGE_KEY = 'pe:dashboard-filter';

export function readDashboardFilter(params: { get(name: string): string | null }): DashboardFilter {
  return { tag: params.get('tag') ?? '', q: params.get('q') ?? '' };
}

/** `?tag=…&q=…`, empty values left out; '' when nothing is set. */
export function dashboardFilterQuery({ tag, q }: DashboardFilter): string {
  const sp = new URLSearchParams();
  if (tag) sp.set('tag', tag);
  if (q) sp.set('q', q);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Kept per tab so "Back to Layouts" can find it after a full page load. */
export function rememberDashboardFilter(filter: DashboardFilter): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, dashboardFilterQuery(filter));
  } catch {
    // Storage blocked: Back to Layouts falls back to the unfiltered list.
  }
}

export function dashboardHref(): string {
  try {
    const query = sessionStorage.getItem(STORAGE_KEY) ?? '';
    return query.startsWith('?') ? `/dashboard${query}` : '/dashboard';
  } catch {
    return '/dashboard';
  }
}
