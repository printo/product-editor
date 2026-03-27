import { Canvas, Rect, FabricImage, Textbox, FabricText, Path, Shadow } from 'fabric';
import type { CanvasItem } from './types';
import { createShapeFromOverlay, updateRelativeClipPath, changeDpiDataUrl } from '@/lib/fabric-utils';

// ─── Fabric-based canvas rendering ───────────────────────────────────────────

export interface RenderCanvasOptions {
  excludeFrameIdx?: number | null;
  isExport?: boolean;
  includeMask?: boolean;
  layoutOverride?: any;
}

export async function renderCanvas(
  canvasItem: CanvasItem,
  layoutDef: any,
  getFileUrlFn: (file: File) => string,
  options: RenderCanvasOptions = {},
): Promise<string> {
  const { excludeFrameIdx = null, isExport = false, includeMask = true, layoutOverride } = options;
  const usedLayout = layoutOverride || layoutDef;
  if (!usedLayout) return '';

  const canvasW = usedLayout.canvas?.width || usedLayout.surfaces?.[0]?.canvas?.width || 1200;
  const canvasH = usedLayout.canvas?.height || usedLayout.surfaces?.[0]?.canvas?.height || 1800;

  const frames = (usedLayout.canvas?.width ? usedLayout.frames : usedLayout.surfaces?.[0]?.frames) || 
               (usedLayout.frames?.length > 0 ? usedLayout.frames : [{ x: 0, y: 0, width: canvasW, height: canvasH }]);

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
    const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
      const fr = isPercent ? (frameSpec.borderRadiusMm || 0) * (canvasW / usedLayout.canvas?.widthMm) : (frameSpec.borderRadiusMm || 0);

      const file = frameState.originalFile;
      if (!file) continue;
      const imgSource = getFileUrlFn(file);

      try {
        const fabricImg = await FabricImage.fromURL(imgSource, { crossOrigin: 'anonymous' });
        const imgW = fabricImg.width!;
        const imgH = fabricImg.height!;

        const rot = frameState.rotation || 0;
        const rad = (rot * Math.PI) / 180;
        const sinA = Math.abs(Math.sin(rad));
        const cosA = Math.abs(Math.cos(rad));
        const effW = imgW * cosA + imgH * sinA;
        const effH = imgW * sinA + imgH * cosA;

        const baseScale = frameState.fitMode === 'cover'
          ? Math.max(fw / effW, fh / effH)
          : Math.min(fw / effW, fh / effH);
        const finalScale = baseScale * frameState.scale;

        const w = effW * finalScale;
        const h = effH * finalScale;
        const x = fx + (fw - w) / 2 + frameState.offset.x;
        const y = fy + (fh - h) / 2 + frameState.offset.y;

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
    const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
    const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
    const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
    const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
    const fr = Math.min(fw / 2, fh / 2, isPercent ? (frameSpec.borderRadiusMm || 0) * (canvasW / usedLayout.canvas?.widthMm) : (frameSpec.borderRadiusMm || 0));

    if (fr > 0) {
      // Counter-clockwise rounded rectangular hole
      paperPathStr += ` M ${fx + fr} ${fy} 
        A ${fr} ${fr} 0 0 0 ${fx} ${fy + fr} 
        L ${fx} ${fy + fh - fr} 
        A ${fr} ${fr} 0 0 0 ${fx + fr} ${fy + fh} 
        L ${fx + fw - fr} ${fy + fh} 
        A ${fr} ${fr} 0 0 0 ${fx + fw} ${fy + fh - fr} 
        L ${fx + fw} ${fy + fr} 
        A ${fr} ${fr} 0 0 0 ${fx + fw - fr} ${fy} Z`;
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
    shadow: new Shadow({ color: 'rgba(0,0,0,0.12)', blur: 20, offsetX: 0, offsetY: 0 }),
  });
  fabricCanvas.add(paperOverlay);

  // ── Frame placeholder labels — preview only ─────────────────────────────────
  if (!isExport && frames.length > 1) {
    for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
      if (excludeFrameIdx !== null && frameIdx === excludeFrameIdx) continue;
      const frameSpec = frames[frameIdx];
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
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
            fontSize: o.fontSize,
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
  
  const targetDpi = usedLayout.canvas?.dpi || 300;
  return changeDpiDataUrl(dataUrl, targetDpi);

  } finally {
    fabricCanvas.dispose();
  }
}
