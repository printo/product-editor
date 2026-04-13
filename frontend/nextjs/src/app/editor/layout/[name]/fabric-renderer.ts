import { Canvas, Rect, FabricImage, Textbox, FabricText, Path, Shadow } from 'fabric';
import type { CanvasItem } from './types';
import { createShapeFromOverlay, updateRelativeClipPath, changeDpiDataUrl } from '@/lib/fabric-utils';

let picaInstance: any = null;

/**
 * Resizes an image using Pica for high quality.
 */
async function resizeImageWithPica(img: HTMLImageElement, width: number, height: number): Promise<HTMLCanvasElement> {
  if (!picaInstance) {
    const pica = (await import('pica')).default;
    picaInstance = pica();
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  await picaInstance.resize(img, canvas, {
    unsharpAmount: 80,
    unsharpRadius: 0.6,
    unsharpThreshold: 2
  });
  return canvas;
}

/**
 * Gets the best crop for an image using smartcrop.js.
 */
export async function getSmartCrop(img: HTMLImageElement | HTMLCanvasElement, width: number, height: number) {
  try {
    const smartcrop = (await import('smartcrop')).default;
    const result = await smartcrop.crop(img, { width, height });
    return result.topCrop;
  } catch {
    return null;
  }
}

/**
 * Calculates the offset required to center the best crop area in the frame.
 */
export async function calculateSmartCropOffsets(
  img: HTMLImageElement | HTMLCanvasElement,
  frameW: number,
  frameH: number,
  rotation: number = 0,
): Promise<{ x: number; y: number }> {
  const imgW = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const imgH = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  
  const crop = await getSmartCrop(img, frameW, frameH);
  if (!crop) return { x: 0, y: 0 };

  const cropCenterX = crop.x + crop.width / 2;
  const cropCenterY = crop.y + crop.height / 2;
  
  const localDX = cropCenterX - imgW / 2;
  const localDY = cropCenterY - imgH / 2;

  const rad = (rotation * Math.PI) / 180;
  const canvasDX = localDX * Math.cos(rad) - localDY * Math.sin(rad);
  const canvasDY = localDX * Math.sin(rad) + localDY * Math.cos(rad);

  return { x: -canvasDX, y: -canvasDY };
}

// ─── Fabric-based canvas rendering ───────────────────────────────────────────

export interface RenderCanvasOptions {
  excludeFrameIdx?: number | null;
  isExport?: boolean;
  includeMask?: boolean;
  layoutOverride?: any;
  thumbnail?: boolean; // New option for low-res previews
}

export async function renderCanvas(
  canvasItem: CanvasItem,
  layoutDef: any,
  getFileUrlFn: (file: File) => string,
  options: RenderCanvasOptions = {},
): Promise<string> {
  const { excludeFrameIdx = null, isExport = false, includeMask = true, layoutOverride, thumbnail = false } = options;
  const usedLayout = layoutOverride || layoutDef;
  if (!usedLayout) return '';

  // Auto-detect resolution based on screen DPI for sharpness.
  // We use devicePixelRatio to ensure Retina/High-DPI screens stay sharp.
  // For high-volume batches, we still cap it to avoid memory exhaustion.
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  const thumbnailMultiplier = Math.min(dpr * 0.25, 0.75); // Range: 0.25x (Standard) to 0.75x (Retina)
  const multiplier = thumbnail ? thumbnailMultiplier : 1;
  const canvasW = Math.round((usedLayout.canvas?.width || usedLayout.surfaces?.[0]?.canvas?.width || 1200) * multiplier);
  const canvasH = Math.round((usedLayout.canvas?.height || usedLayout.surfaces?.[0]?.canvas?.height || 1800) * multiplier);

  const frames = (usedLayout.canvas?.width ? usedLayout.frames : usedLayout.surfaces?.[0]?.frames) || 
               (usedLayout.frames?.length > 0 ? usedLayout.frames : [{ x: 0, y: 0, width: canvasW / multiplier, height: canvasH / multiplier }]);

  // Create an off-screen Fabric canvas
  const canvasEl = document.createElement('canvas');
  canvasEl.width = canvasW;
  canvasEl.height = canvasH;
  const fabricCanvas = new Canvas(canvasEl, {
    width: canvasW,
    height: canvasH,
    backgroundColor: canvasItem.bgColor || '#ffffff',
    renderOnAddRemove: false, // batch — we render once at the end
  });

  try {
  // ── Frame images ────────────────────────────────────────────────────────────
  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    if (excludeFrameIdx !== null && frameIdx === excludeFrameIdx) continue;
    const frameSpec = frames[frameIdx];
    const frameState = canvasItem.frames[frameIdx];
    if (!frameState) continue;

    const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = (isPercent ? frameSpec.x * (canvasW / multiplier) : frameSpec.x) * multiplier;
      const fy = (isPercent ? frameSpec.y * (canvasH / multiplier) : frameSpec.y) * multiplier;
      const fw = (isPercent ? frameSpec.width * (canvasW / multiplier) : frameSpec.width) * multiplier;
      const fh = (isPercent ? frameSpec.height * (canvasH / multiplier) : frameSpec.height) * multiplier;
      const pxPerMm = (canvasW / multiplier) / (usedLayout.canvas?.widthMm || 1);
      const fr = Math.min(fw / 2, fh / 2, Number(frameSpec.borderRadiusMm || 0) * pxPerMm * multiplier);

      const file = frameState.originalFile;
      if (!file) continue;
      const imgSource = getFileUrlFn(file);

      try {
        const fabricImg = await FabricImage.fromURL(imgSource, { crossOrigin: 'anonymous' });
        let imgW = fabricImg.width!;
        let imgH = fabricImg.height!;

        let rot = frameState.rotation || 0;
        let rad = (rot * Math.PI) / 180;
        let sinA = Math.abs(Math.sin(rad));
        let cosA = Math.abs(Math.cos(rad));
        let effW = imgW * cosA + imgH * sinA;
        let effH = imgW * sinA + imgH * cosA;

        let baseScale = frameState.fitMode === 'cover'
          ? Math.max(fw / (effW * multiplier), fh / (effH * multiplier))
          : Math.min(fw / (effW * multiplier), fh / (effH * multiplier));
        let finalScale = baseScale * frameState.scale * multiplier;

        // --- Pica Integration for high quality downscaling on export ---
        if (isExport && finalScale < 0.9) {
          const targetW = imgW * finalScale;
          const targetH = imgH * finalScale;
          // Only resize if it's a significant downscale
          if (targetW > 10 && targetH > 10) {
            const picaCanvas = await resizeImageWithPica(fabricImg.getElement() as HTMLImageElement, targetW, targetH);
            fabricImg.setElement(picaCanvas);
            imgW = picaCanvas.width;
            imgH = picaCanvas.height;
            fabricImg.set({ width: imgW, height: imgH });
            // Since we've resized to final size, the new scale is 1.0
            finalScale = 1.0;
            effW = imgW * cosA + imgH * sinA;
            effH = imgW * sinA + imgH * cosA;
          }
        }

        const w = effW * finalScale;
        const h = effH * finalScale;
        
        const offsetX = frameState.offset.x * multiplier;
        const offsetY = frameState.offset.y * multiplier;

        const x = fx + (fw - w) / 2 + offsetX;
        const y = fy + (fh - h) / 2 + offsetY;

        // Clip to frame region using relative clipPath
        const clipRect = new Rect({
          left: 0, top: 0, width: fw, height: fh,
          originX: 'center', originY: 'center',
          rx: fr, ry: fr,
        });

      fabricImg.set({
        left: x + w / 2,
        top: y + h / 2,
        originX: 'center',
        originY: 'center',
        scaleX: finalScale,
        scaleY: finalScale,
        angle: rot,
        clipPath: clipRect,
        selectable: false,
        evented: false,
      });
      updateRelativeClipPath(fabricImg, fx, fy, fw, fh);

      fabricCanvas.add(fabricImg);
    } catch {
      // Skip frames with failed images
    }
  }

  // ── Paper Overlay Mask (Hole-punching) — matches FabricEditor logic ─────────
  // A white paper layer rendered ABOVE the images, with transparent holes cut out 
  // for each frame using SVG `evenodd` fill rule.
  let paperPathStr = `M 0 0 L ${canvasW} 0 L ${canvasW} ${canvasH} L 0 ${canvasH} Z`;
  frames.forEach((frameSpec: any) => {
    const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
    const fx = (isPercent ? frameSpec.x * (canvasW / multiplier) : frameSpec.x) * multiplier;
    const fy = (isPercent ? frameSpec.y * (canvasH / multiplier) : frameSpec.y) * multiplier;
    const fw = (isPercent ? frameSpec.width * (canvasW / multiplier) : frameSpec.width) * multiplier;
    const fh = (isPercent ? frameSpec.height * (canvasH / multiplier) : frameSpec.height) * multiplier;
    const pxPerMm = (canvasW / multiplier) / (usedLayout.canvas?.widthMm || 1);
    const fr = Math.min(fw / 2, fh / 2, Number(frameSpec.borderRadiusMm || 0) * pxPerMm * multiplier);

    if (fr > 0) {
      // Counter-clockwise rounded rectangular hole (A command for arcs)
      paperPathStr += ` M ${fx + fr} ${fy} A ${fr} ${fr} 0 0 0 ${fx} ${fy + fr} L ${fx} ${fy + fh - fr} A ${fr} ${fr} 0 0 0 ${fx + fr} ${fy + fh} L ${fx + fw - fr} ${fy + fh} A ${fr} ${fr} 0 0 0 ${fx + fw} ${fy + fh - fr} L ${fx + fw} ${fy + fr} A ${fr} ${fr} 0 0 0 ${fx + fw - fr} ${fy} Z`;
    } else {
      // Counter-clockwise rectangular hole
      paperPathStr += ` M ${fx} ${fy} L ${fx} ${fy + fh} L ${fx + fw} ${fy + fh} L ${fx + fw} ${fy} Z`;
    }
  });

  const paperOverlay = new Path(paperPathStr, {
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    fill: canvasItem.paperColor || '#ffffff',
    selectable: false,
    evented: false,
    fillRule: 'evenodd',
  });
  fabricCanvas.add(paperOverlay);

  // ── Frame shape outlines — preview only, never exported ───────────────────
  // A thin stroke-only rect drawn on top of the paper mask so users can see
  // the exact shape (circle, rounded rect, etc.) of the final product.
  if (!isExport) {
  const outlineStrokeW = Math.max(2, Math.round(canvasW * 0.0025));
  for (const frameSpec of frames) {
    const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
    const fx = (isPercent ? frameSpec.x * (canvasW / multiplier) : frameSpec.x) * multiplier;
    const fy = (isPercent ? frameSpec.y * (canvasH / multiplier) : frameSpec.y) * multiplier;
    const fw = (isPercent ? frameSpec.width * (canvasW / multiplier) : frameSpec.width) * multiplier;
    const fh = (isPercent ? frameSpec.height * (canvasH / multiplier) : frameSpec.height) * multiplier;
    const pxPerMm = (canvasW / multiplier) / (usedLayout.canvas?.widthMm || 1);
    const fr = Math.min(fw / 2, fh / 2, Number(frameSpec.borderRadiusMm || 0) * pxPerMm * multiplier);
    const outlineRect = new Rect({
      left: fx,
      top: fy,
      width: fw,
      height: fh,
      originX: 'left',
      originY: 'top',
      fill: 'transparent',
      stroke: 'rgba(0,0,0,0.18)',
      strokeWidth: outlineStrokeW,
      rx: fr,
      ry: fr,
      selectable: false,
      evented: false,
    });
    fabricCanvas.add(outlineRect);
  }
  } // end !isExport

  // ── Frame placeholder labels — preview only ─────────────────────────────────
  if (!isExport && frames.length > 1) {
    for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
      if (excludeFrameIdx !== null && frameIdx === excludeFrameIdx) continue;
      const frameSpec = frames[frameIdx];
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = (isPercent ? frameSpec.x * (canvasW / multiplier) : frameSpec.x) * multiplier;
      const fy = (isPercent ? frameSpec.y * (canvasH / multiplier) : frameSpec.y) * multiplier;
      const fw = (isPercent ? frameSpec.width * (canvasW / multiplier) : frameSpec.width) * multiplier;
      const fh = (isPercent ? frameSpec.height * (canvasH / multiplier) : frameSpec.height) * multiplier;
      const labelSize = Math.max(14, Math.min(fw, fh) * 0.08);

      const label = new FabricText(`Frame ${frameIdx + 1}`, {
        left: fx + fw / 2,
        top: fy + fh / 2,
        originX: 'center',
        originY: 'center',
        fontSize: labelSize,
        fontWeight: 'bold',
        fontFamily: 'sans-serif',
        fill: 'rgba(0,0,0,0.15)',
        selectable: false,
        evented: false,
      });
      fabricCanvas.add(label);
    }
  }

  // ── Overlays (Unified) ─────────────────────────────────────────────────────
  if (canvasItem.overlays && canvasItem.overlays.length > 0) {
    if (typeof document !== 'undefined' && document.fonts) {
      await document.fonts.ready;
    }

    for (const o of canvasItem.overlays) {
      try {
        if (o.type === 'text') {
          if (!o.text.trim()) continue;
          const tx = (o.x / 100) * canvasW;
          const ty = (o.y / 100) * canvasH;
          const textObj = new Textbox(o.text, {
            left: tx, top: ty,
            originX: o.textAlign === 'left' ? 'left' : o.textAlign === 'right' ? 'right' : 'center',
            originY: 'center',
            fontSize: o.fontSize * multiplier,
            fontFamily: o.fontFamily || 'sans-serif',
            fill: o.color || '#000000',
            textAlign: (o.textAlign || 'center') as 'left' | 'center' | 'right' | 'justify',
            angle: o.rotation || 0,
            selectable: false, evented: false,
          });
          fabricCanvas.add(textObj);
        } else if (o.type === 'shape') {
          const fabricObj = createShapeFromOverlay(o, canvasW, canvasH, {
            selectable: false, evented: false,
          });
          if (fabricObj) fabricCanvas.add(fabricObj);
        } else if (o.type === 'image') {
          const ix = (o.x / 100) * canvasW;
          const iy = (o.y / 100) * canvasH;
          const iw = (o.width / 100) * canvasW;
          const ih = (o.height / 100) * canvasH;
          const img = await FabricImage.fromURL(o.src, { crossOrigin: 'anonymous' });
          img.set({
            left: ix, top: iy,
            originX: 'left', originY: 'top',
            scaleX: iw / (img.width || 1),
            scaleY: ih / (img.height || 1),
            angle: o.rotation || 0,
            opacity: o.opacity ?? 1,
            selectable: false, evented: false,
          });
          fabricCanvas.add(img);
        }
      } catch (err) {
        console.error('Failed to render overlay:', o, err);
      }
    }
  }

  // ── Mask overlay ────────────────────────────────────────────────────────────
  const shouldIncludeMask = includeMask || (isExport && usedLayout.maskOnExport);
  if (usedLayout.maskUrl && shouldIncludeMask) {
    try {
      const maskImg = await FabricImage.fromURL(usedLayout.maskUrl, { crossOrigin: 'anonymous' });
      maskImg.set({
        left: 0,
        top: 0,
        originX: 'left',
        originY: 'top',
        scaleX: canvasW / maskImg.width!,
        scaleY: canvasH / maskImg.height!,
        selectable: false,
        evented: false,
      });
      fabricCanvas.add(maskImg);
    } catch { /* ignore failed mask */ }
  }

  // ── Render and export ───────────────────────────────────────────────────────
  fabricCanvas.renderAll();
  const dataUrl = fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });
  
  const targetDpi = (usedLayout.canvas?.dpi || 300) * multiplier;
  return changeDpiDataUrl(dataUrl, targetDpi);

  } finally {
    fabricCanvas.dispose();
  }
}
