/**
 * Ops side of layout templates: turning the canvas editor's cards into a
 * decoration, and back. Pure, so the ops pages stay thin.
 *
 * Ops author a template in the customer canvas editor on a blank card per
 * side (frames empty, or holding an unsaved sample photo). What they draw
 * on it, minus the photos, is the decoration. An image added from the
 * Uploads tab is a `local` File the template cannot hold; the editor page
 * uploads it as a sticker first and swaps it for a `clipart` overlay.
 */
import type { SurfaceDefinition } from '@/lib/layout-utils';
import { boxLabel, type MmRect } from '@/lib/print-sheet';
import type { AuthoredOn, SideGeometry, SideLike, TemplateDecoration, TemplateSide } from './layout-template';
import { placeSideOverlays, surfaceGeometry, templateSide } from './layout-template';
import type { CanvasItem, FrameState, Overlay } from './types';

export const TEMPLATE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** A template id from a display name: "Retro Birthday!" → "retro-birthday". */
export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function isTemplateId(value: string): boolean {
  return TEMPLATE_ID_RE.test(value);
}

/** One blank card for a side: every frame empty, the side's decoration on
 *  it. With `target`, the decoration is placed for that side's window box
 *  (the "preview on" another layout), the way the customer editor places it. */
export function blankCard(def: SurfaceDefinition, decoration: TemplateDecoration | null, sample: File | null = null, target?: SideGeometry | null): CanvasItem {
  const side = decoration ? templateSide(decoration, def.key) : null;
  const frames: FrameState[] = (def.frames || []).map((_, i) => ({
    id: i, originalFile: sample, offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover',
    fillStyle: sample ? 'blur' : undefined,
  }));
  const overlays = (side?.overlays || []).map(o => ({ ...o }));
  return {
    id: 0, frames,
    overlays: target ? placeSideOverlays(decoration, def.key, overlays, target) : overlays,
    bgColor: side?.bgColor || '#ffffff',
    paperColor: side?.paperColor || '#ffffff',
    dataUrl: null,
    surfaceKey: def.key,
  };
}

/** The home layout's geometry per side, as the server will stamp it at
 *  save (`authoredOn`): lets the authoring page preview an unsaved draft on
 *  another layout with the same placement the customer editor will use. */
export function authoredOnFor(layoutName: string, sides: Array<{ key: string; def: SideLike }>): AuthoredOn {
  const surfaces: Record<string, SideGeometry> = {};
  for (const { key, def } of sides) {
    const g = surfaceGeometry(def);
    if (g) surfaces[key] = g;
  }
  return { layout: layoutName, surfaces };
}

/** The card with no photos: what the template holds, and what its thumbnail shows. */
export function withoutPhotos(card: CanvasItem): CanvasItem {
  return { ...card, frames: card.frames.map(f => ({ ...f, originalFile: null, fillStyle: undefined })), dataUrl: null };
}

/** Image overlays the template cannot hold as they are: the ops user's own
 *  Files from the Uploads tab, to be uploaded as stickers before saving. */
export function localImageOverlays(card: CanvasItem): Array<{ index: number; file: File }> {
  const out: Array<{ index: number; file: File }> = [];
  card.overlays.forEach((o, index) => {
    if (o.type === 'image' && o.source === 'local' && o.originalFile) out.push({ index, file: o.originalFile });
  });
  return out;
}

/** The overlay as the template stores it. A local image becomes the sticker
 *  it was uploaded as (`stickerUrls` by overlay index); one that never made
 *  it up is left out rather than saved pointing at nothing. */
function storableOverlay(o: Overlay, index: number, stickerUrls: Map<number, string>): Overlay | null {
  if (o.type !== 'image') {
    const rest = { ...o };
    delete rest.templateId;
    delete rest.templateEdited;
    return rest;
  }
  const url = stickerUrls.get(index);
  const src = o.source === 'local' ? url : o.src;
  if (!src) return null;
  const { originalFile: _file, fileId: _id, templateId: _tpl, templateEdited: _edited, ...rest } = o;
  void _file; void _id; void _tpl; void _edited;
  return { ...rest, source: o.source === 'local' ? 'clipart' : o.source, src };
}

/** The decoration of every side, from the cards ops edited. Sides with
 *  nothing on them are kept (as empty) so a multi-surface template says
 *  "this side is blank" rather than falling back to another side. */
export function decorationFromCards(
  cards: Array<{ key: string; card: CanvasItem }>,
  stickerUrls: Map<string, Map<number, string>> = new Map(),
): TemplateDecoration {
  const surfaces: Record<string, TemplateSide> = {};
  for (const { key, card } of cards) {
    const urls = stickerUrls.get(key) ?? new Map<number, string>();
    const overlays = card.overlays
      .map((o, i) => storableOverlay(o, i, urls))
      .filter((o): o is Overlay => o !== null);
    const side: TemplateSide = { overlays };
    if ((card.bgColor || '#ffffff').toLowerCase() !== '#ffffff') side.bgColor = card.bgColor;
    if ((card.paperColor || '#ffffff').toLowerCase() !== '#ffffff') side.paperColor = card.paperColor;
    surfaces[key] = side;
  }
  return { surfaces };
}

/** True when the decoration draws nothing at all. */
export function isEmptyDecoration(decoration: TemplateDecoration): boolean {
  return Object.values(decoration.surfaces).every(s => s.overlays.length === 0 && !s.bgColor && !s.paperColor);
}

/** A layout as GET /api/ops/templates/candidates lists it: the size a
 *  template on it is keyed on. `windowKey` is the box around its photo
 *  windows (bleed included) rounded to the millimetre; two layouts with the
 *  same key can share a template. `printAreaKey` is the same box without
 *  the bleed, so layouts that agree on it but not on `windowKey` differ only
 *  in bleed. */
export interface TemplateCandidate {
  name: string;
  displayName: string;
  windowBox: MmRect | null;
  windowKey: string | null;
  printAreaBox: MmRect | null;
  printAreaKey: string | null;
  bleedMm: number;
  /** The layout's sides (`default`, or `front`, `back`, …): a template is drawn per side, so they must match too. */
  surfaceKeys: string[];
  templateCount: number;
}

export interface SizeGroup {
  key: string;
  label: string;
  layouts: TemplateCandidate[];
}

/** The group key of layouts with no print areas, last in the Create picker. */
export const NO_PRINT_AREAS_KEY = 'none';
const NO_WINDOWS = NO_PRINT_AREAS_KEY;

const sameSides = (a: Pick<TemplateCandidate, 'surfaceKeys'>, b: Pick<TemplateCandidate, 'surfaceKeys'>) =>
  (a.surfaceKeys ?? []).join(',') === (b.surfaceKeys ?? []).join(',');

/** "117 × 168 mm, 7.6 mm bleed" for a layout. */
export function sizeLabel(c: Pick<TemplateCandidate, 'windowBox' | 'bleedMm'>): string {
  const bleed = Number(c.bleedMm) > 0 ? `, ${Math.round(Number(c.bleedMm) * 10) / 10} mm bleed` : '';
  return `${boxLabel(c.windowBox)}${bleed}`;
}

/** A ticked layout the template can no longer be offered on: retired since
 *  (absent from the live candidates), or its print areas moved so its box
 *  is another size. Shown ticked so ops can untick it; the server refuses a
 *  save that still names it. */
export interface IneligibleTicked {
  name: string;
  displayName: string;
  reason: 'retired' | 'size_changed' | 'sides_changed';
  size: string;
}

export function ineligibleTicked(candidates: TemplateCandidate[], homeName: string, ticked: string[]): IneligibleTicked[] {
  const home = candidates.find(c => c.name === homeName);
  const byName = new Map(candidates.map(c => [c.name, c]));
  return ticked
    .filter(name => name !== homeName)
    .flatMap((name): IneligibleTicked[] => {
      const c = byName.get(name);
      if (!c) return [{ name, displayName: name, reason: 'retired', size: '' }];
      if (!home?.windowKey || c.windowKey !== home.windowKey) return [{ name, displayName: c.displayName, reason: 'size_changed', size: sizeLabel(c) }];
      if (!sameSides(c, home)) return [{ name, displayName: c.displayName, reason: 'sides_changed', size: sizeLabel(c) }];
      return [];
    });
}

/** Layouts grouped by window box for the Create picker: the biggest group
 *  first, layouts without print areas last. */
export function groupBySize(candidates: TemplateCandidate[]): SizeGroup[] {
  const groups = new Map<string, SizeGroup>();
  for (const c of candidates) {
    const key = c.windowKey ?? NO_WINDOWS;
    const g = groups.get(key) ?? { key, label: c.windowKey ? sizeLabel(c) : 'No print areas', layouts: [] };
    g.layouts.push(c);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => ({ ...g, layouts: [...g.layouts].sort((a, b) => a.displayName.localeCompare(b.displayName)) }))
    .sort((a, b) => (a.key === NO_WINDOWS ? 1 : 0) - (b.key === NO_WINDOWS ? 1 : 0) || b.layouts.length - a.layouts.length || a.label.localeCompare(b.label));
}

/** The other layouts a template authored on `homeName` can be offered on:
 *  the same size (print areas plus bleed) and the same sides. */
export function sameBoxLayouts(candidates: TemplateCandidate[], homeName: string): TemplateCandidate[] {
  const home = candidates.find(c => c.name === homeName);
  if (!home?.windowKey) return [];
  return candidates
    .filter(c => c.name !== homeName && c.windowKey === home.windowKey && sameSides(c, home))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Layouts with the same print areas and sides but a different bleed: not
 *  eligible, shown so a bleed typed differently on one layout is not a mystery. */
export function nearMissLayouts(candidates: TemplateCandidate[], homeName: string): TemplateCandidate[] {
  const home = candidates.find(c => c.name === homeName);
  if (!home?.printAreaKey) return [];
  return candidates
    .filter(c => c.name !== homeName && c.windowKey !== home.windowKey && c.printAreaKey === home.printAreaKey && sameSides(c, home))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** A PNG File from a data: URL (the thumbnail the editor renders). */
export function dataUrlToPngFile(dataUrl: string, name = 'thumbnail.png'): File | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
}
