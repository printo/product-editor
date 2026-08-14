/**
 * Page-count reconciliation for the book product type (BOOK_LAYOUT_PRD.md
 * R1 — "customer-variable surface count").
 *
 * Every other product type builds `surfaceStates` once, at layout load, and
 * every other part of `page.tsx` (drag/drop, low-DPI collection, submit
 * guards, `executeServerRender`) assumes that array holds exactly the set of
 * currently-real pages. A book's page count is customer state that can
 * change mid-session (PRD D2), so `surfaceStates` must be rebuilt without
 * breaking that assumption for every other call site.
 *
 * The design: `surfaceStates` stays EXACTLY the currently-visible pages —
 * same invariant every other product already has. Pages that fall out of
 * range on a shrink move into a separate archive (keyed by page key) rather
 * than being discarded, and are pulled back out if the count grows again —
 * "hold overrides, restore if the count goes back up", mirroring how the
 * calendar keeps Feb 29 entries through a non-leap year (PRD D2).
 *
 * `materializePages`/`resolvePageCount` (lib/book-layout.ts) are the single
 * source of truth for which page keys exist at a given count and what their
 * template geometry is — this module only reconciles that list against
 * whatever `SurfaceState`s (with customer edits) already exist.
 */
import type { SurfaceDefinition } from '@/lib/layout-utils';
import {
  materializePages,
  resolvePageCount,
  type BookLayoutLike,
  type MaterializedPage,
} from '@/lib/book-layout';
import type { SurfaceState, FitMode } from './types';

function toSurfaceDefinition(page: MaterializedPage): SurfaceDefinition {
  return {
    key: page.key,
    label: page.displayLabel,
    canvas: {
      width: page.canvas.width || 0,
      height: page.canvas.height || 0,
      widthMm: page.canvas.widthMm,
      heightMm: page.canvas.heightMm,
      dpi: page.canvas.dpi,
    },
    frames: (page.frames || []).map((f, i) => ({
      id: f.id != null ? String(f.id) : String(i),
      x: Number(f.x) || 0,
      y: Number(f.y) || 0,
      width: Number(f.width) || 0,
      height: Number(f.height) || 0,
      xMm: typeof f.xMm === 'number' ? f.xMm : undefined,
      yMm: typeof f.yMm === 'number' ? f.yMm : undefined,
      widthMm: typeof f.widthMm === 'number' ? f.widthMm : undefined,
      heightMm: typeof f.heightMm === 'number' ? f.heightMm : undefined,
      bleedMm: typeof f.bleedMm === 'number' ? f.bleedMm : undefined,
    })),
    maskUrl: page.maskUrl,
    maskOnExport: page.maskOnExport,
  };
}

function blankSurfaceState(page: MaterializedPage, globalFitMode: FitMode): SurfaceState {
  return {
    key: page.key,
    label: page.displayLabel,
    def: toSurfaceDefinition(page),
    files: [],
    canvases: [],
    globalFitMode,
  };
}

export interface ReconcileResult {
  /** The new `surfaceStates` — exactly the pages at the resolved count, in
   *  physical order (cover, page 1 … page N, back cover). */
  visible: SurfaceState[];
  /** Pages currently out of range, keyed by page key. Never touched for
   *  keys inside the resolved range. */
  archive: Record<string, SurfaceState>;
  /** The page count actually applied, after the template's min/max/step
   *  clamp (PRD D2) — echo this back into `bookPageCount` state. */
  resolvedCount: number;
}

/**
 * Rebuild `surfaceStates` for a new customer-requested page count.
 *
 * Existing pages are matched by KEY, not index — `cover`/`back_cover` are
 * stable, and inner pages are `page_01..page_N` where growing/shrinking
 * only ever adds/removes a trailing range, so a plain key lookup against
 * `currentVisible` ∪ `archive` is sufficient; no file-identity matching
 * (unlike `canvas-merge.ts`) is needed here because this operates on whole
 * pages, not on re-picked photos within one page.
 *
 * Pure and synchronous so it's unit-testable and safe to call from a
 * `setState` updater.
 */
export function reconcilePageCount(
  rawLayout: BookLayoutLike,
  requestedCount: number | null | undefined,
  currentVisible: ReadonlyArray<SurfaceState>,
  archive: Readonly<Record<string, SurfaceState>>,
  defaultFitMode: FitMode = 'contain',
): ReconcileResult {
  const resolvedCount = resolvePageCount(rawLayout, requestedCount ?? undefined);
  const targetPages = materializePages(rawLayout, { pageCount: resolvedCount });
  const targetKeys = new Set(targetPages.map(p => p.key));

  const visibleByKey = new Map(currentVisible.map(s => [s.key, s]));

  const visible: SurfaceState[] = targetPages.map(page => {
    const existing = visibleByKey.get(page.key) ?? archive[page.key];
    const def = toSurfaceDefinition(page);
    // Refresh `def`/`label` even for a kept page: `displayLabel` and (on
    // covers) the spine-dependent metadata are derived from the CURRENT
    // total count, so they must be recomputed on every reconciliation even
    // though the frame geometry itself (gutter side depends only on the
    // page's own parity) never changes for a page that survives.
    if (existing) return { ...existing, def, label: page.displayLabel };
    return blankSurfaceState(page, defaultFitMode);
  });

  const nextArchive: Record<string, SurfaceState> = {};
  for (const [key, s] of Object.entries(archive)) {
    if (!targetKeys.has(key)) nextArchive[key] = s;
  }
  currentVisible.forEach(s => {
    if (!targetKeys.has(s.key)) nextArchive[s.key] = s;
  });

  return { visible, archive: nextArchive, resolvedCount };
}
