import { normalizeLayout, type SurfaceDefinition } from './layout-utils';

/**
 * Front and back cover sheets of a calendar. Twin of
 * backend/django/services/calendar_covers.py, pinned by
 * storage/parity-fixtures/calendar-cover-order.json.
 *
 * A cover is its own printed sheet (front ahead of the months, back after);
 * its unprinted inside is not a surface and is never shown to the customer.
 */

export const COVER_FRONT = 'cover_front';
export const COVER_BACK = 'cover_back';
export type CoverKey = typeof COVER_FRONT | typeof COVER_BACK;

export const COVER_LABEL: Record<CoverKey, string> = {
  [COVER_FRONT]: 'Front Cover',
  [COVER_BACK]: 'Back Cover',
};

const LAYOUT_KEY: Record<CoverKey, 'frontCover' | 'backCover'> = {
  [COVER_FRONT]: 'frontCover',
  [COVER_BACK]: 'backCover',
};

interface CoverBlock { canvas?: { width?: number; height?: number }; frames?: unknown[] }
type CoverLayoutLike = { frontCover?: CoverBlock | null; backCover?: CoverBlock | null } | null | undefined;

export function isCoverKey(key: unknown): key is CoverKey {
  return key === COVER_FRONT || key === COVER_BACK;
}

/** The authored block of a cover, or null when the layout carries none. */
export function coverBlock(layout: CoverLayoutLike, key: CoverKey): CoverBlock | null {
  const block = layout?.[LAYOUT_KEY[key]];
  return block && typeof block === 'object' && block.canvas && typeof block.canvas === 'object' ? block : null;
}

/** Cover keys this layout carries, in print order. */
export function coverKeysPresent(layout: CoverLayoutLike): CoverKey[] {
  return ([COVER_FRONT, COVER_BACK] as CoverKey[]).filter(k => coverBlock(layout, k));
}

export function numberedLabel(position: number, label: string): string {
  return `${String(position).padStart(2, '0')} ${label}`;
}

/** Every printed sheet in print order with its file label (numbered only when a cover exists). */
export function sheetLabels(layout: CoverLayoutLike, monthLabels: string[]): { key: string; label: string }[] {
  const present = coverKeysPresent(layout);
  const sheets: { key: string; label: string }[] = [];
  if (present.includes(COVER_FRONT)) sheets.push({ key: COVER_FRONT, label: COVER_LABEL[COVER_FRONT] });
  monthLabels.forEach((label, i) => sheets.push({ key: `month_${String(i + 1).padStart(2, '0')}`, label }));
  if (present.includes(COVER_BACK)) sheets.push({ key: COVER_BACK, label: COVER_LABEL[COVER_BACK] });
  if (present.length === 0) return sheets;
  return sheets.map((s, i) => ({ key: s.key, label: numberedLabel(i, s.label) }));
}

/** A cover as an editor surface: its own canvas, photo frames and mask, drawn
 *  and edited like one side of a two-sided product. Null when the layout has none. */
export function coverSurfaceDef(layout: Record<string, unknown> | null | undefined, key: CoverKey): SurfaceDefinition | null {
  const block = coverBlock(layout as CoverLayoutLike, key) as Record<string, unknown> | null;
  if (!block) return null;
  const def = normalizeLayout({
    canvas: block.canvas, frames: block.frames, maskUrl: block.maskUrl, maskOnExport: block.maskOnExport,
  }).surfaces[0];
  return { ...def, key, label: COVER_LABEL[key] };
}

/** The cover surfaces a layout carries, front then back. */
export function coverSurfaceDefs(layout: Record<string, unknown> | null | undefined): SurfaceDefinition[] {
  return coverKeysPresent(layout as CoverLayoutLike)
    .map(k => coverSurfaceDef(layout, k))
    .filter((d): d is SurfaceDefinition => d !== null);
}

/** Surfaces that are not covers: the sides of a two-sided product, or the one
 *  surface of a calendar. A cover is never a "side", so everything that counts
 *  sides (photo dealing, quantity, the side-by-side layout) counts these. */
export function nonCoverSurfaces<T extends { key: string }>(surfaces: readonly T[]): T[] {
  return surfaces.filter(s => !isCoverKey(s.key));
}

/** How many sides a product has, covers left out. */
export function sideCount(surfaces: readonly { key: string }[]): number {
  return nonCoverSurfaces(surfaces).length;
}
