// Pure geometry helpers for the ops layout editor's print-area frames.
//
// Everything here works in millimetres — the source-of-truth domain the
// editor stores (xMm/yMm/widthMm/heightMm). Kept framework-free and
// side-effect-free so the alignment/nudge maths is unit-testable without
// Fabric or a DOM. LayoutFabricPreview applies the returned frames back onto
// the canvas; page.tsx renders them in the areas table.

export type AlignEdge = 'left' | 'centerH' | 'right' | 'top' | 'middleV' | 'bottom';

// Minimal structural shape the maths needs. Callers pass their own richer
// frame type (LayoutFrame); the generic `<T extends AlignFrame>` preserves it
// on the way out, so extra fields (bleed, caption, x/y/width/height) survive.
export interface AlignFrame {
  id?: string;
  xMm?: number | string;
  yMm?: number | string;
  widthMm?: number | string;
  heightMm?: number | string;
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Align the selected frames (matched by `id`) to a shared edge of their
 * common bounding box. Non-selected frames are returned unchanged.
 *
 * Alignment uses each frame's printable ("safe") rectangle — bleed is
 * ignored, matching the green area shown in the preview. Needs ≥2 selected
 * frames to have any effect (aligning one frame to itself is a no-op).
 */
export function alignFrames<T extends AlignFrame>(
  frames: T[],
  ids: string[],
  edge: AlignEdge,
): T[] {
  const idSet = new Set(ids);
  const sel = frames.filter((f) => f.id != null && idSet.has(f.id));
  if (sel.length < 2) return frames;

  const minX = Math.min(...sel.map((f) => num(f.xMm)));
  const maxX = Math.max(...sel.map((f) => num(f.xMm) + num(f.widthMm)));
  const minY = Math.min(...sel.map((f) => num(f.yMm)));
  const maxY = Math.max(...sel.map((f) => num(f.yMm) + num(f.heightMm)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return frames.map((f) => {
    if (f.id == null || !idSet.has(f.id)) return f;
    const w = num(f.widthMm);
    const h = num(f.heightMm);
    switch (edge) {
      case 'left':
        return { ...f, xMm: round2(minX) };
      case 'right':
        return { ...f, xMm: round2(maxX - w) };
      case 'centerH':
        return { ...f, xMm: round2(cx - w / 2) };
      case 'top':
        return { ...f, yMm: round2(minY) };
      case 'bottom':
        return { ...f, yMm: round2(maxY - h) };
      case 'middleV':
        return { ...f, yMm: round2(cy - h / 2) };
      default:
        return f;
    }
  });
}

/**
 * Move the selected frames (matched by `id`) by a delta in mm, clamping each
 * frame's printable rectangle inside the canvas so it can't leave the page.
 * Non-selected frames are returned unchanged.
 */
export function nudgeFrames<T extends AlignFrame>(
  frames: T[],
  ids: string[],
  dxMm: number,
  dyMm: number,
  canvasWmm: number,
  canvasHmm: number,
): T[] {
  const idSet = new Set(ids);
  return frames.map((f) => {
    if (f.id == null || !idSet.has(f.id)) return f;
    const w = num(f.widthMm);
    const h = num(f.heightMm);
    const maxX = Math.max(0, canvasWmm - w);
    const maxY = Math.max(0, canvasHmm - h);
    const x = Math.min(Math.max(num(f.xMm) + dxMm, 0), maxX);
    const y = Math.min(Math.max(num(f.yMm) + dyMm, 0), maxY);
    return { ...f, xMm: round2(x), yMm: round2(y) };
  });
}
