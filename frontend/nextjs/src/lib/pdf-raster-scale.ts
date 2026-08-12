/**
 * Pure scale/dimension math for rasterizing PDF pages to images. No DOM or
 * pdf.js dependency — mirrors dpi-utils.ts being pure math while
 * fabric-renderer.ts/pdf-import.ts do the actual rendering.
 *
 * A PDF page's size is in points (1/72 inch). scale = targetDpi / 72
 * converts that to a pixels-per-point multiplier for pdf.js's viewport API.
 */

export const POINTS_PER_INCH = 72;

/**
 * Full-resolution rasterization target. Deliberately not this app's own
 * DPI_TARGET (300, in dpi-utils.ts) — a rasterized page flows through that
 * exact same low-DPI warning system once placed in a frame, which depends on
 * the frame it lands in, not the PDF's own resolution. 200 sits comfortably
 * above DPI_WARN (150).
 */
export const PDF_RASTER_DPI = 200;

/** Safety cap on the longer output side, well under the backend's hard
 *  16384px reject ceiling (validators.py MAX_IMAGE_DIMENSION_PX, which
 *  rejects rather than downscales). Protects against a poster-sized page. */
export const PDF_MAX_OUTPUT_DIMENSION_PX = 6000;

/** Longer-edge target for the picker grid's thumbnails — small and fast on
 *  purpose, since this pass runs for every page up front and (per the
 *  main-thread-only decision) briefly holds the UI thread while it does. */
export const PDF_THUMBNAIL_TARGET_LONG_EDGE_PX = 240;

/** Hard cap on pages considered at all. Without a worker, opening a very
 *  large PDF means a long series of main-thread pauses generating
 *  thumbnails — this bounds the worst case with a clear message instead of
 *  silently churning through hundreds of pages. */
export const PDF_MAX_PAGES = 100;

export interface RasterScaleResult {
  scale: number;
  outputWidthPx: number;
  outputHeightPx: number;
}

/**
 * Scale for the full-resolution rasterization pass, clamped so neither
 * output dimension exceeds maxDimensionPx (aspect ratio preserved).
 * Returns all-zero for a degenerate (zero/negative) page size — a caller
 * that tries to render at scale 0 gets an obviously-empty result rather
 * than a silently-wrong one.
 */
export function computeRasterScale(
  pageWidthPt: number,
  pageHeightPt: number,
  targetDpi: number,
  maxDimensionPx: number,
): RasterScaleResult {
  if (!pageWidthPt || !pageHeightPt || pageWidthPt <= 0 || pageHeightPt <= 0) {
    return { scale: 0, outputWidthPx: 0, outputHeightPx: 0 };
  }

  let scale = targetDpi / POINTS_PER_INCH;
  let outputWidthPx = pageWidthPt * scale;
  let outputHeightPx = pageHeightPt * scale;

  const longerSidePx = Math.max(outputWidthPx, outputHeightPx);
  if (longerSidePx > maxDimensionPx) {
    const clamp = maxDimensionPx / longerSidePx;
    scale *= clamp;
    outputWidthPx *= clamp;
    outputHeightPx *= clamp;
  }

  return { scale, outputWidthPx, outputHeightPx };
}

/**
 * Scale for the picker's thumbnail pass, targeting the LONGER edge (not
 * always width) so portrait and landscape pages both render at a
 * consistent, appropriately-sized thumbnail rather than one orientation
 * coming out too small or too large relative to the other.
 */
export function computeThumbnailScale(
  pageWidthPt: number,
  pageHeightPt: number,
  targetLongEdgePx: number,
): number {
  if (!pageWidthPt || !pageHeightPt || pageWidthPt <= 0 || pageHeightPt <= 0) return 0;
  return targetLongEdgePx / Math.max(pageWidthPt, pageHeightPt);
}
