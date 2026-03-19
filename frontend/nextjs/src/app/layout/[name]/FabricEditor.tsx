'use client';

import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import {
  Canvas, Rect, Circle, Ellipse, Triangle, Polygon, FabricImage, Textbox, Path, type FabricObject,
} from 'fabric';
import type { CanvasItem } from './types';
import type { LayerSelection } from './LayersPanel';
import { getShapePath, getShapeDef } from '@/lib/shape-catalog';

// ─── Handle type exposed to parent ──────────────────────────────────────────

export interface FabricEditorHandle {
  toDataURL: () => string | null;
  toFullResDataURL: () => string | null;
  getZoomToFit: () => number;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface FabricEditorProps {
  editingCanvas: CanvasItem;
  layout: any;
  viewZoom: number;
  selectedLayer: LayerSelection | null;
  onCanvasChange: (updated: CanvasItem) => void;
  onLayerSelect: (layer: LayerSelection) => void;
  getFileUrl: (file: File) => string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_KEY = '__fabricEditor';
const PAPER_KEY = '__paper';

// ─── Component ───────────────────────────────────────────────────────────────

export const FabricEditor = forwardRef<FabricEditorHandle, FabricEditorProps>(function FabricEditor({
  editingCanvas,
  layout,
  viewZoom,
  selectedLayer,
  onCanvasChange,
  onLayerSelect,
  getFileUrl,
}, ref) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
  const fabricRef = useRef<Canvas | null>(null);
  const editingCanvasRef = useRef(editingCanvas);
  editingCanvasRef.current = editingCanvas;

  // Guards to prevent rebuild loops
  const interactingRef = useRef(false);
  const isEditingRef = useRef(false);       // TRUE while Fabric inline text editing is active
  const buildGenRef = useRef(0);
  const lastCanvasIdRef = useRef<string>('');
  const fitZoomRef = useRef(1);

  // Canvas logical dimensions (from layout definition)
  const canvasW = layout?.canvas?.width || 1200;
  const canvasH = layout?.canvas?.height || 1800;

  // ── Build a fingerprint of the canvas state for comparison ─────────────────

  const getCanvasFingerprint = useCallback((c: CanvasItem): string => {
    const frameParts = c.frames.map(f =>
      `${f.originalFile.name}_${f.originalFile.size}_${f.processedUrl || ''}_${f.fitMode}_${f.rotation}_${f.scale}_${f.offset.x}_${f.offset.y}`
    ).join('|');
    const overlayParts = c.overlays.map(o => {
      if (o.type === 'text') {
        return `text_${o.text}_${o.x}_${o.y}_${o.fontSize}_${o.color}_${o.fontFamily}_${o.textAlign}`;
      } else if (o.type === 'shape') {
        return `shape_${o.shapeType}_${o.x}_${o.y}_${o.width}_${o.height}_${o.fill}_${o.stroke}_${o.strokeWidth}_${o.opacity}_${o.rotation}`;
      } else if (o.type === 'image') {
        return `image_${o.src}_${o.x}_${o.y}_${o.width}_${o.height}_${o.opacity}_${o.rotation}`;
      }
      return '';
    }).join('|');
    return `${c.bgColor}::${frameParts}::${overlayParts}`;
  }, []);

  // ── Initialize Fabric canvas ──────────────────────────────────────────────

  useEffect(() => {
    const el = canvasElRef.current;
    const container = containerRef.current;
    if (!el || !container) return;

    const fc = new Canvas(el, {
      width: 100, height: 100, // Initial size, will be set by ResizeObserver
      backgroundColor: '#f1f5f9', // workspace bg (slate-100)
      selection: true,
      controlsAboveOverlay: true,
      fireRightClick: true,
      stopContextMenu: true,
      imageSmoothingEnabled: true,
      renderOnAddRemove: false,
    });
    fabricRef.current = fc;

    // ── Handle resizing ──────────────────────────────────────────────────
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width === 0 || height === 0) return;

      setContainerSize(prev => {
        if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
        return { width, height };
      });

      if (!fc.lowerCanvasEl) return;
      fc.setDimensions({ width, height });
      // Zoom and center logic is now in a separate useEffect
    });
    observer.observe(container);

    // ── Native Zoom & Pan ────────────────────────────────────────────────
    fc.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY;
      let zoom = fc.getZoom();
      zoom *= 0.999 ** delta;
      if (zoom > 20) zoom = 20;
      if (zoom < 0.01) zoom = 0.01;
      fc.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY } as any, zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    // Interaction tracking
    fc.on('mouse:down', (opt) => {
      interactingRef.current = true;
      if (opt.e.altKey) {
        (fc as any).isDragging = true;
        (fc as any).lastPosX = (opt.e as any).clientX;
        (fc as any).lastPosY = (opt.e as any).clientY;
      }
    });
    fc.on('mouse:move', (opt) => {
      if ((fc as any).isDragging) {
        const e = opt.e as any;
        const vpt = fc.viewportTransform!;
        vpt[4] += e.clientX - (fc as any).lastPosX;
        vpt[5] += e.clientY - (fc as any).lastPosY;
        fc.requestRenderAll();
        (fc as any).lastPosX = e.clientX;
        (fc as any).lastPosY = e.clientY;
      }
    });
    fc.on('mouse:up', () => {
      interactingRef.current = false;
      (fc as any).isDragging = false;
      setTimeout(() => { interactingRef.current = false; }, 100); // Small delay to ensure interaction state clears
    });

    // Text editing guards — CRITICAL: prevents rebuild during inline editing
    fc.on('text:editing:entered', () => { isEditingRef.current = true; });
    fc.on('text:editing:exited', () => {
      setTimeout(() => { isEditingRef.current = false; }, 150);
    });

    return () => {
      observer.disconnect();
      fc.dispose();
      fabricRef.current = null;
    };
  }, []); // Empty dependency array: runs once on mount

  // ── Full rebuild: editingCanvas → Fabric objects ──────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || containerSize.width === 0) return;

    // Skip rebuild if user is interacting or inline-editing text
    if (interactingRef.current || isEditingRef.current) return;

    // Skip rebuild if fingerprint is identical
    const fingerprint = getCanvasFingerprint(editingCanvas);
    if (fingerprint === lastCanvasIdRef.current) return;
    lastCanvasIdRef.current = fingerprint;

    const gen = ++buildGenRef.current;

    // ── Clean managed clear ─────────────────────────────────────────────
    // We use remove() instead of clear() to preserve the viewportTransform
    fc.getObjects().forEach(o => fc.remove(o));
    fc.discardActiveObject();
    fc.backgroundColor = '#f1f5f9';
    fc.set({ renderOnAddRemove: false });

    // ── Paper background (white rect at canvas logical size) ────────────
    const paper = new Rect({
      left: 0, top: 0, width: canvasW, height: canvasH,
      fill: editingCanvas.bgColor || '#ffffff',
      selectable: false, evented: false,
      strokeWidth: 0,
    });
    (paper as any)[PAPER_KEY] = true;
    fc.add(paper);

    // ── Frame images ──────────────────────────────────────────────────────
    const frames = layout?.frames?.length > 0
      ? layout.frames
      : [{ x: 0, y: 0, width: canvasW, height: canvasH }];

    const loadFramePromises = editingCanvas.frames.map(async (frameState, frameIdx) => {
      const frameSpec = frames[frameIdx];
      if (!frameSpec || !frameState) return;

      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;

      const imgSource = frameState.processedUrl || getFileUrl(frameState.originalFile);
      try {
        const img = await FabricImage.fromURL(imgSource, { crossOrigin: 'anonymous' });
        if (buildGenRef.current !== gen) return; // stale

        const imgW = img.width!;
        const imgH = img.height!;
        let scale = frameState.scale;

        if (frameState.fitMode === 'contain' || frameState.fitMode === 'cover') {
          const sX = fw / imgW;
          const sY = fh / imgH;
          const baseScale = frameState.fitMode === 'contain' ? Math.min(sX, sY) : Math.max(sX, sY);
          scale = baseScale * frameState.scale;
        }

        // Store clipPath info for modified event
        (img as any).__clipRect = { fx, fy, fw, fh };

        const imgX = fx + (fw - imgW * scale) / 2 + frameState.offset.x;
        const imgY = fy + (fh - imgH * scale) / 2 + frameState.offset.y;

        img.set({
          left: imgX + (imgW * scale) / 2,
          top: imgY + (imgH * scale) / 2,
          originX: 'center', originY: 'center',
          scaleX: scale, scaleY: scale,
          angle: frameState.rotation,
          selectable: true,
          hasControls: true,
          cornerColor: '#6366f1', cornerSize: 12, cornerStyle: 'circle',
          transparentCorners: false, borderColor: '#6366f1',
        });

        // Use a clipPath to keep images inside their frames
        img.clipPath = new Rect({
          left: fx, top: fy, width: fw, height: fh,
          originX: 'left', originY: 'top', absolutePositioned: true,
        });

        (img as any)[DATA_KEY] = 'frame';
        (img as any).__frameIdx = frameIdx;
        fc.add(img);
      } catch (err) {
        console.error(`Failed to load frame image ${imgSource}:`, err);
      }
    });

    // ── Overlays (Text, shapes, icons) ───────────────────────────────────
    const loadOverlayPromises = editingCanvas.overlays.map(async (overlay, oIdx) => {
      if (overlay.type === 'text') {
        const txt = new Textbox(overlay.text, {
          left: (overlay.x / 100) * canvasW,
          top: (overlay.y / 100) * canvasH,
          // Native alignment: origin corresponds to textAlign
          originX: overlay.textAlign === 'left' ? 'left' : overlay.textAlign === 'right' ? 'right' : 'center',
          originY: 'center',
          fontSize: overlay.fontSize,
          fill: overlay.color || '#000000',
          fontFamily: overlay.fontFamily || 'sans-serif',
          textAlign: (overlay.textAlign || 'center') as any,
          width: canvasW * 0.8, // Max width for text wrapping
          editable: true,
          splitByGrapheme: true, // Important for CJK characters
          cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle',
          transparentCorners: false, borderColor: '#f97316',
        });
        (txt as any)[DATA_KEY] = 'text';
        (txt as any).__overlayIdx = oIdx;
        fc.add(txt);
      } else if (overlay.type === 'shape') {
        const sx = (overlay.x / 100) * canvasW;
        const sy = (overlay.y / 100) * canvasH;
        const sw = (overlay.width / 100) * canvasW;
        const sh = (overlay.height / 100) * canvasH;

        const commonOpts = {
          fill: overlay.fill || 'transparent',
          stroke: overlay.strokeWidth > 0 ? (overlay.stroke || '#000000') : undefined,
          strokeWidth: overlay.strokeWidth > 0 ? overlay.strokeWidth : 0,
          opacity: overlay.opacity ?? 1,
          angle: overlay.rotation || 0,
          cornerColor: '#6366f1',
          cornerSize: 14,
          cornerStyle: 'circle' as const,
          transparentCorners: false,
          borderColor: '#a855f7',
        };

        let fabricObj: FabricObject | null = null;
        const def = getShapeDef(overlay.shapeType);

        if (def?.fabricType === 'rect') {
          const isRounded = overlay.shapeType === 'rounded-rect';
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
          const points = def.polygonPoints.map(p => ({
            x: (p.x / 100) * sw,
            y: (p.y / 100) * sh,
          }));
          fabricObj = new Polygon(points, {
            left: sx, top: sy,
            originX: 'left', originY: 'top',
            ...commonOpts,
          });
        } else { // Default to Path for custom SVG shapes
          const pathStr = getShapePath(overlay.shapeType, overlay.svgPath);
          fabricObj = new Path(pathStr, {
            left: sx, top: sy,
            originX: 'left', originY: 'top',
            scaleX: sw / 100, scaleY: sh / 100, // Scale path to fit width/height
            ...commonOpts,
          });
        }

        if (fabricObj) {
          (fabricObj as any)[DATA_KEY] = 'shape';
          (fabricObj as any).__overlayIdx = oIdx;
          fc.add(fabricObj);
        }
      } else if (overlay.type === 'image') {
        const ix = (overlay.x / 100) * canvasW;
        const iy = (overlay.y / 100) * canvasH;
        const iw = (overlay.width / 100) * canvasW;
        const ih = (overlay.height / 100) * canvasH;

        try {
          const img = await FabricImage.fromURL(overlay.src, { crossOrigin: 'anonymous' });
          if (buildGenRef.current !== gen) return; // stale
          const scaleX = iw / (img.width || 1);
          const scaleY = ih / (img.height || 1);
          img.set({
            left: ix, top: iy,
            originX: 'left', originY: 'top',
            scaleX, scaleY,
            angle: overlay.rotation || 0,
            opacity: overlay.opacity ?? 1,
            cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle',
            transparentCorners: false, borderColor: '#10b981',
          });
          (img as any)[DATA_KEY] = 'image';
          (img as any).__overlayIdx = oIdx;
          fc.add(img);
        } catch (err) {
          console.error(`Failed to load image overlay ${overlay.src}:`, err);
          // Skip failed image loads
        }
      }
    });

    // ── Mask overlay ──────────────────────────────────────────────────────
    let maskPromise = Promise.resolve();
    if (layout?.maskUrl) {
      maskPromise = FabricImage.fromURL(layout.maskUrl).then(maskImg => {
        if (fc !== fabricRef.current || buildGenRef.current !== gen) return;
        maskImg.set({
          left: 0, top: 0,
          originX: 'left', originY: 'top',
          scaleX: canvasW / maskImg.width!,
          scaleY: canvasH / maskImg.height!,
          selectable: false,
          evented: false,
          opacity: 1,
        });
        (maskImg as any)[DATA_KEY] = 'mask';
        fc.add(maskImg);
      }).catch((err) => {
        console.error(`Failed to load mask image ${layout.maskUrl}:`, err);
      });
    }

    // Wait for async loads, then z-order and render
    Promise.all([...loadFramePromises, ...loadOverlayPromises, maskPromise]).then(() => {
      if (fc !== fabricRef.current || buildGenRef.current !== gen) return;

      // Final Z-Order Correction (non-destructive)
      const objs = fc.getObjects();
      const paperObjs = objs.filter((o: any) => o[PAPER_KEY]);
      const frameObjs = objs.filter((o: any) => o[DATA_KEY] === 'frame');
      const maskObjs = objs.filter((o: any) => o[DATA_KEY] === 'mask');
      const overlayObjs = objs.filter((o: any) => typeof o.__overlayIdx === 'number')
                               .sort((a, b) => (a as any).__overlayIdx - (b as any).__overlayIdx);

      // Apply Z-order by bringing objects to front in the desired sequence
      // Paper -> Frames -> Overlays (in their original order) -> Mask
      [...paperObjs, ...frameObjs, ...overlayObjs, ...maskObjs].forEach(o => {
        fc.bringObjectToFront(o);
      });

      // Restore selection
      if (selectedLayer) {
        let targetObj: FabricObject | undefined;
        if (selectedLayer.type === 'frame') {
          targetObj = frameObjs.find((o: any) => o.__frameIdx === selectedLayer.index);
        } else { // text, shape, image are all in overlays
          targetObj = overlayObjs.find((o: any) => o.__overlayIdx === selectedLayer.index);
        }
        if (targetObj) fc.setActiveObject(targetObj);
      }
      fc.requestRenderAll();
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCanvas, layout, canvasW, canvasH, getFileUrl, getCanvasFingerprint, containerSize]); // containerSize added to ensure rebuild on resize

  // ── Standalone Viewport Centering ──────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    const { width, height } = containerSize;
    if (!fc || width === 0 || height === 0) return;

    // Calculate fit
    const pad = 40;
    const fitZoom = Math.min((width - pad * 2) / canvasW, (height - pad * 2) / canvasH);
    fitZoomRef.current = fitZoom;

    // Apply if not interacting
    if (!interactingRef.current) {
      const targetZoom = fitZoom * viewZoom;
      fc.setZoom(targetZoom);
      fc.viewportTransform![4] = (width - canvasW * targetZoom) / 2;
      fc.viewportTransform![5] = (height - canvasH * targetZoom) / 2;
      fc.requestRenderAll();
    }
  }, [containerSize, viewZoom, canvasW, canvasH]);

  // ── Fabric events → parent state ──────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    const handleModified = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || !(target as any)[DATA_KEY]) return;

      const type = (target as any)[DATA_KEY] as string;
      const current = editingCanvasRef.current;

      if (type === 'frame') {
        const idx = (target as any).__frameIdx as number;
        const clip = (target as any).__clipRect as { fx: number; fy: number; fw: number; fh: number };
        if (!clip) return;

        const cx = (target.left ?? 0);
        const cy = (target.top ?? 0);
        const imgCenterX = clip.fx + clip.fw / 2;
        const imgCenterY = clip.fy + clip.fh / 2;
        const newOffsetX = cx - imgCenterX;
        const newOffsetY = cy - imgCenterY;

        const newFrames = current.frames.map((f, i) => {
          if (i !== idx) return f;
          return {
            ...f,
            offset: {
              x: Math.abs(newOffsetX) < 8 ? 0 : newOffsetX, // Snap to 0 if close
              y: Math.abs(newOffsetY) < 8 ? 0 : newOffsetY, // Snap to 0 if close
            },
            rotation: Math.round(target.angle ?? f.rotation),
          };
        });

        const updated = { ...current, frames: newFrames };
        lastCanvasIdRef.current = getCanvasFingerprint(updated);
        onCanvasChange(updated);
      } else { // All other types (text, shape, image) are now in the unified overlays array
        const idx = (target as any).__overlayIdx as number;
        const newX = ((target.left ?? 0) / canvasW) * 100;
        const newY = ((target.top ?? 0) / canvasH) * 100;

        const newOverlays = current.overlays.map((o, i) => {
          if (i !== idx) return o;

          const commonUpdates = {
            x: Math.round(newX * 10) / 10,
            y: Math.round(newY * 10) / 10,
            rotation: Math.round(target.angle ?? o.rotation),
          };

          if (o.type === 'text') {
            const textObj = target as Textbox;
            return {
              ...o,
              ...commonUpdates,
              text: textObj.text || o.text, // Text content updated by text:changed
              fontSize: Math.round(textObj.fontSize ?? o.fontSize),
            };
          } else if (o.type === 'shape' || o.type === 'image') {
            const newW = (((target.width ?? 100) * (target.scaleX ?? 1)) / canvasW) * 100;
            const newH = (((target.height ?? 100) * (target.scaleY ?? 1)) / canvasH) * 100;
            return {
              ...o,
              ...commonUpdates,
              width: Math.round(newW * 10) / 10,
              height: Math.round(newH * 10) / 10,
            };
          }
          return { ...(o as any), ...commonUpdates };
        });
        const updated = { ...current, overlays: newOverlays };
        lastCanvasIdRef.current = getCanvasFingerprint(updated);
        onCanvasChange(updated);
      }
    };

    const handleSelection = (e: any) => {
      const selected = e.selected?.[0];
      if (!selected || !(selected as any)[DATA_KEY]) {
        onLayerSelect({ type: 'canvas', index: -1 }); // Deselect all
        return;
      }
      const type = (selected as any)[DATA_KEY];
      if (type === 'frame') {
        onLayerSelect({ type: 'frame', index: (selected as any).__frameIdx });
      } else if (type === 'text' || type === 'shape' || type === 'image') {
        onLayerSelect({ type: type, index: (selected as any).__overlayIdx });
      }
    };

    // Fabric inline text editing — sync text changes back to state
    // isEditingRef is TRUE here, so the resulting state change won't trigger a rebuild
    const handleTextChanged = (e: any) => {
      const target = e.target as Textbox;
      if (!target || (target as any)[DATA_KEY] !== 'text') return;
      const idx = (target as any).__overlayIdx as number;
      const current = editingCanvasRef.current;
      const newOverlays = current.overlays.map((o, i) => {
        if (i !== idx || o.type !== 'text') return o;
        return { ...o, text: target.text || o.text };
      });
      const updated = { ...current, overlays: newOverlays };
      lastCanvasIdRef.current = getCanvasFingerprint(updated);
      onCanvasChange(updated);
    };

    fc.on('object:modified', handleModified);
    fc.on('selection:created', handleSelection);
    fc.on('selection:updated', handleSelection);
    fc.on('selection:cleared', handleSelection); // Handle deselection
    fc.on('text:changed', handleTextChanged);

    return () => {
      fc.off('object:modified', handleModified);
      fc.off('selection:created', handleSelection);
      fc.off('selection:updated', handleSelection);
      fc.off('selection:cleared', handleSelection);
      fc.off('text:changed', handleTextChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasW, canvasH, onCanvasChange, onLayerSelect, getCanvasFingerprint]);

  // ── Expose handle to parent ───────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    toDataURL: () => {
      const fc = fabricRef.current;
      if (!fc) return null;
      fc.discardActiveObject();
      // Temporarily set zoom to fit-to-canvas for export
      const prevZoom = fc.getZoom();
      const prevVpt = [...fc.viewportTransform!];
      fc.setZoom(1);
      fc.viewportTransform = [1, 0, 0, 1, 0, 0];
      fc.setDimensions({ width: canvasW, height: canvasH });
      fc.renderAll();
      const url = fc.toDataURL({ format: 'png', multiplier: 1 });
      // Restore
      fc.setZoom(prevZoom);
      fc.viewportTransform = prevVpt as any;
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        fc.setDimensions({ width: rect.width, height: rect.height });
      }
      fc.renderAll();
      return url;
    },
    toFullResDataURL: () => {
      const fc = fabricRef.current;
      if (!fc) return null;
      fc.discardActiveObject();
      const prevZoom = fc.getZoom();
      const prevVpt = [...fc.viewportTransform!];
      fc.setZoom(1);
      fc.viewportTransform = [1, 0, 0, 1, 0, 0];
      fc.setDimensions({ width: canvasW, height: canvasH });
      fc.renderAll();
      const url = fc.toDataURL({ format: 'png', multiplier: 1 });
      // Restore
      fc.setZoom(prevZoom);
      fc.viewportTransform = prevVpt as any;
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        fc.setDimensions({ width: rect.width, height: rect.height });
      }
      fc.renderAll();
      return url;
    },
    getZoomToFit: () => fitZoomRef.current,
  }), [canvasW, canvasH]);

  return (
    <div ref={containerRef} className="flex-1 w-full h-full overflow-hidden">
      <canvas ref={canvasElRef} />
    </div>
  );
});
