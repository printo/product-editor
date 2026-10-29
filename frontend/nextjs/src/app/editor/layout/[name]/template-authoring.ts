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
import { inches, printSheetMode, windowBoxMm, type MmRect } from '@/lib/print-sheet';
import type { OrientationInfo } from '@/lib/layout-orientation';
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

/** The label of the one full-sheet artwork a side can carry from the
 *  "Upload artwork" button; a second upload replaces it. */
export const ARTWORK_LABEL = 'Artwork';

/** Files the Upload artwork button takes: PNG, or an SVG the server checks like a mask. */
export const ARTWORK_ACCEPT_ATTR = '.png,.svg,image/png,image/svg+xml';

/**
 * A full-sheet artwork for a side: an image overlay (a sticker) covering
 * what that side prints, so the file is designed at the print size with
 * transparent holes where the photos go. A Bleed area print is covered on
 * the box around its print areas plus bleed; a Whole canvas print on the
 * whole canvas. Percent of the canvas, like every overlay, so it is placed
 * on another layout by the same rule as the rest of the decoration.
 */
export function artworkOverlayFor(def: Pick<SurfaceDefinition, 'canvas' | 'frames' | 'printSheet'>, src: string): Extract<Overlay, { type: 'image' }> {
  const canvas = def.canvas as { widthMm?: number; heightMm?: number };
  const wMm = Number(canvas?.widthMm ?? 0);
  const hMm = Number(canvas?.heightMm ?? 0);
  const box = printSheetMode(def.printSheet) === 'bleed' && wMm > 0 && hMm > 0 ? windowBoxMm(canvas, def.frames || []) : null;
  const pct = (v: number) => Math.round(v * 1000) / 1000;
  const place = box
    ? { x: pct((box.xMm / wMm) * 100), y: pct((box.yMm / hMm) * 100), width: pct((box.widthMm / wMm) * 100), height: pct((box.heightMm / hMm) * 100) }
    : { x: 0, y: 0, width: 100, height: 100 };
  return { type: 'image', id: `artwork-${Date.now()}`, source: 'clipart', src, label: ARTWORK_LABEL, rotation: 0, opacity: 1, ...place };
}

/** The card with this side's artwork: the previous upload (by label) is
 *  replaced, and the artwork sits first so text and stickers draw over it. */
export function withArtwork(card: CanvasItem, artwork: Overlay): CanvasItem {
  const rest = card.overlays.filter(o => !(o.type === 'image' && o.label === ARTWORK_LABEL));
  return { ...card, overlays: [artwork, ...rest], dataUrl: null };
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
 *  in bleed. The `turned*` keys are the same for the layout turned a quarter
 *  turn (null when it cannot be turned): a layout also carries a template
 *  keyed on its turned size, offered on orders in that orientation. */
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
  turnedWindowKey?: string | null;
  turnedPrintAreaKey?: string | null;
  /** How the layout is drawn and why it can never be turned (null when it can); absent from an older server. */
  orientationInfo?: OrientationInfo | null;
  templateCount: number;
}

/** Which way a box faces. A template faces the way its print areas did when
 *  it was designed and is offered only where the customer's face the same
 *  way; a square box faces either way. */
export type BoxFacing = 'portrait' | 'landscape' | 'square';

const KEY_RE = /^(\d+)x(\d+)$/;

/** The facing of a size key: `'117x168'` → portrait. Null for no key. */
export function keyFacing(key: string | null | undefined): BoxFacing | null {
  const m = KEY_RE.exec(key ?? '');
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return h > w ? 'portrait' : w > h ? 'landscape' : 'square';
}

/** The size whichever way it faces: the key with the shorter side first
 *  (`'168x117'` → `'117x168'`), so a portrait and a landscape 4x6 are one size
 *  in the Create picker and the filter. */
export function pairKey(key: string | null | undefined): string | null {
  const m = KEY_RE.exec(key ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return `${Math.min(a, b)}x${Math.max(a, b)}`;
}

/** The key a layout shows in a facing: as drawn when it faces that way (or
 *  is square), turned when it can be, else null. Without a facing, as drawn. */
function keyIn(drawn: string | null | undefined, turned: string | null | undefined, facing: BoxFacing | null): string | null {
  if (!facing) return drawn ?? null;
  const d = keyFacing(drawn);
  if (d === facing || d === 'square') return drawn ?? null;
  return keyFacing(turned) === facing ? turned ?? null : null;
}

export function keyInFacing(c: Pick<TemplateCandidate, 'windowKey' | 'turnedWindowKey'>, facing: BoxFacing | null): string | null {
  return keyIn(c.windowKey, c.turnedWindowKey, facing);
}

/** The way a layout's print areas face as drawn. */
export function drawnFacing(c: Pick<TemplateCandidate, 'windowKey'>): BoxFacing | null {
  return keyFacing(c.windowKey);
}

export interface SizeGroup {
  key: string;
  label: string;
  layouts: TemplateCandidate[];
  /** The facings a template of this size can take: the ways its layouts are drawn, plus the other way for any that can turn. */
  facings: BoxFacing[];
}

/** The group key of layouts with no print areas, last in the Create picker. */
export const NO_PRINT_AREAS_KEY = 'none';
const NO_WINDOWS = NO_PRINT_AREAS_KEY;

const sameSides = (a: Pick<TemplateCandidate, 'surfaceKeys'>, b: Pick<TemplateCandidate, 'surfaceKeys'>) =>
  (a.surfaceKeys ?? []).join(',') === (b.surfaceKeys ?? []).join(',');

/** "4 × 6 in, 0.3 in bleed": the size as the team says it, the print areas
 *  in inches, shorter side first whichever way they face, plus their bleed.
 *  (The key the server matches on is the box with the bleed included, so two
 *  labels that differ only in bleed are two sizes.) */
export function sizeLabel(c: Pick<TemplateCandidate, 'printAreaBox' | 'bleedMm'>): string {
  const box = c.printAreaBox;
  if (!box) return 'no print areas';
  const short = Math.min(box.widthMm, box.heightMm);
  const long = Math.max(box.widthMm, box.heightMm);
  const bleed = Number(c.bleedMm) > 0 ? `, ${inches(Number(c.bleedMm))} in bleed` : '';
  return `${inches(short)} × ${inches(long)} in${bleed}`;
}

/** A ticked layout the template can no longer be offered on: retired since
 *  (absent from the live candidates), or its print areas moved so its box
 *  is another size, as drawn and turned. Shown ticked so ops can untick it;
 *  the server refuses a save that still names it. */
export interface IneligibleTicked {
  name: string;
  displayName: string;
  reason: 'retired' | 'size_changed' | 'sides_changed';
  size: string;
}

/** The key a template designed on `homeName` in `facing` is keyed on: the
 *  home layout's box as drawn, or turned when the facing is the other way. */
export function templateKey(candidates: TemplateCandidate[], homeName: string, facing: BoxFacing | null): string | null {
  const home = candidates.find(c => c.name === homeName);
  return home ? keyInFacing(home, facing) : null;
}

const carries = (c: TemplateCandidate, key: string) => c.windowKey === key || (c.turnedWindowKey ?? null) === key;

export function ineligibleTicked(candidates: TemplateCandidate[], homeName: string, ticked: string[], facing: BoxFacing | null = null): IneligibleTicked[] {
  const home = candidates.find(c => c.name === homeName);
  const key = templateKey(candidates, homeName, facing);
  const byName = new Map(candidates.map(c => [c.name, c]));
  return ticked
    .filter(name => name !== homeName)
    .flatMap((name): IneligibleTicked[] => {
      const c = byName.get(name);
      if (!c) return [{ name, displayName: name, reason: 'retired', size: '' }];
      if (!key || !carries(c, key)) return [{ name, displayName: c.displayName, reason: 'size_changed', size: sizeLabel(c) }];
      if (!home || !sameSides(c, home)) return [{ name, displayName: c.displayName, reason: 'sides_changed', size: sizeLabel(c) }];
      return [];
    });
}

/** Layouts grouped by size, whichever way they face, for the Create picker
 *  and the Templates filter: smallest size first, layouts without print
 *  areas last, layouts by name within a group. */
export function groupBySize(candidates: TemplateCandidate[]): SizeGroup[] {
  const groups = new Map<string, SizeGroup>();
  for (const c of candidates) {
    const key = pairKey(c.windowKey) ?? NO_WINDOWS;
    const g = groups.get(key) ?? { key, label: c.windowKey ? sizeLabel(c) : 'No print areas', layouts: [], facings: [] };
    g.layouts.push(c);
    for (const f of [keyFacing(c.windowKey), keyFacing(c.turnedWindowKey)]) {
      if (f && !g.facings.includes(f)) g.facings.push(f);
    }
    groups.set(key, g);
  }
  const area = (g: SizeGroup) => {
    const b = g.layouts[0]?.windowBox;
    return b ? b.widthMm * b.heightMm : Number.POSITIVE_INFINITY;
  };
  return [...groups.values()]
    .map(g => ({
      ...g,
      layouts: [...g.layouts].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      facings: (['portrait', 'landscape', 'square'] as const).filter(f => g.facings.includes(f)),
    }))
    .sort((a, b) => area(a) - area(b) || a.label.localeCompare(b.label));
}

/** The layouts of a size that can show a facing, each saying whether it
 *  opens turned (drawn the other way) for it. */
export function layoutsInFacing(group: Pick<SizeGroup, 'layouts'>, facing: BoxFacing): Array<{ layout: TemplateCandidate; turned: boolean }> {
  return group.layouts.flatMap(layout => {
    const key = keyInFacing(layout, facing);
    return key ? [{ layout, turned: key !== layout.windowKey }] : [];
  });
}

/** The other layouts a template authored on `homeName` (facing `facing`, or
 *  as the home is drawn) can be offered on: the same size, as drawn or
 *  turned, and the same sides. `turned` says the layout shows it turned. */
export function sameBoxLayouts(candidates: TemplateCandidate[], homeName: string, facing: BoxFacing | null = null): Array<TemplateCandidate & { turned: boolean }> {
  const home = candidates.find(c => c.name === homeName);
  const key = templateKey(candidates, homeName, facing);
  if (!home || !key) return [];
  return candidates
    .filter(c => c.name !== homeName && carries(c, key) && sameSides(c, home))
    .map(c => ({ ...c, turned: c.windowKey !== key }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Layouts with the same print areas and sides but a different bleed: not
 *  eligible, shown so a bleed typed differently on one layout is not a mystery. */
export function nearMissLayouts(candidates: TemplateCandidate[], homeName: string, facing: BoxFacing | null = null): TemplateCandidate[] {
  const home = candidates.find(c => c.name === homeName);
  if (!home) return [];
  const key = templateKey(candidates, homeName, facing);
  const area = keyIn(home.printAreaKey, home.turnedPrintAreaKey, facing);
  if (!area) return [];
  return candidates
    .filter(c => c.name !== homeName && !(key && carries(c, key)) && sameSides(c, home)
      && (c.printAreaKey === area || (c.turnedPrintAreaKey ?? null) === area))
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
