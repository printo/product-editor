'use client';

// ─── DPI Metadata Injection ──────────────────────────────────────────────────

/**
 * Modifies a base64 encoded PNG data URL to inject or replace the pHYs chunk
 * to set a specific DPI in the file metadata.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function changeDpiDataUrl(base64Image: string, dpi: number): string {
  if (!base64Image.startsWith('data:image/png;base64,')) return base64Image;
  
  const b64Data = base64Image.substring(22);
  let rawStr;
  try {
    rawStr = atob(b64Data);
  } catch (err) {
    return base64Image;
  }
  
  const len = rawStr.length;
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  
  // Create pHYs chunk data
  const physChunk = new Uint8Array(21);
  let offset = 0;
  // Length (9 bytes data)
  physChunk[offset++] = 0; physChunk[offset++] = 0; physChunk[offset++] = 0; physChunk[offset++] = 9;
  // Type: pHYs
  physChunk[offset++] = 'p'.charCodeAt(0);
  physChunk[offset++] = 'H'.charCodeAt(0);
  physChunk[offset++] = 'Y'.charCodeAt(0);
  physChunk[offset++] = 's'.charCodeAt(0);
  // Pixels per unit X
  physChunk[offset++] = (pixelsPerMeter >>> 24) & 0xff;
  physChunk[offset++] = (pixelsPerMeter >>> 16) & 0xff;
  physChunk[offset++] = (pixelsPerMeter >>> 8) & 0xff;
  physChunk[offset++] = pixelsPerMeter & 0xff;
  // Pixels per unit Y
  physChunk[offset++] = (pixelsPerMeter >>> 24) & 0xff;
  physChunk[offset++] = (pixelsPerMeter >>> 16) & 0xff;
  physChunk[offset++] = (pixelsPerMeter >>> 8) & 0xff;
  physChunk[offset++] = pixelsPerMeter & 0xff;
  // Unit specifier (1 = meters)
  physChunk[offset++] = 1;
  
  // Calculate CRC for pHYs
  let crc = 0xffffffff;
  
  for (let i = 4; i < 17; i++) {
    crc = CRC_TABLE[(crc ^ physChunk[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = crc ^ 0xffffffff;
  
  physChunk[offset++] = (crc >>> 24) & 0xff;
  physChunk[offset++] = (crc >>> 16) & 0xff;
  physChunk[offset++] = (crc >>> 8) & 0xff;
  physChunk[offset++] = crc & 0xff;
  
  const physStr = String.fromCharCode.apply(null, Array.from(physChunk));
  
  // Find where to inject (after IHDR chunk)
  // PNG signature is 8 bytes, IHDR chunk is length (4) + type (4) + data (13) + crc (4) = 25 bytes
  // So IHDR ends at byte 8 + 25 = 33
  
  let newRawStr = rawStr;
  
  // Check if pHYs already exists, and replace it if so
  const physIndex = rawStr.indexOf('pHYs');
  if (physIndex > 0) {
    const pre = rawStr.substring(0, physIndex - 4); // Include 4 bytes size
    const post = rawStr.substring(physIndex + 17); // Type(4) + Data(9) + CRC(4) = 17
    newRawStr = pre + physStr + post;
  } else {
    const pre = rawStr.substring(0, 33);
    const post = rawStr.substring(33);
    newRawStr = pre + physStr + post;
  }
  
  return 'data:image/png;base64,' + btoa(newRawStr);
}

import {
  Canvas, Rect, Circle, Ellipse, Triangle, Polygon, Path,
  FabricText, Line, type FabricObject,
} from 'fabric';
import { getShapePath, getShapeDef } from '@/lib/shape-catalog';

// ─── Unit conversion ─────────────────────────────────────────────────────────

export function mmToPx(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * 25.4;
}

// ─── Canvas lifecycle ────────────────────────────────────────────────────────

export interface InitCanvasOptions {
  backgroundColor?: string;
  selection?: boolean;
}

export function initFabricCanvas(
  canvasEl: HTMLCanvasElement,
  width: number,
  height: number,
  options: InitCanvasOptions = {},
): Canvas {
  const canvas = new Canvas(canvasEl, {
    width,
    height,
    backgroundColor: options.backgroundColor ?? '#ffffff',
    selection: options.selection ?? true,
    // preserveObjectStacking defaults to true in Fabric 7
  });
  return canvas;
}

export function disposeFabricCanvas(canvas: Canvas | null) {
  if (!canvas) return;
  canvas.dispose();
}

// ─── Frame rectangles ────────────────────────────────────────────────────────

export interface FrameRectOptions {
  label?: string;
  fill?: string;
  stroke?: string;
  strokeDashArray?: number[];
  selectable?: boolean;
  hasControls?: boolean;
  rx?: number;
  ry?: number;
}

export function createFrameRect(
  x: number,
  y: number,
  w: number,
  h: number,
  options: FrameRectOptions = {},
): Rect {
  const rect = new Rect({
    left: x,
    top: y,
    width: w,
    height: h,
    originX: 'left',
    originY: 'top',
    fill: options.fill ?? 'rgba(16, 185, 129, 0.08)',
    stroke: options.stroke ?? '#10b981',
    strokeWidth: 1,
    strokeDashArray: options.strokeDashArray ?? [4, 3],
    selectable: options.selectable ?? true,
    hasControls: options.hasControls ?? true,
    lockRotation: true,
    cornerColor: '#6366f1',
    cornerSize: 8,
    cornerStyle: 'circle',
    transparentCorners: false,
    borderColor: '#6366f1',
    borderDashArray: [3, 3],
    rx: options.rx ?? 0,
    ry: options.ry ?? 0,
  });
  return rect;
}

export function createBleedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number = 0,
): Rect {
  return new Rect({
    left: x,
    top: y,
    width: w,
    height: h,
    originX: 'left',
    originY: 'top',
    fill: 'transparent',
    stroke: '#f43f5e',
    strokeWidth: 1,
    strokeDashArray: [3, 3],
    selectable: false,
    evented: false,
    opacity: 0.6,
    rx,
    ry: rx,
  });
}

// ─── Label text ──────────────────────────────────────────────────────────────

export function createFrameLabel(
  text: string,
  x: number,
  y: number,
): FabricText {
  return new FabricText(text, {
    left: x + 3,
    top: y + 2,
    originX: 'left',
    originY: 'top',
    fontSize: 10,
    fontWeight: 'bold',
    fontFamily: 'sans-serif',
    fill: '#ffffff',
    backgroundColor: '#10b981',
    padding: 2,
    selectable: false,
    evented: false,
  });
}

// ─── Snap to grid ────────────────────────────────────────────────────────────

export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

export function applySnapToGrid(
  target: FabricObject,
  gridSize: number,
) {
  const left = target.left ?? 0;
  const top = target.top ?? 0;
  target.set({
    left: snapToGrid(left, gridSize),
    top: snapToGrid(top, gridSize),
  });
}

// ─── Aligning Guidelines (via fabric-guideline-plugin) ──────────────────────
//
// Uses the community-maintained plugin for visual snap guides (like Canva/Figma).
// Handles edge alignment, center alignment, and visual feedback lines.
// See: https://github.com/caijinyc/fabric-guideline-plugin

// @ts-ignore - plugin lacks type definitions
// import { AlignGuidelines } from 'fabric-guideline-plugin';

export interface AligningGuidelinesOptions {
  lineColor?: string;
  lineWidth?: number;
  /** Snap distance in pixels */
  lineMargin?: number;
}

/**
 * Initialize aligning guidelines on a Fabric canvas.
 * Call once after canvas creation. Returns the AlignGuidelines instance
 * (currently the plugin has no destroy method, but the instance is returned
 * in case a future version adds one).
 */
export function initAligningGuidelines(
  canvas: Canvas,
  options: AligningGuidelinesOptions = {},
): any {
  // Plugin is incompatible with Fabric v7
  // const guideline = new AlignGuidelines({ ... });
  // guideline.init();
  return null;
}

// ─── Center guidelines ──────────────────────────────────────────────────────

export function createCenterGuides(
  canvasWidth: number,
  canvasHeight: number,
): Line[] {
  const opts = {
    stroke: '#64748b',
    strokeWidth: 0.8,
    strokeDashArray: [6, 4] as number[],
    strokeUniform: true,
    originX: 'left' as const,
    originY: 'top' as const,
    selectable: false,
    evented: false,
    opacity: 0.6,
  };
  const hLine = new Line(
    [0, canvasHeight / 2, canvasWidth, canvasHeight / 2],
    opts,
  );
  const vLine = new Line(
    [canvasWidth / 2, 0, canvasWidth / 2, canvasHeight],
    opts,
  );
  return [hLine, vLine];
}

// ─── Grid lines ──────────────────────────────────────────────────────────────

export function createGridLines(
  canvasWidth: number,
  canvasHeight: number,
  gridSize: number,
): Line[] {
  const lines: Line[] = [];
  const opts = {
    stroke: '#cbd5e1',
    strokeWidth: 0.5,
    strokeUniform: true,
    originX: 'left' as const,
    originY: 'top' as const,
    selectable: false,
    evented: false,
    opacity: 1.0,
  };
  for (let x = gridSize; x < canvasWidth; x += gridSize) {
    lines.push(new Line([x, 0, x, canvasHeight], opts));
  }
  for (let y = gridSize; y < canvasHeight; y += gridSize) {
    lines.push(new Line([0, y, canvasWidth, y], opts));
  }
  return lines;
}

// ─── Constrain object within canvas bounds ───────────────────────────────────

export function constrainToCanvas(
  target: FabricObject,
  canvasWidth: number,
  canvasHeight: number,
) {
  const left = target.left ?? 0;
  const top = target.top ?? 0;
  const w = (target.width ?? 0) * (target.scaleX ?? 1);
  const h = (target.height ?? 0) * (target.scaleY ?? 1);
  target.set({
    left: Math.max(0, Math.min(left, canvasWidth - w)),
    top: Math.max(0, Math.min(top, canvasHeight - h)),
  });
}

// ─── Relative ClipPath Math ──────────────────────────────────────────────────

/**
 * Updates a clipPath's properties dynamically so it stays fixed in the workspace
 * coordinate system, regardless of how the clipped image translates, rotates, or scales.
 */
export function updateRelativeClipPath(
  img: FabricObject,
  clipWorldX: number,
  clipWorldY: number,
  clipWorldWidth: number,
  clipWorldHeight: number,
) {
  if (!img.clipPath) return;
  const rad = (img.angle || 0) * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const clipCenterX = clipWorldX + clipWorldWidth / 2;
  const clipCenterY = clipWorldY + clipWorldHeight / 2;
  const dx = clipCenterX - (img.left || 0);
  const dy = clipCenterY - (img.top || 0);

  const dxLocal = dx * cos + dy * sin;
  const dyLocal = -dx * sin + dy * cos;

  const scaleX = img.scaleX || 1;
  const scaleY = img.scaleY || 1;

  img.clipPath.set({
    left: dxLocal / scaleX,
    top: dyLocal / scaleY,
    width: clipWorldWidth / scaleX,
    height: clipWorldHeight / scaleY,
    angle: -(img.angle || 0),
    originX: 'center',
    originY: 'center',
  });
}

// ─── Shared shape overlay factory ──────────────────────────────────────────

export interface ShapeOverlayInput {
  shapeType: string;
  svgPath?: string;
  x: number;       // percentage 0–100
  y: number;
  width: number;    // percentage 0–100
  height: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/**
 * Creates a Fabric shape object from normalized overlay data.
 * Shared by FabricEditor (interactive) and fabric-renderer (export).
 *
 * @param overlay  Shape overlay with percentage-based coordinates
 * @param canvasW  Canvas width in pixels
 * @param canvasH  Canvas height in pixels
 * @param extras   Additional Fabric options (e.g. selectable, cornerColor)
 */
export function createShapeFromOverlay(
  overlay: ShapeOverlayInput,
  canvasW: number,
  canvasH: number,
  extras: Record<string, any> = {},
): FabricObject | null {
  const sx = (overlay.x / 100) * canvasW;
  const sy = (overlay.y / 100) * canvasH;
  const sw = (overlay.width / 100) * canvasW;
  const sh = (overlay.height / 100) * canvasH;

  const commonOpts: Record<string, any> = {
    fill: overlay.fill || 'transparent',
    stroke: overlay.strokeWidth > 0 ? (overlay.stroke || '#000000') : undefined,
    strokeWidth: overlay.strokeWidth > 0 ? overlay.strokeWidth : 0,
    opacity: overlay.opacity ?? 1,
    angle: overlay.rotation || 0,
    ...extras,
  };

  const def = getShapeDef(overlay.shapeType);

  if (def?.fabricType === 'rect') {
    const isRounded = overlay.shapeType === 'rounded-rect';
    return new Rect({
      left: sx, top: sy, width: sw, height: sh,
      originX: 'left', originY: 'top',
      rx: isRounded ? Math.min(sw, sh) * 0.15 : 0,
      ry: isRounded ? Math.min(sw, sh) * 0.15 : 0,
      ...commonOpts,
    });
  } else if (def?.fabricType === 'circle') {
    const radius = Math.min(sw, sh) / 2;
    return new Circle({
      left: sx + sw / 2, top: sy + sh / 2, radius,
      originX: 'center', originY: 'center',
      ...commonOpts,
    });
  } else if (def?.fabricType === 'ellipse') {
    return new Ellipse({
      left: sx + sw / 2, top: sy + sh / 2,
      rx: sw / 2, ry: sh / 2,
      originX: 'center', originY: 'center',
      ...commonOpts,
    });
  } else if (def?.fabricType === 'triangle') {
    return new Triangle({
      left: sx, top: sy, width: sw, height: sh,
      originX: 'left', originY: 'top',
      ...commonOpts,
    });
  } else if (def?.fabricType === 'polygon' && def.polygonPoints) {
    const points = def.polygonPoints.map(p => ({
      x: (p.x / 100) * sw,
      y: (p.y / 100) * sh,
    }));
    return new Polygon(points, {
      left: sx, top: sy,
      originX: 'left', originY: 'top',
      ...commonOpts,
    });
  } else {
    const pathStr = getShapePath(overlay.shapeType, overlay.svgPath);
    return new Path(pathStr, {
      left: sx, top: sy,
      originX: 'left', originY: 'top',
      scaleX: sw / 100, scaleY: sh / 100,
      ...commonOpts,
    });
  }
}

// ─── Viewport centering helper ─────────────────────────────────────────────

/**
 * Calculate and apply a centered viewport transform on a Fabric canvas.
 * Replaces scattered manual viewportTransform array mutations.
 */
export function centerCanvasViewport(
  fc: Canvas,
  containerWidth: number,
  containerHeight: number,
  canvasW: number,
  canvasH: number,
  zoomMultiplier: number = 1,
  padding: number = 40,
): number {
  if (containerWidth === 0 || containerHeight === 0) return 1;
  const fitZoom = Math.min(
    (containerWidth - padding * 2) / canvasW,
    (containerHeight - padding * 2) / canvasH,
  );
  const targetZoom = fitZoom * zoomMultiplier;
  const vpt = fc.viewportTransform.slice();
  vpt[0] = targetZoom;
  vpt[3] = targetZoom;
  vpt[4] = (containerWidth / 2) - (canvasW * targetZoom / 2);
  vpt[5] = (containerHeight / 2) - (canvasH * targetZoom / 2);
  fc.setViewportTransform(vpt as any);
  return fitZoom;
}
