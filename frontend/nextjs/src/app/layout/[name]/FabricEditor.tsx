'use client';

import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import {
  Canvas, Rect, FabricImage, Textbox, Point, Shadow, Path,
  type FabricObject,
} from 'fabric';
import type { CanvasItem } from './types';
import type { LayerSelection } from './LayersPanel';
import { getShapeDef } from '@/lib/shape-catalog';
import { createShapeFromOverlay, centerCanvasViewport, updateRelativeClipPath } from '@/lib/fabric-utils';

// ─── Handle type exposed to parent ──────────────────────────────────────────

export interface FabricEditorHandle {
  toDataURL: () => string | null;
  toFullResDataURL: () => string | null;
  getZoomToFit: () => number;
  /** Snapshot the Fabric canvas state as a plain JSON object */
  getCanvasJSON: () => object | null;
  /** Restore the Fabric canvas from a previously captured JSON snapshot */
  loadCanvasJSON: (json: object) => Promise<void>;
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
  canvasWidth?: number;
  canvasHeight?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_KEY = '__fabricEditor';
const PAPER_KEY = '__paper';

// ─── Interactive shape controls styling ──────────────────────────────────────

const INTERACTIVE_SHAPE_OPTS = {
  cornerColor: '#6366f1',
  cornerSize: 14,
  cornerStyle: 'circle' as const,
  transparentCorners: false,
  borderColor: '#a855f7',
};

/** Create a Fabric shape from overlay state — delegates to shared factory */
function makeShapeObject(
  overlay: Extract<CanvasItem['overlays'][number], { type: 'shape' }>,
  canvasW: number,
  canvasH: number,
): FabricObject | null {
  return createShapeFromOverlay(overlay, canvasW, canvasH, INTERACTIVE_SHAPE_OPTS);
}

// ─── Helper: apply overlay state to an existing Fabric object in-place ───────

function applyOverlayToObject(
  obj: FabricObject,
  overlay: CanvasItem['overlays'][number],
  canvasW: number,
  canvasH: number,
) {
  if (overlay.type === 'text') {
    const textObj = obj as Textbox;
    textObj.set({
      text: overlay.text,
      fontSize: overlay.fontSize,
      fill: overlay.color || '#000000',
      fontFamily: overlay.fontFamily || 'sans-serif',
      textAlign: (overlay.textAlign || 'center') as any,
      originX: overlay.textAlign === 'left' ? 'left' : overlay.textAlign === 'right' ? 'right' : 'center',
      left: (overlay.x / 100) * canvasW,
      top: (overlay.y / 100) * canvasH,
      angle: overlay.rotation || 0,
    });
  } else if (overlay.type === 'shape') {
    const sx = (overlay.x / 100) * canvasW;
    const sy = (overlay.y / 100) * canvasH;
    const sw = (overlay.width / 100) * canvasW;
    const sh = (overlay.height / 100) * canvasH;
    const def = getShapeDef(overlay.shapeType);
    if (def?.fabricType === 'circle') {
      const radius = Math.min(sw, sh) / 2;
      obj.set({ radius, left: sx + sw / 2, top: sy + sh / 2 } as any);
    } else if (def?.fabricType === 'ellipse') {
      obj.set({ rx: sw / 2, ry: sh / 2, left: sx + sw / 2, top: sy + sh / 2 } as any);
    } else {
      obj.set({ left: sx, top: sy, width: sw, height: sh });
    }
    obj.set({
      fill: overlay.fill || 'transparent',
      stroke: overlay.strokeWidth > 0 ? (overlay.stroke || '#000000') : undefined,
      strokeWidth: overlay.strokeWidth > 0 ? overlay.strokeWidth : 0,
      opacity: overlay.opacity ?? 1,
      angle: overlay.rotation || 0,
    });
  } else if (overlay.type === 'image') {
    obj.set({
      left: (overlay.x / 100) * canvasW,
      top: (overlay.y / 100) * canvasH,
      angle: overlay.rotation || 0,
      opacity: overlay.opacity ?? 1,
    });
    const newW = (overlay.width / 100) * canvasW;
    const newH = (overlay.height / 100) * canvasH;
    const scaleX = newW / (obj.width || 1);
    const scaleY = newH / (obj.height || 1);
    obj.set({ scaleX, scaleY });

    // Update image source in-place using setSrc if changed
    const imgObj = obj as FabricImage;
    if ((imgObj as any)._element?.src !== overlay.src) {
      imgObj.setSrc(overlay.src, { crossOrigin: 'anonymous' });
    }
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export const FabricEditor = forwardRef<FabricEditorHandle, FabricEditorProps>(function FabricEditor({
  editingCanvas,
  layout,
  viewZoom,
  selectedLayer,
  onCanvasChange,
  onLayerSelect,
  getFileUrl,
  canvasWidth,
  canvasHeight,
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
  const fitZoomRef = useRef(1);
  const spacePressedRef = useRef(false);

  // Track structural state for smart rebuild vs in-place update
  const prevOverlayCountRef = useRef(-1);
  const prevFrameCountRef = useRef(-1);
  const prevOverlayTypesRef = useRef<string>('');
  
  // ✅ Stabilize callbacks with refs to prevent listener churn in useEffect
  const onCanvasChangeRef = useRef(onCanvasChange);
  const onLayerSelectRef = useRef(onLayerSelect);
  useEffect(() => { onCanvasChangeRef.current = onCanvasChange; }, [onCanvasChange]);
  useEffect(() => { onLayerSelectRef.current = onLayerSelect; }, [onLayerSelect]);

  // Canvas logical dimensions (passed from surface or fallback)
  const canvasW = canvasWidth || layout?.canvas?.width || (layout?.surfaces?.[0] as any)?.width || 1200;
  const canvasH = canvasHeight || layout?.canvas?.height || (layout?.surfaces?.[0] as any)?.height || 1800;

  console.log('[FabricEditor] 🎨 Init Render:', {
    canvasW, canvasH, viewZoom,
    framesCount: editingCanvas?.frames?.length,
    containerSize
  });

  // ── Initialize Fabric canvas ──────────────────────────────────────────────

  useEffect(() => {
    const el = canvasElRef.current;
    const container = containerRef.current;
    if (!el || !container) return;

    const fc = new Canvas(el, {
      width: 100, height: 100,
      backgroundColor: 'transparent', // Allow CSS background to show through workspace
      selection: true,
      preserveObjectStacking: true, // ✅ Keep images behind the white paper mask even when selected/dragged
      controlsAboveOverlay: true,
      fireRightClick: true,
      stopContextMenu: true,
      imageSmoothingEnabled: true,
      renderOnAddRemove: false,
    });
    
    // ✅ Keep content strictly within the layout logical bounds to stop infinite bleeding
    fc.clipPath = new Rect({
      left: 0, top: 0, width: canvasW, height: canvasH,
      originX: 'left', originY: 'top',
      absolutePositioned: false, // This ensures it scales flawlessly with viewport zoom
    });

    fabricRef.current = fc;

    // ── Viewport Centering Helper ──────────────────────────────────────────
    const centerViewport = (width: number, height: number, zoom: number) => {
      if (!fc || width === 0 || height === 0) return;
      if (!interactingRef.current) {
        fitZoomRef.current = centerCanvasViewport(fc, width, height, canvasW, canvasH, zoom);
        fc.requestRenderAll();
      }
    };

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
      centerViewport(width, height, viewZoom);
    });
    observer.observe(container);

    // ── #1 Native Zoom (mouse wheel) ─────────────────────────────────────
    fc.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY;
      let zoom = fc.getZoom();
      zoom *= 0.999 ** delta;
      if (zoom > 20) zoom = 20;
      if (zoom < 0.01) zoom = 0.01;
      fc.zoomToPoint(new Point(opt.e.offsetX, opt.e.offsetY), zoom);
      fc.requestRenderAll();
      opt.e.preventDefault();
      opt.e.stopPropagation();
    });

    // ── #2 Native Pan with relativePan() (Alt/Cmd/Space+drag) ──────────────
    fc.on('mouse:down', (opt) => {
      interactingRef.current = true;
      const isSpace = spacePressedRef.current;
      const isMod = opt.e.altKey || opt.e.metaKey; // Alt/Option or Cmd/Ctrl
      // ✅ Allow panning if Alt/Cmd/Space is held OR clicking background (no target)
      if (isSpace || isMod || (!opt.target && !opt.e.shiftKey)) {
        (fc as any).__isPanning = true;
        fc.selection = false; // Disable selection box while panning
        fc.defaultCursor = 'grabbing';
        fc.setCursor('grabbing');
      }
    });
    fc.on('mouse:move', (opt) => {
      if ((fc as any).__isPanning) {
        const me = opt.e as MouseEvent;
        // ✅ Use Fabric's built-in relativePan instead of manual viewportTransform mutation
        fc.relativePan(new Point(me.movementX ?? 0, me.movementY ?? 0));
        fc.setViewportTransform(fc.viewportTransform!); // Force recalc of clipPath and bbox cache
        fc.renderAll(); // Force visual update to avoid delay
      }
    });
    fc.on('mouse:up', () => {
      interactingRef.current = false;
      if ((fc as any).__isPanning) {
        (fc as any).__isPanning = false;
        fc.selection = true; // Re-enable selection
        const newCursor = spacePressedRef.current ? 'grab' : 'default';
        fc.defaultCursor = newCursor;
        fc.setCursor(newCursor);
        fc.setViewportTransform(fc.viewportTransform!);
        fc.renderAll();
      }
      setTimeout(() => { interactingRef.current = false; }, 200);
    });

    // Text editing guards — CRITICAL: prevents rebuild during inline editing
    fc.on('text:editing:entered', () => { isEditingRef.current = true; });
    fc.on('text:editing:exited', () => {
      setTimeout(() => { isEditingRef.current = false; }, 150);
    });

    // Keyboard listeners for space-panning
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isEditingRef.current) {
        spacePressedRef.current = true;
        fc.defaultCursor = 'grab';
        if (!fc.getActiveObject()) fc.setCursor('grab');
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spacePressedRef.current = false;
        fc.defaultCursor = 'default';
        fc.setCursor('default');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      observer.disconnect();
      fc.dispose();
      fabricRef.current = null;
    };
  }, []); // Empty dependency array: runs once on mount

  // ── Smart rebuild or in-place update ──────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || containerSize.width === 0) return;

    // ── #1 Guard: skip if canvas is current busy with internal dragging ────────
    // However, if it's a structural change, we MUST rebuild.
    // AND if it's a property update from props (like sliders), we SHOULD apply it.
    // So we ONLY skip if it's a "silent" update or similar.
    // For now, let's remove the aggressive interactingRef guard to solve unresponsive sliders.
    if (isEditingRef.current) return;

    const currentOverlayCount = editingCanvas.overlays.length;
    const currentFrameCount = editingCanvas.frames.length;
    // Structural type signature — detects if overlay types changed (e.g. a text replaced by shape)
    const currentTypeSig = editingCanvas.overlays.map(o => o.type).join(',');

    const needsFullRebuild =
      currentOverlayCount !== prevOverlayCountRef.current ||
      currentFrameCount !== prevFrameCountRef.current ||
      currentTypeSig !== prevOverlayTypesRef.current;

    prevOverlayCountRef.current = currentOverlayCount;
    prevFrameCountRef.current = currentFrameCount;
    prevOverlayTypesRef.current = currentTypeSig;

    if (!needsFullRebuild) {
      // ── #3 In-place property update — no full rebuild needed ─────────────
      const objs = fc.getObjects();
      const overlayObjs = objs
        .filter((o: any) => typeof o.__overlayIdx === 'number')
        .sort((a: any, b: any) => a.__overlayIdx - b.__overlayIdx);

      editingCanvas.overlays.forEach((overlay, idx) => {
        const obj = overlayObjs.find((o: any) => o.__overlayIdx === idx);
        if (obj) {
          applyOverlayToObject(obj, overlay, canvasW, canvasH);
          obj.setCoords();
        }
      });
      // Update background color
      const paperObj = objs.find((o: any) => o[PAPER_KEY]);
      if (paperObj) {
        paperObj.set({ 
          fill: editingCanvas.bgColor || '#ffffff',
          shadow: new Shadow({ color: 'rgba(0,0,0,0.1)', blur: 15, offsetX: 0, offsetY: 0 }),
        });
      }

      // ── #4 In-place frame property updates ────────────────────────────────
      const frameObjs = objs
        .filter((o: any) => (o as any)[DATA_KEY] === 'frame')
        .sort((a: any, b: any) => (a as any).__frameIdx - (b as any).__frameIdx);

      editingCanvas.frames.forEach((frameState, idx) => {
        const img = frameObjs.find((o: any) => (o as any).__frameIdx === idx) as FabricImage;
        if (!img) return;

        const clip = (img as any).__clipRect as { fx: number; fy: number; fw: number; fh: number };
        if (!clip) return;

        const imgW = img.width!;
        const imgH = img.height!;
        let scale = frameState.scale;

        if (frameState.fitMode === 'contain' || frameState.fitMode === 'cover') {
          const sX = clip.fw / imgW;
          const sY = clip.fh / imgH;
          const baseScale = frameState.fitMode === 'contain' ? Math.min(sX, sY) : Math.max(sX, sY);
          scale = baseScale * frameState.scale;
        }

        const imgX = clip.fx + (clip.fw - imgW * scale) / 2 + frameState.offset.x;
        const imgY = clip.fy + (clip.fh - imgH * scale) / 2 + frameState.offset.y;

        img.set({
          left: imgX + (imgW * scale) / 2,
          top: imgY + (imgH * scale) / 2,
          scaleX: scale, scaleY: scale,
          angle: frameState.rotation,
        });
        img.setCoords();
        console.log(`[FabricEditor] ⚡ In-Place Update Frame ${idx}:`, { left: img.left, top: img.top, scale: scale, angle: frameState.rotation });
      });

      fc.requestRenderAll();
      return;
    }

    // ── Full structural rebuild ──────────────────────────────────────────
    console.log('[FabricEditor] 🏗️ Full Structural Rebuild triggered');
    const gen = ++buildGenRef.current;

    // Clean managed clear — preserves viewportTransform
    fc.getObjects().forEach(o => fc.remove(o));
    fc.discardActiveObject();
    fc.backgroundColor = 'transparent';
    fc.set({ renderOnAddRemove: false });

    // Track Z positions for precise ordering
    // Order: paper(0), frames(1..N), overlays(N+1..M), mask(last)
    let zIndex = 0;

    // We will render the shadow and background dynamically in the rebuild process.
    // So we don't need a static paper rect here anymore.

    // ✅ Center viewport synchronously IMMEDIATELY after paper add
    // This prevents the "top-left flash" before images load
    const { width: cW, height: cH } = containerSize;
    if (cW > 0 && cH > 0) {
      fitZoomRef.current = centerCanvasViewport(fc, cW, cH, canvasW, canvasH, viewZoom);
    }

    // ── Frame images ──────────────────────────────────────────────────────
    const frames = layout?.frames?.length > 0
      ? layout.frames
      : [{ x: 0, y: 0, width: canvasW, height: canvasH }];

    const frameZStart = zIndex;
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

        (img as any).__clipRect = { fx, fy, fw, fh };
        const imgX = fx + (fw - imgW * scale) / 2 + frameState.offset.x;
        const imgY = fy + (fh - imgH * scale) / 2 + frameState.offset.y;

        console.log(`[FabricEditor] 🖼️ Loading frame ${frameIdx}:`, {
          fx, fy, fw, fh, imgW, imgH, scale, imgX, imgY, rotation: frameState.rotation
        });

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
        // Buggy clipPath removed. The image will be masked by the paperOverlay instead.
        (img as any)[DATA_KEY] = 'frame';
        (img as any).__frameIdx = frameIdx;
        fc.add(img);
        fc.moveObjectTo(img, frameZStart + frameIdx);
      } catch (err) {
        console.error(`Failed to load frame image ${imgSource}:`, err);
      }
    });

    // ── Paper Overlay Mask (Hole-punching) ───────────────────────────────────
    // A white paper layer rendered ABOVE the images, with transparent holes cut out 
    // for each frame using SVG `evenodd` fill rule.
    let paperPathStr = `M 0 0 L ${canvasW} 0 L ${canvasW} ${canvasH} L 0 ${canvasH} Z`;
    
    frames.forEach((frameSpec) => {
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
      // Counter-clockwise rectangular hole
      paperPathStr += ` M ${fx} ${fy} L ${fx} ${fy+fh} L ${fx+fw} ${fy+fh} L ${fx+fw} ${fy} Z`;
    });

    const paperOverlay = new Path(paperPathStr, {
      left: 0, top: 0,
      originX: 'left', originY: 'top', // ✅ Force top-left alignment so the holes register perfectly over the image frames
      fill: editingCanvas.bgColor || '#ffffff',
      selectable: false, evented: false,
      fillRule: 'evenodd', 
      shadow: new Shadow({ color: 'rgba(0,0,0,0.12)', blur: 20, offsetX: 0, offsetY: 0 })
    });
    (paperOverlay as any)[PAPER_KEY] = true;
    fc.add(paperOverlay);
    
    const paperOverlayZ = frameZStart + editingCanvas.frames.length;
    fc.moveObjectTo(paperOverlay, paperOverlayZ);

    // ── Overlays (Text, shapes, icons) ───────────────────────────────────
    const overlayZStart = paperOverlayZ + 1;

    const loadOverlayPromises = editingCanvas.overlays.map(async (overlay, oIdx) => {
      let fabricObj: FabricObject | null = null;

      if (overlay.type === 'text') {
        fabricObj = new Textbox(overlay.text, {
          left: (overlay.x / 100) * canvasW,
          top: (overlay.y / 100) * canvasH,
          originX: overlay.textAlign === 'left' ? 'left' : overlay.textAlign === 'right' ? 'right' : 'center',
          originY: 'center',
          fontSize: overlay.fontSize,
          fill: overlay.color || '#000000',
          fontFamily: overlay.fontFamily || 'sans-serif',
          textAlign: (overlay.textAlign || 'center') as any,
          width: canvasW * 0.8,
          editable: true,
          splitByGrapheme: true,
          cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle',
          transparentCorners: false, borderColor: '#f97316',
          angle: overlay.rotation || 0,
        });
        (fabricObj as any)[DATA_KEY] = 'text';
      } else if (overlay.type === 'shape') {
        fabricObj = makeShapeObject(overlay as any, canvasW, canvasH);
        if (fabricObj) (fabricObj as any)[DATA_KEY] = 'shape';
      } else if (overlay.type === 'image') {
        const ix = (overlay.x / 100) * canvasW;
        const iy = (overlay.y / 100) * canvasH;
        const iw = (overlay.width / 100) * canvasW;
        const ih = (overlay.height / 100) * canvasH;

        try {
          const img = await FabricImage.fromURL(overlay.src, { crossOrigin: 'anonymous' });
          if (buildGenRef.current !== gen) return;
          img.set({
            left: ix, top: iy,
            originX: 'left', originY: 'top',
            scaleX: iw / (img.width || 1),
            scaleY: ih / (img.height || 1),
            angle: overlay.rotation || 0,
            opacity: overlay.opacity ?? 1,
            cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle',
            transparentCorners: false, borderColor: '#10b981',
          });
          (img as any)[DATA_KEY] = 'image';
          (img as any).__overlayIdx = oIdx;
          fc.add(img);
          fc.moveObjectTo(img, overlayZStart + oIdx);
          return; // handled async, return early
        } catch (err) {
          console.error(`Failed to load image overlay ${overlay.src}:`, err);
          return;
        }
      }

      if (fabricObj) {
        (fabricObj as any).__overlayIdx = oIdx;
        fc.add(fabricObj);
        fc.moveObjectTo(fabricObj, overlayZStart + oIdx);
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
        // Mask always on top — bring to absolute front after all others
        fc.bringObjectToFront(maskImg);
      }).catch((err) => {
        console.error(`Failed to load mask image ${layout.maskUrl}:`, err);
      });
    }

    // Wait for all async loads, then render
    Promise.all([...loadFramePromises, ...loadOverlayPromises, maskPromise]).then(() => {
      if (fc !== fabricRef.current || buildGenRef.current !== gen) return;

      // Restore selection or Auto-select
      const objs = fc.getObjects();
      let targetObj: FabricObject | undefined;
      
      if (selectedLayer) {
        if (selectedLayer.type === 'frame') {
          targetObj = objs.find((o: any) => o.__frameIdx === selectedLayer.index);
        } else {
          targetObj = objs.find((o: any) => o.__overlayIdx === selectedLayer.index);
        }
      } 
      
      // Auto-select first frame if nothing else selected and only 1 frame exists
      if (!targetObj && editingCanvas.frames.length === 1 && editingCanvas.overlays.length === 0) {
        targetObj = objs.find((o: any) => o.__frameIdx === 0);
        if (targetObj) onLayerSelect({ type: 'frame', index: 0 });
      }

      if (targetObj) {
        fc.setActiveObject(targetObj);
      }
      
      fc.requestRenderAll();
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCanvas, layout, canvasW, canvasH, getFileUrl, containerSize]);

  // ── Standalone Viewport Centering ──────────────────────────────────────────

  // ── Standalone Viewport Centering (props changes) ──────────────────────────
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || containerSize.width === 0) return;
    const { width, height } = containerSize;
    fitZoomRef.current = centerCanvasViewport(fc, width, height, canvasW, canvasH, viewZoom);
    fc.requestRenderAll();
  }, [viewZoom, canvasW, canvasH, containerSize, buildGenRef.current]);

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
              x: Math.abs(newOffsetX) < 8 ? 0 : newOffsetX,
              y: Math.abs(newOffsetY) < 8 ? 0 : newOffsetY,
            },
            rotation: Math.round(target.angle ?? f.rotation),
          };
        });

        onCanvasChangeRef.current({ ...current, frames: newFrames });
      } else {
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
              text: textObj.text || o.text,
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
        onCanvasChangeRef.current({ ...current, overlays: newOverlays });
      }
    };

    const handleSelection = (e: any) => {
      const selected = e.selected?.[0];
      if (!selected || !(selected as any)[DATA_KEY]) {
        onLayerSelect({ type: 'canvas', index: -1 });
        return;
      }
      const type = (selected as any)[DATA_KEY];
      if (type === 'frame') {
        onLayerSelectRef.current({ type: 'frame', index: (selected as any).__frameIdx });
      } else if (type === 'text' || type === 'shape' || type === 'image') {
        onLayerSelectRef.current({ type: type, index: (selected as any).__overlayIdx });
      }
    };

    const handleTextChanged = (e: any) => {
      const target = e.target as Textbox;
      if (!target || (target as any).__overlayIdx === undefined) return;
      
      // ✅ CRITICAL: Do NOT sync to parent state while actively editing on canvas.
      // This prevents React re-renders from re-mounting components or interrupting the browser's input focus.
      // The final state will be synced in handleEditingExited.
      if (isEditingRef.current) return;

      const idx = (target as any).__overlayIdx as number;
      const current = editingCanvasRef.current;
      const newOverlays = current.overlays.map((o, i) => {
        if (i !== idx || o.type !== 'text') return o;
        return { ...o, text: target.text || o.text };
      });
      onCanvasChangeRef.current({ ...current, overlays: newOverlays });
    };

    const handleEditingEntered = () => {
      isEditingRef.current = true;
    };
    const handleEditingExited = () => {
      isEditingRef.current = false;
      // Also trigger a final mod on exit to ensure state is perfectly in sync
      const active = fc.getActiveObject();
      if (active) handleModified({ target: active });
    };

    fc.on('object:modified', handleModified);
    fc.on('selection:created', handleSelection);
    fc.on('selection:updated', handleSelection);
    fc.on('selection:cleared', handleSelection);
    fc.on('text:changed', handleTextChanged);
    fc.on('text:editing:entered', handleEditingEntered);
    fc.on('text:editing:exited', handleEditingExited);

    return () => {
      fc.off('object:modified', handleModified);
      fc.off('selection:created', handleSelection);
      fc.off('selection:updated', handleSelection);
      fc.off('selection:cleared', handleSelection);
      fc.off('text:changed', handleTextChanged);
      fc.off('text:editing:entered', handleEditingEntered);
      fc.off('text:editing:entered', handleEditingEntered);
      fc.off('text:editing:exited', handleEditingExited);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasW, canvasH]); // Removed unstable callbacks from dependencies

  // ── Expose handle to parent ───────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    toDataURL: () => {
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

    // ✅ #7 Fabric native JSON snapshot/restore for undo/redo
    getCanvasJSON: () => {
      const fc = fabricRef.current;
      if (!fc) return null;
      return fc.toJSON();
    },
    loadCanvasJSON: (json: object) => {
      return new Promise<void>((resolve) => {
        const fc = fabricRef.current;
        if (!fc) { resolve(); return; }
        fc.loadFromJSON(json).then(() => {
          fc.requestRenderAll();
          resolve();
        });
      });
    },
  }), [canvasW, canvasH]);

  return (
    <div ref={containerRef} className="flex-1 w-full h-full overflow-hidden bg-slate-100/50">
      <canvas ref={canvasElRef} />
    </div>
  );
});
