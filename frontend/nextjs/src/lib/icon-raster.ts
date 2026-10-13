/**
 * Icons from the editor's Icons tab are Iconify SVG URLs. The preview draws
 * them straight from that URL, but the print can't: the server opens image
 * overlays only from uploaded files (it never fetches a remote URL) and
 * Pillow can't read SVG. So at submit each one is drawn to a PNG here, at
 * the size it will print, and uploaded with the photos like a sticker.
 */

/** Below this the server refuses the upload (`MIN_IMAGE_DIMENSION`, 50 px). */
export const MIN_RASTER_PX = 64;
/** Largest canvas iOS Safari will draw (16.7 M px = 4096²). */
export const MAX_RASTER_PX = 4096;
/** Used when the print canvas size isn't known. */
const UNKNOWN_CANVAS_RASTER_PX = 1024;

/** An image overlay the print can't resolve on its own: not the customer's
 *  file, nothing uploaded, only a remote URL. */
export function needsRasterForPrint(ov: { source?: string; src?: string; originalFile?: unknown }): boolean {
  return ov.source !== 'local' && !ov.originalFile && /^https?:\/\//i.test(ov.src ?? '');
}

/**
 * Pixel size to draw an overlay at: its share of the print canvas, rounded
 * as `overlay_renderer._paste_image` rounds it. Each side is clamped on its
 * own — the print stretches the image to the overlay's box anyway, as both
 * previews do, so the PNG's shape only decides how sharp it is.
 */
export function overlayRasterSize(
  overlay: { width: number; height: number },
  canvas: { width: number; height: number } | null | undefined,
): { width: number; height: number } {
  const side = (pct: number, canvasPx: number | undefined) => {
    const px = canvasPx ? Math.trunc((pct * canvasPx) / 100) : UNKNOWN_CANVAS_RASTER_PX;
    return Math.min(MAX_RASTER_PX, Math.max(MIN_RASTER_PX, px || 0));
  };
  return { width: side(overlay.width, canvas?.width), height: side(overlay.height, canvas?.height) };
}

/**
 * The SVG with an explicit pixel size and `preserveAspectRatio="none"`, so it
 * draws sharp at that size and fills it edge to edge — the same stretch the
 * previews apply when they scale the image to the overlay's box. Iconify
 * sizes its SVGs in `em`, which not every browser will draw to a canvas.
 */
export function svgForRaster(svgText: string, width: number, height: number): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.localName !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Not an SVG image');
  }
  if (!svg.getAttribute('viewBox')) {
    // Without a viewBox, resizing the viewport would crop the drawing
    // instead of scaling it. Unitless or px sizes give us one.
    const w = parseFloat(svg.getAttribute('width') ?? '');
    const h = parseFloat(svg.getAttribute('height') ?? '');
    const plain = (v: string | null) => v != null && /^\s*[\d.]+(px)?\s*$/.test(v);
    if (w > 0 && h > 0 && plain(svg.getAttribute('width')) && plain(svg.getAttribute('height'))) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
  }
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('preserveAspectRatio', 'none');
  return new XMLSerializer().serializeToString(doc);
}

/** A file name the upload accepts, from an overlay label like `logos:facebook`. */
export function rasterFileName(label: string | undefined): string {
  const base = (label ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `icon-${base || 'image'}.png`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The icon could not be drawn'));
    img.src = url;
  });
}

/** Fetch an icon (SVG) or a template sticker (PNG, by content type) and draw
 *  it to a PNG File of exactly `width` × `height`. */
export async function rasterizeSvgUrl(
  url: string,
  width: number,
  height: number,
  fileName: string,
): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The icon could not be downloaded (${res.status})`);
  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
  const isRaster = /^image\/(png|jpe?g|webp|gif)/.test(contentType);
  const svgUrl = isRaster
    ? URL.createObjectURL(await res.blob())
    : URL.createObjectURL(new Blob([svgForRaster(await res.text(), width, height)], { type: 'image/svg+xml' }));
  // Off-screen, never attached to the page.
  const canvas = document.createElement('canvas');
  try {
    const img = await loadImage(svgUrl);
    // Safari can report an SVG loaded before it will draw; decode() waits.
    await img.decode?.().catch(() => undefined);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not prepare a canvas for the icon');
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The icon could not be converted to PNG');
    return new File([blob], fileName, { type: 'image/png', lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(svgUrl);
    // Release the pixels now; iOS caps the total canvas memory per page.
    canvas.width = 0;
    canvas.height = 0;
  }
}
