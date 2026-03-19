import { Canvas, Rect, Circle, Ellipse, Triangle, Polygon, FabricImage, Textbox, Path, FabricText } from 'fabric';
import type { CanvasItem } from './types';
import { getShapePath, getShapeDef } from '@/lib/shape-catalog';

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

  const canvasW = usedLayout.canvas?.width || 1200;
  const canvasH = usedLayout.canvas?.height || 1800;

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

  const frames = usedLayout.frames?.length > 0
    ? usedLayout.frames
    : [{ x: 0, y: 0, width: canvasW, height: canvasH }];

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

    const imgSource = frameState.processedUrl || getFileUrlFn(frameState.originalFile);

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

      // Clip to frame region
      const clipRect = new Rect({
        left: fx, top: fy, width: fw, height: fh,
        originX: 'left', originY: 'top',
        absolutePositioned: true,
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

      fabricCanvas.add(fabricImg);
    } catch {
      // Skip frames with failed images
    }
  }

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
          const sx = (o.x / 100) * canvasW;
          const sy = (o.y / 100) * canvasH;
          const sw = (o.width / 100) * canvasW;
          const sh = (o.height / 100) * canvasH;
          const commonOpts = {
            fill: o.fill || 'transparent',
            stroke: o.strokeWidth > 0 ? (o.stroke || '#000000') : undefined,
            strokeWidth: o.strokeWidth > 0 ? o.strokeWidth : 0,
            opacity: o.opacity ?? 1,
            angle: o.rotation || 0,
            selectable: false, evented: false,
          };
          let fabricObj;
          const def = getShapeDef(o.shapeType);
          if (def?.fabricType === 'rect') {
            const isRounded = o.shapeType === 'rounded-rect';
            fabricObj = new Rect({
              left: sx, top: sy, width: sw, height: sh,
              originX: 'left', originY: 'top',
              rx: isRounded ? Math.min(sw, sh) * 0.15 : 0,
              ry: isRounded ? Math.min(sw, sh) * 0.15 : 0,
              ...commonOpts,
            });
          } else if (def?.fabricType === 'circle') {
            const radius = Math.min(sw, sh) / 2;
            fabricObj = new Circle({
              left: sx + sw / 2, top: sy + sh / 2, radius,
              originX: 'center', originY: 'center',
              ...commonOpts,
            });
          } else if (def?.fabricType === 'ellipse') {
            fabricObj = new Ellipse({
              left: sx + sw / 2, top: sy + sh / 2,
              rx: sw / 2, ry: sh / 2,
              originX: 'center', originY: 'center',
              ...commonOpts,
            });
          } else if (def?.fabricType === 'triangle') {
            fabricObj = new Triangle({
              left: sx, top: sy, width: sw, height: sh,
              originX: 'left', originY: 'top',
              ...commonOpts,
            });
          } else if (def?.fabricType === 'polygon' && def.polygonPoints) {
            const points = def.polygonPoints.map(p => ({ x: (p.x / 100) * sw, y: (p.y / 100) * sh }));
            fabricObj = new Polygon(points, {
              left: sx, top: sy,
              originX: 'left', originY: 'top',
              ...commonOpts,
            });
          } else {
            const pathStr = getShapePath(o.shapeType, o.svgPath);
            fabricObj = new Path(pathStr, {
              left: sx + sw / 2, top: sy + sh / 2,
              originX: 'center', originY: 'center',
              scaleX: sw / 100, scaleY: sh / 100,
              ...commonOpts,
            });
          }
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
  return fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });

  } finally {
    fabricCanvas.dispose();
  }
}
