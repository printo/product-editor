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
import type { TemplateDecoration, TemplateSide } from './layout-template';
import { templateSide } from './layout-template';
import type { CanvasItem, FrameState, Overlay } from './types';

export const TEMPLATE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** A template id from a display name: "Retro Birthday!" → "retro-birthday". */
export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function isTemplateId(value: string): boolean {
  return TEMPLATE_ID_RE.test(value);
}

/** One blank card for a side: every frame empty, the side's decoration on it. */
export function blankCard(def: SurfaceDefinition, decoration: TemplateDecoration | null, sample: File | null = null): CanvasItem {
  const side = decoration ? templateSide(decoration, def.key) : null;
  const frames: FrameState[] = (def.frames || []).map((_, i) => ({
    id: i, originalFile: sample, offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover',
    fillStyle: sample ? 'blur' : undefined,
  }));
  return {
    id: 0, frames,
    overlays: (side?.overlays || []).map(o => ({ ...o })),
    bgColor: side?.bgColor || '#ffffff',
    paperColor: side?.paperColor || '#ffffff',
    dataUrl: null,
    surfaceKey: def.key,
  };
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
    return rest;
  }
  const url = stickerUrls.get(index);
  const src = o.source === 'local' ? url : o.src;
  if (!src) return null;
  const { originalFile: _file, fileId: _id, templateId: _tpl, ...rest } = o;
  void _file; void _id; void _tpl;
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

/** A PNG File from a data: URL (the thumbnail the editor renders). */
export function dataUrlToPngFile(dataUrl: string, name = 'thumbnail.png'): File | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
}
