/**
 * Layout templates on the customer side (named layout-template.ts because
 * `template.ts` in a route folder is a Next.js special file): the one place a template's
 * decoration is copied onto a card.
 *
 * A template (ops-authored, served by GET /api/templates) holds a decoration
 * per side of the product: background and paper colour plus text, shape and
 * sticker overlays. Cards only exist once there are photos, so the template
 * is held by the page and applied here, as each card is created by
 * useCanvasGeneration, and again on every card when the customer picks a
 * template over an existing design or asks for it to be re-applied.
 *
 * Every overlay copied from a template carries `templateId`, which is how
 * the editor later tells template decoration from the customer's own work:
 * the re-pick confirm (canvas-merge.ts) ignores it, and a re-apply replaces
 * only those overlays. Once the customer changes one in the canvas editor it
 * also carries `templateEdited` (markEditedTemplateOverlays), and the re-pick
 * confirm counts it as theirs. Stickers are image overlays with `source: 'clipart'`
 * and an address under /api/templates/assets/, made absolute here so the
 * print raster (lib/icon-raster.ts) treats them like icons.
 *
 * Generic layouts only: the key is the surface key the editor already uses
 * (`default` for a single-sided product). Calendars and books are not wired
 * in and get no hooks here until they are built.
 *
 * Since 2026-10-28 a template is offered on every layout whose window box
 * (lib/print-sheet.ts) is the same size as its home layout's. The
 * decoration stays in percent of the home canvas; `placeOverlay` moves each
 * overlay onto the target canvas by its millimetre offset from the window
 * box's centre, using the home geometry the server stamped (`authoredOn`).
 */
import { DEFAULT_TEXT_BOX_WIDTH_PCT } from '@/lib/overlay-text';
import { windowBoxMm, type MmRect, type StoredWindow } from '@/lib/print-sheet';
import type { CanvasItem, Overlay } from './types';

export interface TemplateSide {
  bgColor?: string;
  paperColor?: string;
  overlays: Overlay[];
}

/** One side's canvas, in print px and mm, and the box around its photo
 *  windows as stored (bleed included). The server stamps the home layout's
 *  into `decoration.authoredOn` on every save; the editor reads the target
 *  layout's with `surfaceGeometry`. */
export interface SideGeometry {
  canvas: { width: number; height: number; widthMm: number; heightMm: number };
  windowBox: MmRect | null;
}

export interface AuthoredOn {
  layout: string;
  surfaces: Record<string, SideGeometry>;
}

export interface TemplateDecoration {
  surfaces: Record<string, TemplateSide>;
  /** The home layout's geometry, set by the server at save. Absent on a
   *  template saved before templates could be shared: drawn as it is. */
  authoredOn?: AuthoredOn;
}

/** A template as GET /api/templates serves it. */
export interface LayoutTemplate {
  id: string;
  /** The home layout it was authored on. */
  layoutName: string;
  /** Other layouts with the same window box it is also offered on. */
  alsoOn?: string[];
  /** Ops reads only: ticked layouts that were retired or no longer have the same box. */
  alsoOnMismatch?: string[];
  /** The orientation it was designed for ('' = the home layout as drawn) and
   *  which way its print areas face as a result. A template is offered only
   *  where the customer's layout, turned or not, faces the same way. */
  orientation?: '' | 'portrait' | 'landscape';
  facing?: 'portrait' | 'landscape' | 'square' | null;
  /** Ops reads only: the home layout's size, the box the key is made of and the print areas it is shown as. */
  windowBox?: MmRect | null;
  printAreaBox?: MmRect | null;
  bleedMm?: number;
  displayName: string;
  status?: 'draft' | 'published';
  decoration: TemplateDecoration;
  thumbnailUrl: string | null;
  layoutVersion?: number;
  updatedAt?: string | null;
}

/** What the autosave keeps, so a refresh re-applies the same decoration to
 *  cards added later even if ops have since changed or unpublished it. */
export interface SavedTemplate {
  id: string;
  displayName: string;
  decoration: TemplateDecoration;
}

export const STICKER_URL_PREFIX = '/api/templates/assets/';

const DEFAULT_COLOR = '#ffffff';

export function isLayoutTemplate(value: unknown): value is LayoutTemplate {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const deco = v.decoration as Record<string, unknown> | undefined;
  return typeof v.id === 'string' && typeof v.displayName === 'string'
    && !!deco && typeof deco === 'object' && !!deco.surfaces && typeof deco.surfaces === 'object';
}

export function toSavedTemplate(t: LayoutTemplate | SavedTemplate): SavedTemplate {
  return { id: t.id, displayName: t.displayName, decoration: t.decoration };
}

/** The side of the decoration for a surface: its own key, else `default`,
 *  else the only side there is (a single-sided template applied to a product
 *  whose one surface has another key). */
export function templateSide(decoration: TemplateDecoration | null | undefined, surfaceKey: string): TemplateSide | null {
  const sides = decoration?.surfaces;
  if (!sides) return null;
  const keys = Object.keys(sides);
  const side = sides[surfaceKey] ?? sides.default ?? (keys.length === 1 ? sides[keys[0]] : undefined);
  return side ?? null;
}

export function isTemplateOverlay(o: { templateId?: string } | null | undefined): boolean {
  return typeof o?.templateId === 'string' && o.templateId.length > 0;
}

/** A sticker address the print raster and both previews can load from
 *  anywhere the editor runs: an absolute URL. Same-origin so the raster's
 *  fetch needs no CORS, and on S3 deployments the server answers with a
 *  302 to the CDN, which carries the CORS headers the canvas draw needs. */
export function absoluteStickerSrc(src: string): string {
  if (!src.startsWith(STICKER_URL_PREFIX)) return src;
  if (typeof window === 'undefined') return src;
  return new URL(src, window.location.origin).toString();
}

let seq = 0;

/** A layout side as the editor holds it: enough to read its geometry. */
export interface SideLike {
  canvas?: { width?: number | string; height?: number | string; widthMm?: number | string; heightMm?: number | string } | null;
  frames?: StoredWindow[] | null;
}

const toNum = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The geometry of a layout side, the way the server stamps a template's
 *  home side (`authoredOn.surfaces[key]`). */
export function surfaceGeometry(side: SideLike | null | undefined): SideGeometry | null {
  const canvas = side?.canvas;
  if (!canvas) return null;
  const geometry = {
    width: toNum(canvas.width), height: toNum(canvas.height),
    widthMm: toNum(canvas.widthMm), heightMm: toNum(canvas.heightMm),
  };
  return { canvas: geometry, windowBox: windowBoxMm(geometry, side?.frames || []) };
}

function usable(g: SideGeometry | null | undefined): g is SideGeometry {
  return !!g && g.canvas.widthMm > 0 && g.canvas.heightMm > 0 && g.canvas.width > 0 && g.canvas.height > 0;
}

/** Where the artwork is anchored: the window box's centre, else the canvas's. */
function anchorMm(g: SideGeometry): { x: number; y: number } {
  const b = g.windowBox;
  if (b) return { x: b.xMm + b.widthMm / 2, y: b.yMm + b.heightMm / 2 };
  return { x: g.canvas.widthMm / 2, y: g.canvas.heightMm / 2 };
}

/**
 * The overlay as it should sit on another layout: the same millimetres
 * from the centre of that layout's window box as it had from its home
 * layout's, the same size in millimetres, the same text size in print
 * pixels of that layout. Positions are percent of the canvas on both sides,
 * so the conversion goes percent → mm → offset from the home box centre →
 * the target box centre → percent. Centred rather than corner-anchored so
 * the fraction of a millimetre two "same size" boxes can differ by splits
 * evenly to the edges instead of nudging the art to one side. Identity when
 * both sides are the same geometry.
 */
export function placeOverlay(o: Overlay, from: SideGeometry | null | undefined, to: SideGeometry | null | undefined): Overlay {
  if (!usable(from) || !usable(to)) return o;
  const fromAnchor = anchorMm(from);
  const toAnchor = anchorMm(to);
  const fw = from.canvas.widthMm, fh = from.canvas.heightMm;
  const tw = to.canvas.widthMm, th = to.canvas.heightMm;
  const pctX = (x: number) => (((x / 100) * fw - fromAnchor.x + toAnchor.x) / tw) * 100;
  const pctY = (y: number) => (((y / 100) * fh - fromAnchor.y + toAnchor.y) / th) * 100;
  const sizeX = (w: number) => ((w / 100) * fw / tw) * 100;
  const sizeY = (h: number) => ((h / 100) * fh / th) * 100;
  // Print pixels per mm can differ between layouts; a size in print px follows the millimetres.
  const pxScale = (to.canvas.width / tw) / (from.canvas.width / fw);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const at = { x: round(pctX(o.x)), y: round(pctY(o.y)) };
  if (o.type === 'text') {
    // A text without a width wraps at the editor's default share of the
    // canvas (lib/overlay-text.ts), which is another width in millimetres
    // on another canvas: pin the box it had on the home canvas.
    const width = typeof o.width === 'number' ? o.width : DEFAULT_TEXT_BOX_WIDTH_PCT;
    return { ...o, ...at, fontSize: round(o.fontSize * pxScale), width: round(sizeX(width)) };
  }
  if (o.type === 'shape') {
    return { ...o, ...at, width: round(sizeX(o.width)), height: round(sizeY(o.height)), strokeWidth: round(o.strokeWidth * pxScale) };
  }
  return { ...o, ...at, width: round(sizeX(o.width)), height: round(sizeY(o.height)) };
}

/** A side's overlays placed on `target`, when the template says where it
 *  was authored; as they are otherwise (the home layout, or an older template). */
export function placeSideOverlays(decoration: TemplateDecoration | null | undefined, surfaceKey: string, overlays: Overlay[], target: SideGeometry | null | undefined): Overlay[] {
  const sides = decoration?.authoredOn?.surfaces;
  if (!sides || !target) return overlays;
  const keys = Object.keys(sides);
  const from = sides[surfaceKey] ?? sides.default ?? (keys.length === 1 ? sides[keys[0]] : undefined);
  if (!from) return overlays;
  return overlays.map(o => placeOverlay(o, from, target));
}

/** Fresh copies of a side's overlays for one card: new ids (an overlay id
 *  must be unique within a card), the template tag, absolute sticker
 *  addresses, placed for `target` when given. Deep-copied so cards never
 *  share an overlay object. */
export function templateOverlays(template: SavedTemplate | LayoutTemplate, surfaceKey: string, target?: SideGeometry | null): Overlay[] {
  const side = templateSide(template.decoration, surfaceKey);
  if (!side) return [];
  const copies = (side.overlays || []).map((o, i) => {
    const copy = JSON.parse(JSON.stringify(o)) as Overlay;
    copy.id = `tpl-${template.id}-${i}-${++seq}`;
    copy.templateId = template.id;
    if (copy.type === 'image') copy.src = absoluteStickerSrc(copy.src);
    return copy;
  });
  return placeSideOverlays(template.decoration, surfaceKey, copies, target);
}

/** The colours a side sets, with white where the template is silent. */
export function templateColours(template: SavedTemplate | LayoutTemplate | null | undefined, surfaceKey: string): { bgColor: string; paperColor: string } {
  const side = template ? templateSide(template.decoration, surfaceKey) : null;
  return { bgColor: side?.bgColor || DEFAULT_COLOR, paperColor: side?.paperColor || DEFAULT_COLOR };
}

/** What a brand-new card starts with under this template, on the side
 *  whose geometry is `target` (the layout the customer is on). */
export function seedCard(template: SavedTemplate | LayoutTemplate | null | undefined, surfaceKey: string, target?: SideGeometry | null): Pick<CanvasItem, 'overlays' | 'bgColor' | 'paperColor'> {
  if (!template) return { overlays: [], bgColor: DEFAULT_COLOR, paperColor: DEFAULT_COLOR };
  return { overlays: templateOverlays(template, surfaceKey, target), ...templateColours(template, surfaceKey) };
}

/** Apply a template to an existing card: its previous template overlays go,
 *  the new ones come in underneath the customer's own overlays, and the
 *  colours follow the template. Photos and the customer's own additions
 *  stay. `null` strips the template. The preview is cleared so the card is
 *  redrawn. */
export function applyTemplateToCard(canvas: CanvasItem, template: SavedTemplate | LayoutTemplate | null, surfaceKey: string, target?: SideGeometry | null): CanvasItem {
  const own = (canvas.overlays || []).filter(o => !isTemplateOverlay(o));
  const seed = seedCard(template, surfaceKey, target);
  return { ...canvas, overlays: [...seed.overlays, ...own], bgColor: seed.bgColor, paperColor: seed.paperColor, dataUrl: null };
}

export function applyTemplateToCards(canvases: CanvasItem[], template: SavedTemplate | LayoutTemplate | null, surfaceKey: string, target?: SideGeometry | null): CanvasItem[] {
  return canvases.map(c => applyTemplateToCard(c, template, surfaceKey, target));
}

/** Numbers within this are the same: the canvas editor rounds positions to
 *  a tenth of a percent when it writes them back. */
const SAME_NUMBER = 0.05;

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= SAME_NUMBER;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

const IGNORED_KEYS = new Set(['id', 'templateEdited', 'originalFile']);

function overlayChanged(before: Overlay, after: Overlay): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (IGNORED_KEYS.has(k)) continue;
    if (!sameValue((before as unknown as Record<string, unknown>)[k], (after as unknown as Record<string, unknown>)[k])) return true;
  }
  return false;
}

/** After the canvas editor saves a card: each template overlay that differs
 *  from how it was when the editor opened is marked `templateEdited`, so the
 *  customer's change to it (a name typed into "Happy Birthday", a moved
 *  sticker) is protected by the re-pick confirm. Matched by overlay id. */
export function markEditedTemplateOverlays(before: Overlay[], after: Overlay[]): Overlay[] {
  const byId = new Map(before.map(o => [String(o.id), o]));
  return after.map(o => {
    if (!isTemplateOverlay(o) || o.templateEdited) return o;
    const was = byId.get(String(o.id));
    if (!was || !overlayChanged(was, o)) return o;
    return { ...o, templateEdited: true };
  });
}

/** The edits a template did not make: the customer's own overlays (including
 *  template overlays they changed), and a colour that differs from the
 *  template's. Used by the re-pick confirm so a card that only carries
 *  untouched template decoration never reads as edited. */
export function customerDecoration(canvas: CanvasItem, template: SavedTemplate | LayoutTemplate | null | undefined, surfaceKey: string): { overlays: Overlay[]; bgChanged: boolean; paperChanged: boolean } {
  const colours = templateColours(template, surfaceKey);
  return {
    overlays: (canvas.overlays || []).filter(o => !isTemplateOverlay(o) || o.templateEdited),
    bgChanged: (canvas.bgColor || DEFAULT_COLOR).toLowerCase() !== colours.bgColor.toLowerCase(),
    paperChanged: (canvas.paperColor || DEFAULT_COLOR).toLowerCase() !== colours.paperColor.toLowerCase(),
  };
}
