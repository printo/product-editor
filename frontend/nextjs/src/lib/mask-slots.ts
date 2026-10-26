/**
 * A layout's two mask slots. Twin of `services/print_sheet.py::resolve_mask_slots`.
 *
 * `frameMaskUrl` is placed outside the bleed area (the frame picture): drawn
 * in every preview and in the mock, never printed. `artworkMaskUrl` is placed
 * inside it (artwork with photo holes): drawn in previews and the mock, and
 * printed, cropped to the bleed area with everything else. Above photos and
 * overlays the order is artwork, then the frame picture on top.
 *
 * The legacy pair is read compatibly: `maskUrl` with `maskOnExport: true` was
 * the artwork, with it false or absent the frame picture. The new keys win
 * only when one of them holds a URL, so the two empty keys every response now
 * carries never hide a legacy mask.
 */

export interface MaskSlots {
  frameMaskUrl: string | null;
  artworkMaskUrl: string | null;
}

const NONE: MaskSlots = { frameMaskUrl: null, artworkMaskUrl: null };

const url = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

export function resolveMaskSlots(block: unknown): MaskSlots {
  if (!block || typeof block !== 'object') return NONE;
  const b = block as Record<string, unknown>;
  const frame = url(b.frameMaskUrl);
  const artwork = url(b.artworkMaskUrl);
  if (frame || artwork) return { frameMaskUrl: frame, artworkMaskUrl: artwork };
  const legacy = url(b.maskUrl);
  if (!legacy) return NONE;
  return b.maskOnExport === true
    ? { frameMaskUrl: null, artworkMaskUrl: legacy }
    : { frameMaskUrl: legacy, artworkMaskUrl: null };
}
