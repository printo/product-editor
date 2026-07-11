/**
 * Effective print-DPI estimation for the low-resolution warning
 * (Phase 2 item 4 — warn before submit, never block).
 *
 * The math REPLICATES the placement pipeline exactly:
 *   - client preview/export: fabric-renderer.ts (rotated bbox → cover/contain
 *     baseScale → × FrameState.scale)
 *   - server print: layout_engine/engine.py _composite_canvas (same formula)
 * If either changes, update this module or the estimate silently diverges.
 *
 * effective DPI = layout px-per-inch ÷ finalScale
 * (finalScale > 1 means source pixels are being stretched → fewer real
 * pixels per printed inch).
 */

export const DPI_TARGET = 300;
/** Below this the print may look soft (2× linear upscale from source). */
export const DPI_WARN = 150;
/** Below this the print is unmistakably pixelated (3×+ upscale). */
export const DPI_CRITICAL = 100;

export interface LowDpiFrame {
  canvasIdx: number;
  frameIdx: number;
  surfaceKey: string | null;
  surfaceLabel?: string;
  dpi: number;
  severity: 'warn' | 'critical';
}

/**
 * Pixels-per-inch of a layout canvas. Mirrors engine.py: px/mm from
 * widthMm when present, else the declared dpi, else the 300 default
 * (every shipped layout is authored at exactly 300).
 */
export function pxPerInchForLayout(canvas: {
  width?: number; widthMm?: number; dpi?: number;
} | undefined | null): number {
  if (!canvas) return DPI_TARGET;
  if (canvas.width && canvas.widthMm) {
    return canvas.width / (canvas.widthMm / 25.4);
  }
  return canvas.dpi || DPI_TARGET;
}

export function computeEffectiveDpi(args: {
  imgW: number;
  imgH: number;
  frameWpx: number;
  frameHpx: number;
  pxPerInch: number;
  rotation: number;
  scale: number;
  fitMode: 'cover' | 'contain';
}): number {
  const { imgW, imgH, frameWpx, frameHpx, pxPerInch, rotation, scale, fitMode } = args;
  if (!imgW || !imgH || !frameWpx || !frameHpx) return DPI_TARGET;

  const rad = (rotation * Math.PI) / 180;
  const sinA = Math.abs(Math.sin(rad));
  const cosA = Math.abs(Math.cos(rad));
  const effW = imgW * cosA + imgH * sinA;
  const effH = imgW * sinA + imgH * cosA;

  const baseScale = fitMode === 'cover'
    ? Math.max(frameWpx / effW, frameHpx / effH)
    : Math.min(frameWpx / effW, frameHpx / effH);
  const finalScale = baseScale * (scale || 1);
  if (!isFinite(finalScale) || finalScale <= 0) return DPI_TARGET;

  return pxPerInch / finalScale;
}

/** Frame pixel dimensions from a layout frame spec (fraction or absolute). */
export function frameSizePx(
  frameSpec: { width?: number; height?: number } | undefined,
  canvasW: number,
  canvasH: number,
): { w: number; h: number } {
  if (!frameSpec) return { w: canvasW, h: canvasH };
  const isPercent = (frameSpec.width ?? 1) <= 1 && (frameSpec.height ?? 1) <= 1;
  return {
    w: isPercent ? (frameSpec.width ?? 1) * canvasW : (frameSpec.width ?? canvasW),
    h: isPercent ? (frameSpec.height ?? 1) * canvasH : (frameSpec.height ?? canvasH),
  };
}

interface FrameLike {
  originalFile: File | null;
  scale: number;
  rotation: number;
  fitMode: 'cover' | 'contain';
}

interface CanvasGroup {
  canvases: ReadonlyArray<{ frames: ReadonlyArray<FrameLike> }>;
  layoutDef: {
    canvas?: { width?: number; height?: number; widthMm?: number; dpi?: number };
    frames?: Array<{ width?: number; height?: number }>;
  } | null | undefined;
  surfaceKey?: string | null;
  surfaceLabel?: string;
}

/**
 * Sweep every placed photo and return the under-DPI ones. Frames without a
 * recovered File are skipped — the lost-photo submit guard owns those.
 * `getSize` is injected (image-utils.getImageSize) so this module stays pure
 * and unit-testable without the DOM.
 */
export async function collectLowDpiFrames(
  groups: ReadonlyArray<CanvasGroup>,
  getSize: (file: File) => Promise<{ width: number; height: number }>,
): Promise<LowDpiFrame[]> {
  const out: LowDpiFrame[] = [];
  for (const group of groups) {
    const canvasW = group.layoutDef?.canvas?.width || 0;
    const canvasH = group.layoutDef?.canvas?.height || 0;
    if (!canvasW || !canvasH) continue;
    const pxPerInch = pxPerInchForLayout(group.layoutDef?.canvas);

    for (let canvasIdx = 0; canvasIdx < group.canvases.length; canvasIdx++) {
      const frames = group.canvases[canvasIdx]?.frames || [];
      for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
        const frame = frames[frameIdx];
        if (!frame?.originalFile) continue;

        let size: { width: number; height: number };
        try {
          size = await getSize(frame.originalFile);
        } catch {
          continue; // undecodable file → other guards own the messaging
        }

        const { w, h } = frameSizePx(group.layoutDef?.frames?.[frameIdx], canvasW, canvasH);
        const dpi = computeEffectiveDpi({
          imgW: size.width,
          imgH: size.height,
          frameWpx: w,
          frameHpx: h,
          pxPerInch,
          rotation: frame.rotation || 0,
          scale: frame.scale || 1,
          fitMode: frame.fitMode === 'contain' ? 'contain' : 'cover',
        });

        // Strict <: exactly 150 DPI does not warn.
        if (dpi < DPI_WARN) {
          out.push({
            canvasIdx,
            frameIdx,
            surfaceKey: group.surfaceKey ?? null,
            surfaceLabel: group.surfaceLabel,
            dpi,
            severity: dpi < DPI_CRITICAL ? 'critical' : 'warn',
          });
        }
      }
    }
  }
  return out;
}
