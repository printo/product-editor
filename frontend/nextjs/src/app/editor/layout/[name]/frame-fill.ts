import { FabricImage, Rect, Textbox } from 'fabric';
import type { FabricObject } from 'fabric';
import { getFrameFillBehavior } from './frame-display';
import { resolveCaptionBox, hasCaptionPlacement, type CaptionBoxOverrides } from '@/lib/caption-layout';

/**
 * Single source of truth for the "fill sides" background and per-frame caption,
 * shared by BOTH the interactive editor (FabricEditor.tsx) and the off-screen
 * thumbnail/preview renderer (fabric-renderer.ts). Keeping the drawing here is
 * what stops the two renderers from drifting apart — the exact bug that made
 * the blur show in the print/thumbnail but not in the live editor.
 *
 * Coordinates are whatever space the caller works in (fx/fy/fw/fh/fr already
 * resolved to that space); the helper is space-agnostic.
 */

export interface FrameFillState {
  fitMode: 'contain' | 'cover';
  fillStyle?: 'blur' | 'border';
  caption?: string;
  captionEnabled?: boolean;
  rotation?: number;
}

export interface FrameGeom {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  fr: number;
}

/**
 * Build the fill object that sits BEHIND a contain-mode frame photo, filling the
 * whitespace a contained photo leaves. Returns null when no fill applies (cover
 * mode, no style chosen, or the photo already fills the frame).
 *
 *  - 'border' → a solid paper-colour rounded rect
 *  - 'blur'   → the photo stretched to the frame and Gaussian-blurred
 */
export function buildFrameFill(
  fs: FrameFillState,
  geom: FrameGeom,
  imgW: number,
  imgH: number,
  imageEl: CanvasImageSource | null,
  paperColor: string | undefined,
): FabricObject | null {
  if (fs.fitMode !== 'contain' || !fs.fillStyle) return null;
  const { enabled, style } = getFrameFillBehavior(
    { fitMode: fs.fitMode, fillStyle: fs.fillStyle }, imgW, imgH, geom.fw, geom.fh,
  );
  if (!enabled) return null;

  const { fx, fy, fw, fh, fr } = geom;

  if (style === 'border') {
    return new Rect({
      left: fx + fw / 2, top: fy + fh / 2, width: fw, height: fh,
      originX: 'center', originY: 'center',
      fill: paperColor || '#ffffff',
      selectable: false, evented: false, rx: fr, ry: fr,
    });
  }

  // 'blur' — draw the photo stretched into a frame-sized off-screen canvas
  // (never attached to the document) and blur it. The blur image carries its
  // OWN frame-shaped clipPath in its own coordinate space.
  if (!imageEl) return null;

  // imageEl is the RAW source element — Fabric applies the sharp photo's
  // `angle` at render time without ever rotating the underlying pixels. Rotate
  // into an intermediate canvas first so the blurred fill matches the same
  // orientation as the rotated photo on top (mirrors engine.py, which rotates
  // before painting the fill — see _paint_frame_fill).
  let blurSource: CanvasImageSource = imageEl;
  const rot = ((fs.rotation || 0) % 360 + 360) % 360;
  if (rot !== 0) {
    const rad = (rot * Math.PI) / 180;
    const sinA = Math.abs(Math.sin(rad));
    const cosA = Math.abs(Math.cos(rad));
    const rotW = Math.max(1, Math.round(imgW * cosA + imgH * sinA));
    const rotH = Math.max(1, Math.round(imgW * sinA + imgH * cosA));
    const rotCanvas = document.createElement('canvas');
    rotCanvas.width = rotW;
    rotCanvas.height = rotH;
    const rotCtx = rotCanvas.getContext('2d');
    if (rotCtx) {
      rotCtx.translate(rotW / 2, rotH / 2);
      rotCtx.rotate(rad);
      rotCtx.drawImage(imageEl, -imgW / 2, -imgH / 2, imgW, imgH);
      blurSource = rotCanvas;
    }
  }

  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = Math.max(1, Math.round(fw));
  blurCanvas.height = Math.max(1, Math.round(fh));
  const ctx = blurCanvas.getContext('2d');
  if (ctx) {
    ctx.filter = 'blur(18px)';
    ctx.drawImage(blurSource, 0, 0, blurCanvas.width, blurCanvas.height);
  }
  return new FabricImage(blurCanvas, {
    left: fx + fw / 2, top: fy + fh / 2,
    originX: 'center', originY: 'center',
    scaleX: fw / Math.max(1, blurCanvas.width),
    scaleY: fh / Math.max(1, blurCanvas.height),
    selectable: false, evented: false,
    clipPath: new Rect({
      left: 0, top: 0, width: blurCanvas.width, height: blurCanvas.height,
      originX: 'center', originY: 'center', rx: fr, ry: fr,
    }),
  });
}

/**
 * Build the caption Textbox that sits ABOVE the frame photo, or null. Callers
 * gate this on the per-template opt-in (`captionsAllowed`) — captions are OFF
 * by default so they never appear on a product they weren't designed for.
 */
export function buildFrameCaption(
  fs: FrameFillState,
  geom: FrameGeom,
  captionsAllowed: boolean,
  overrides?: CaptionBoxOverrides | null,
): FabricObject | null {
  const text = fs.caption?.trim();
  if (!captionsAllowed || !fs.captionEnabled || !text) return null;
  const { fx, fy, fw, fh } = geom;

  // Explicit ops-authored placement (free position anywhere on the page).
  if (hasCaptionPlacement(overrides)) {
    const c = resolveCaptionBox(fx, fy, fw, fh, overrides);
    return new Textbox(text, {
      left: c.x, top: c.y, originX: 'left', originY: 'top',
      fontSize: c.fontPx, fontFamily: 'Inter, Arial, sans-serif',
      fill: c.color, textAlign: c.align, width: c.w,
      editable: false, selectable: false, evented: false, backgroundColor: 'transparent',
    });
  }

  // Legacy bottom-centre placement — unchanged so existing templates render identically.
  return new Textbox(text, {
    left: fx + fw / 2, top: fy + fh - Math.max(24, fh * 0.08),
    originX: 'center', originY: 'center',
    fontSize: Math.max(14, fh * 0.04),
    fontFamily: 'Inter, Arial, sans-serif',
    fill: '#2a2a2a', textAlign: 'center', width: Math.max(80, fw * 0.8),
    editable: false, selectable: false, evented: false, backgroundColor: 'transparent',
  });
}
