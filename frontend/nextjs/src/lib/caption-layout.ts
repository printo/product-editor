// Shared placement maths for per-frame captions.
//
// A caption can be freely positioned by the ops author (stored in mm on the
// layout frame) or left unset (legacy) — in which case it falls back to the
// historical "bottom-centre, 80% width, 4% font" look. This module resolves a
// caption box in ONE coordinate space (whatever the caller passes fx/fy/fw/fh
// in — canvas px for the browser renderers) so the browser preview and the
// Python print engine place the caption identically. The engine mirrors these
// exact formulas in `_resolve_caption_box` (see engine.py) with a parity test.
//
// Framework-free and side-effect-free so it is unit-testable without Fabric.

export type CaptionAlign = 'left' | 'center' | 'right';

export interface CaptionBoxOverrides {
  /** Explicit box geometry/style in the SAME space as fx/fy/fw/fh. Any null/
   *  undefined field falls back to the derived default below. */
  xPx?: number | null;
  yPx?: number | null;
  wPx?: number | null;
  fontPx?: number | null;
  align?: CaptionAlign | null;
  color?: string | null;
}

export interface ResolvedCaptionBox {
  /** Top-left origin, matching the frame rect origin. */
  x: number;
  y: number;
  w: number;
  fontPx: number;
  align: CaptionAlign;
  color: string;
}

export const DEFAULT_CAPTION_COLOR = '#2a2a2a';

/** Caption geometry/style as stored on a layout frame (millimetres). */
export interface CaptionMmFields {
  captionXMm?: number | string | null;
  captionYMm?: number | string | null;
  captionWidthMm?: number | string | null;
  captionFontMm?: number | string | null;
  captionAlign?: CaptionAlign | null;
  captionColor?: string | null;
}

/** Convert a layout frame's mm caption fields into px overrides for a renderer
 *  working at `pxPerMm` (canvas px per mm = dpi / 25.4 in every renderer). */
export function captionOverridesFromMm(
  f: CaptionMmFields,
  pxPerMm: number,
): CaptionBoxOverrides {
  const mm = (v: number | string | null | undefined) =>
    v == null || v === '' ? null : Number(v) * pxPerMm;
  return {
    xPx: mm(f.captionXMm),
    yPx: mm(f.captionYMm),
    wPx: mm(f.captionWidthMm),
    fontPx: mm(f.captionFontMm),
    align: f.captionAlign ?? null,
    color: f.captionColor ?? null,
  };
}

/** True when the frame carries any explicit caption placement/style. When
 *  false the renderers use their historical bottom-centre path unchanged, so
 *  existing templates print byte-identically. */
export function hasCaptionPlacement(o?: CaptionBoxOverrides | null): boolean {
  if (!o) return false;
  return (
    o.xPx != null || o.yPx != null || o.wPx != null ||
    o.fontPx != null || o.align != null || o.color != null
  );
}

/**
 * Resolve the caption box (top-left origin) from the frame rect + optional
 * explicit overrides. Defaults reproduce the legacy bottom-centre placement so
 * an un-positioned caption looks the same as before.
 */
export function resolveCaptionBox(
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  o?: CaptionBoxOverrides | null,
): ResolvedCaptionBox {
  const w = o?.wPx != null ? o.wPx : fw * 0.8;
  const fontPx = o?.fontPx != null ? o.fontPx : fh * 0.04;
  const x = o?.xPx != null ? o.xPx : fx + (fw - w) / 2;
  // Legacy vertical centre sat at fh - 8% up from the bottom; convert to a
  // top-left box by lifting half the (single-line) font height.
  const y = o?.yPx != null ? o.yPx : fy + fh - fh * 0.08 - fontPx / 2;
  const align: CaptionAlign = o?.align ?? 'center';
  const color = o?.color ?? DEFAULT_CAPTION_COLOR;
  return { x, y, w, fontPx, align, color };
}
