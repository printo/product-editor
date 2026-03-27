'use client';

import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import {
  Canvas, Rect, FabricImage, Textbox, Point, Shadow, Path,
  type FabricObject,
} from 'fabric';
import type { CanvasItem } from './types';
import type { LayerSelection } from './LayersPanel';
import { getShapeDef } from '@/lib/shape-catalog';
import {
  createShapeFromOverlay,
  centerCanvasViewport,
  createCenterGuides,
  createGridLines,
} from '@/lib/fabric-utils';

// ─── Handle type exposed to parent ──────────────────────────────────────────

export interface FabricEditorHandle {
  toDataURL: (includeShadow?: boolean) => string | null;
  toFullResDataURL: (includeShadow?: boolean) => string | null;
  toMockupDataURL: () => string | null;
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
const BG_KEY   = '__bgLayer';
const GUIDE_KEY = '__guideLayer';
const GRID_KEY  = '__gridLayer';
const BLEED_KEY = '__bleedLayer';
const SAFE_KEY  = '__safeLayer';

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
  const [isTransforming, setIsTransforming] = React.useState(false);
  const fabricRef = useRef<Canvas | null>(null);
  const editingCanvasRef = useRef(editingCanvas);
  editingCanvasRef.current = editingCanvas;

  // Guards to prevent rebuild loops
  const interactingRef = useRef(false);
  const isEditingRef = useRef(false);       // TRUE while Fabric inline text editing is active
  const buildGenRef = useRef(0);
  const fitZoomRef = useRef(1);
  const spacePressedRef = useRef(false);
  // TRUE during toDataURL export — suppresses selection:cleared so the active object is not lost
  const suppressSelectionEventsRef = useRef(false);

  // Canvas logical dimensions (passed from surface or fallback)
  const canvasW = canvasWidth || layout?.canvas?.width || (layout?.surfaces?.[0] as any)?.width || 1200;
  const canvasH = canvasHeight || layout?.canvas?.height || (layout?.surfaces?.[0] as any)?.height || 1800;

  // Track structural state for smart rebuild vs in-place update
  const prevOverlayCountRef = useRef(-1);
  const prevFrameCountRef = useRef(-1);
  const prevOverlayTypesRef = useRef<string>('');
  const prevIsTransformingRef = useRef(false);

  // ✅ Helper to generate paper overlay path string (punched holes)
  const getPaperPath = useCallback((isTransforming: boolean) => {
    let path = `M 0 0 L ${canvasW} 0 L ${canvasW} ${canvasH} L 0 ${canvasH} Z`;
    const frames = layout?.frames?.length > 0
      ? layout.frames
      : [{ x: 0, y: 0, width: canvasW, height: canvasH }];

    frames.forEach((frameSpec: any) => {
        const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
        let fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
        let fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
        let fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
        let fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;

      const pxPerMm = canvasW / (layout?.canvas?.widthMm || 1);
      let frMm = Number(frameSpec.borderRadiusMm || 0);
      const bleed = Number(frameSpec.bleedMm || 0);

      // Smart clipping: expand hole to include bleed zone during transformation
      if (isTransforming && bleed > 0) {
        const bleedPx = bleed * pxPerMm;
        fx -= bleedPx; fy -= bleedPx; fw += bleedPx * 2; fh += bleedPx * 2;
        if (frMm > 0) frMm += bleed;
      }

      const fr = Math.min(fw / 2, fh / 2, frMm * pxPerMm);
      if (fr > 0) {
        // Punched-out rounded rect (A command for arcs)
        path += ` M ${fx + fr} ${fy} A ${fr} ${fr} 0 0 0 ${fx} ${fy + fr} L ${fx} ${fy + fh - fr} A ${fr} ${fr} 0 0 0 ${fx + fr} ${fy + fh} L ${fx + fw - fr} ${fy + fh} A ${fr} ${fr} 0 0 0 ${fx + fw} ${fy + fh - fr} L ${fx + fw} ${fy + fr} A ${fr} ${fr} 0 0 0 ${fx + fw - fr} ${fy} Z`;
      } else {
        // Punched-out rect
        path += ` M ${fx} ${fy} L ${fx} ${fy + fh} L ${fx + fw} ${fy + fh} L ${fx + fw} ${fy} Z`;
      }
    });
    return path;
  }, [canvasW, canvasH, layout]);
  
  // ✅ Stabilize callbacks with refs to prevent listener churn in useEffect
  const onCanvasChangeRef = useRef(onCanvasChange);
  const onLayerSelectRef = useRef(onLayerSelect);
  useEffect(() => { onCanvasChangeRef.current = onCanvasChange; }, [onCanvasChange]);
  useEffect(() => { onLayerSelectRef.current = onLayerSelect; }, [onLayerSelect]);

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

    if (isEditingRef.current) return;

    const currentOverlayCount = editingCanvas.overlays.length;
    const currentFrameCount = editingCanvas.frames.length;
    const currentTypeSig = editingCanvas.overlays.map(o => o.type).join(',');

    const needsFullRebuild =
      currentOverlayCount !== prevOverlayCountRef.current ||
      currentFrameCount !== prevFrameCountRef.current ||
      currentTypeSig !== prevOverlayTypesRef.current;

    const transformChanged = isTransforming !== prevIsTransformingRef.current;

    prevOverlayCountRef.current = currentOverlayCount;
    prevFrameCountRef.current = currentFrameCount;
    prevOverlayTypesRef.current = currentTypeSig;
    prevIsTransformingRef.current = isTransforming;

    if (!needsFullRebuild) {
      // ── #3 In-place property update ─────────────
      const objs = fc.getObjects();

      // ✅ Update paper overlay in-place if transform status changed
      const paperObj = objs.find((o: any) => o[PAPER_KEY]) as Path;
      if (paperObj) {
        if (transformChanged || !paperObj.path) {
          // Use Path constructor to parse string into array of commands to avoid TypeError in toDataURL/toJSON
          const tempPath = new Path(getPaperPath(isTransforming));
          paperObj.set({ path: tempPath.path });
        }
        paperObj.set({
          fill: editingCanvas.paperColor || '#ffffff',
          shadow: new Shadow({ color: 'rgba(0,0,0,0.1)', blur: 15, offsetX: 0, offsetY: 0 }),
        });
      }

      // ✅ Update bleed zone visibility during transform
      objs.forEach((o: any) => {
        if (o[BLEED_KEY]) {
          o.set({ visible: isTransforming, opacity: 0.8 });
        }
        if (o[SAFE_KEY]) {
          o.set({ visible: true, opacity: isTransforming ? 0.4 : 0.8 });
        }
      });

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

      const bgObj = objs.find((o: any) => o[BG_KEY]);
      if (bgObj) bgObj.set({ fill: editingCanvas.bgColor || '#ffffff' });

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
      });

      fc.requestRenderAll();
      return;
    }

    // ── Full structural rebuild ──────────────────────────────────────────
    const gen = ++buildGenRef.current;

    fc.getObjects().forEach(o => fc.remove(o));
    fc.discardActiveObject();
    fc.backgroundColor = 'transparent';
    fc.set({ renderOnAddRemove: false });

    let zIndex = 0;

    const bgRect = new Rect({
      left: 0, top: 0,
      originX: 'left', originY: 'top',
      width: canvasW, height: canvasH,
      fill: editingCanvas.bgColor || '#ffffff',
      selectable: false, evented: false,
    });
    (bgRect as any)[BG_KEY] = true;
    fc.add(bgRect);
    fc.moveObjectTo(bgRect, zIndex++); 

    const frames = layout?.frames?.length > 0
      ? layout.frames
      : [{ x: 0, y: 0, width: canvasW, height: canvasH }];

    const frameZStart = zIndex; 
    
    // ── Safe Areas ──────────────────────────
    frames.forEach((frameSpec: any, frameIdx: number) => {
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
      const frMm = Number(frameSpec.borderRadiusMm || 0);
      const pxPerMm = canvasW / (layout?.canvas?.widthMm || 1);
      const fr = Math.min(fw / 2, fh / 2, frMm * pxPerMm);
      const sr = new Rect({
        left: fx, top: fy, width: fw, height: fh,
        fill: 'transparent', stroke: '#06b6d4', strokeWidth: 1.5, strokeDashArray: [6, 4],
        selectable: false, evented: false, opacity: isTransforming ? 0.4 : 0.8, rx: fr, ry: fr,
        strokeUniform: true,
      });
      (sr as any)[SAFE_KEY] = true;
      (sr as any).__frameIdx = frameIdx;
      fc.add(sr);
    });

    // ── Bleed Zones ──────────────────────────
    frames.forEach((frameSpec: any, frameIdx: number) => {
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
      const bleed = Number(frameSpec.bleedMm || 0);
      if (bleed <= 0) return;
      const pxPerMm = canvasW / (layout?.canvas?.widthMm || 1);
      const bleedPx = bleed * pxPerMm;
      const frMm = Number(frameSpec.borderRadiusMm || 0);
      const fr = Math.min(fw / 2, fh / 2, frMm * pxPerMm);
      const br = new Rect({
        left: fx - bleedPx, top: fy - bleedPx, width: fw + (bleedPx * 2), height: fh + (bleedPx * 2),
        fill: 'transparent', stroke: '#f43f5e', strokeWidth: 1.5, strokeDashArray: [8, 5],
        selectable: false, evented: false, visible: isTransforming, opacity: 0.8,
        rx: fr > 0 ? fr + bleedPx : 0, ry: fr > 0 ? fr + bleedPx : 0,
      });
      (br as any)[BLEED_KEY] = true;
      (br as any).__frameIdx = frameIdx;
      fc.add(br);
    });

    const loadFramePromises = editingCanvas.frames.map(async (frameState, frameIdx) => {
      const frameSpec = frames[frameIdx];
      if (!frameSpec || !frameState) return;
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
      const imgSource = frameState.originalFile ? getFileUrl(frameState.originalFile) : (frameState as any).url;
      if (!imgSource) return;
      try {
        const img = await FabricImage.fromURL(imgSource, { crossOrigin: 'anonymous' });
        if (buildGenRef.current !== gen) return;
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
        img.set({
          left: imgX + (imgW * scale) / 2, top: imgY + (imgH * scale) / 2,
          originX: 'center', originY: 'center',
          scaleX: scale, scaleY: scale, angle: frameState.rotation,
          selectable: true, hasControls: true,
          cornerColor: '#6366f1', cornerSize: 12, cornerStyle: 'circle',
          transparentCorners: false, borderColor: '#6366f1',
        });
        (img as any)[DATA_KEY] = 'frame';
        (img as any).__frameIdx = frameIdx;
        fc.add(img);
        fc.moveObjectTo(img, frameZStart + frameIdx);
      } catch (err) { console.error(err); }
    });

    // ── Center Guides & Grid ──
    const centerGuides = createCenterGuides(canvasW, canvasH);
    centerGuides.forEach((g, i) => {
      (g as any)[GUIDE_KEY] = true; g.visible = false; fc.add(g);
      fc.moveObjectTo(g, 1 + frames.length + i);
    });
    const gridLines = createGridLines(canvasW, canvasH, 50); 
    gridLines.forEach((l, i) => {
      (l as any)[GRID_KEY] = true; l.visible = false; fc.add(l);
      fc.moveObjectTo(l, 1 + frames.length + centerGuides.length + i);
    });
    const guidesCount = centerGuides.length + gridLines.length;

    // ── Paper Overlay ──
    const paperOverlay = new Path(getPaperPath(isTransforming), {
      left: 0, top: 0, originX: 'left', originY: 'top', fill: editingCanvas.paperColor || '#ffffff',
      selectable: false, evented: false, fillRule: 'evenodd',
      shadow: new Shadow({ color: 'rgba(0,0,0,0.12)', blur: 20, offsetX: 0, offsetY: 0 })
    });
    (paperOverlay as any)[PAPER_KEY] = true;
    fc.add(paperOverlay);
    const paperOverlayZ = 1 + frames.length + guidesCount + (frames.length * 2);
    fc.moveObjectTo(paperOverlay, paperOverlayZ);

    // ── Overlays ──
    const overlayZStart = paperOverlayZ + 1;
    const loadOverlayPromises = editingCanvas.overlays.map(async (overlay, oIdx) => {
      let fabricObj: FabricObject | null = null;
      if (overlay.type === 'text') {
        fabricObj = new Textbox(overlay.text, {
          left: (overlay.x / 100) * canvasW, top: (overlay.y / 100) * canvasH,
          originX: overlay.textAlign === 'left' ? 'left' : overlay.textAlign === 'right' ? 'right' : 'center',
          originY: 'center', fontSize: overlay.fontSize, fill: overlay.color || '#000000',
          fontFamily: overlay.fontFamily || 'sans-serif', textAlign: (overlay.textAlign || 'center') as any,
          width: canvasW * 0.8, editable: true, splitByGrapheme: true,
          cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle', transparentCorners: false, borderColor: '#f97316',
          angle: overlay.rotation || 0,
        });
        (fabricObj as any)[DATA_KEY] = 'text';
      } else if (overlay.type === 'shape') {
        fabricObj = makeShapeObject(overlay as any, canvasW, canvasH);
        if (fabricObj) (fabricObj as any)[DATA_KEY] = 'shape';
      } else if (overlay.type === 'image') {
        try {
          const img = await FabricImage.fromURL(overlay.src, { crossOrigin: 'anonymous' });
          if (buildGenRef.current !== gen) return;
          img.set({
            left: (overlay.x / 100) * canvasW, top: (overlay.y / 100) * canvasH,
            originX: 'left', originY: 'top', scaleX: ((overlay.width / 100) * canvasW) / (img.width || 1), scaleY: ((overlay.height / 100) * canvasH) / (img.height || 1),
            angle: overlay.rotation || 0, opacity: overlay.opacity ?? 1,
            cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle', transparentCorners: false, borderColor: '#10b981',
          });
          (img as any)[DATA_KEY] = 'image'; (img as any).__overlayIdx = oIdx;
          fc.add(img); fc.moveObjectTo(img, overlayZStart + oIdx);
          return;
        } catch (err) { console.error(err); return; }
      }
      if (fabricObj) {
        (fabricObj as any).__overlayIdx = oIdx; fc.add(fabricObj); fc.moveObjectTo(fabricObj, overlayZStart + oIdx);
      }
    });

    // ── Mask ──
    let maskPromise = Promise.resolve();
    if (layout?.maskUrl) {
      maskPromise = FabricImage.fromURL(layout.maskUrl).then(maskImg => {
        if (fc !== fabricRef.current || buildGenRef.current !== gen) return;
        maskImg.set({
          left: 0, top: 0, originX: 'left', originY: 'top', scaleX: canvasW / maskImg.width!, scaleY: canvasH / maskImg.height!,
          selectable: false, evented: false, opacity: 1,
        });
        (maskImg as any)[DATA_KEY] = 'mask'; fc.add(maskImg); fc.bringObjectToFront(maskImg);
      });
    }

    Promise.all([...loadFramePromises, ...loadOverlayPromises, maskPromise]).then(() => {
      if (fc !== fabricRef.current || buildGenRef.current !== gen) return;
      const { width: cW, height: cH } = containerSize;
      if (cW > 0 && cH > 0) fitZoomRef.current = centerCanvasViewport(fc, cW, cH, canvasW, canvasH, viewZoom);
      
      const objs = fc.getObjects();
      let targetObj: FabricObject | undefined;
      if (selectedLayer) {
        targetObj = objs.find((o: any) => selectedLayer.type === 'frame' ? o.__frameIdx === selectedLayer.index : o.__overlayIdx === selectedLayer.index);
      }
      if (!targetObj && editingCanvas.frames.length === 1 && editingCanvas.overlays.length === 0) {
        targetObj = objs.find((o: any) => o.__frameIdx === 0);
        if (targetObj) onLayerSelect({ type: 'frame', index: 0 });
      }
      if (targetObj) fc.setActiveObject(targetObj);
      fc.renderAll();
    });
  }, [editingCanvas, layout, canvasW, canvasH, getFileUrl, containerSize, isTransforming]);

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || containerSize.width === 0) return;
    fitZoomRef.current = centerCanvasViewport(fc, containerSize.width, containerSize.height, canvasW, canvasH, viewZoom);
    fc.requestRenderAll();
  }, [viewZoom, canvasW, canvasH, containerSize]);

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    const handleModified = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || !(target as any)[DATA_KEY]) return;
      const type = (target as any)[DATA_KEY] as string;
      const current = editingCanvasRef.current;
      setIsTransforming(false);

      if (type === 'frame') {
        const idx = (target as any).__frameIdx as number;
        const clip = (target as any).__clipRect;
        if (!clip) return;
        const newOffsetX = (target.left ?? 0) - (clip.fx + clip.fw / 2);
        const newOffsetY = (target.top ?? 0) - (clip.fy + clip.fh / 2);
        const newFrames = current.frames.map((f, i) => i !== idx ? f : { ...f, offset: { x: Math.abs(newOffsetX) < 8 ? 0 : newOffsetX, y: Math.abs(newOffsetY) < 8 ? 0 : newOffsetY }, rotation: Math.round(target.angle ?? f.rotation) });
        onCanvasChangeRef.current({ ...current, frames: newFrames });
      } else {
        const idx = (target as any).__overlayIdx as number;
        const newOverlays = current.overlays.map((o, i) => {
          if (i !== idx) return o;
          const common = { x: Math.round(((target.left ?? 0) / canvasW) * 1000) / 10, y: Math.round(((target.top ?? 0) / canvasH) * 1000) / 10, rotation: Math.round(target.angle ?? o.rotation) };
          if (o.type === 'text') return { ...o, ...common, text: (target as Textbox).text || o.text, fontSize: Math.round((target as Textbox).fontSize ?? o.fontSize) };
          const newW = (((target.width ?? 100) * (target.scaleX ?? 1)) / canvasW) * 100;
          const newH = (((target.height ?? 100) * (target.scaleY ?? 1)) / canvasH) * 100;
          return { ...o, ...common, width: Math.round(newW * 10) / 10, height: Math.round(newH * 10) / 10 };
        });
        onCanvasChangeRef.current({ ...current, overlays: newOverlays });
      }
    };

    const handleSelection = (e: any) => {
      const selected = e.selected?.[0];
      if (!selected || !(selected as any)[DATA_KEY]) {
        if (suppressSelectionEventsRef.current) return;
        onLayerSelect({ type: 'canvas', index: -1 }); return;
      }
      const type = (selected as any)[DATA_KEY];
      if (type === 'frame') onLayerSelectRef.current({ type: 'frame', index: (selected as any).__frameIdx });
      else if (['text', 'shape', 'image'].includes(type)) onLayerSelectRef.current({ type, index: (selected as any).__overlayIdx });
    };

    const handleTextChanged = (e: any) => {
      const target = e.target as Textbox;
      if (!target || (target as any).__overlayIdx === undefined || isEditingRef.current) return;
      const current = editingCanvasRef.current;
      const newOverlays = current.overlays.map((o, i) => (i !== (target as any).__overlayIdx || o.type !== 'text') ? o : { ...o, text: target.text || o.text });
      onCanvasChangeRef.current({ ...current, overlays: newOverlays });
    };

    const hideGuides = () => {
      const objs = fc.getObjects();
      let changed = false;
      objs.forEach(obj => { if (((obj as any)[GUIDE_KEY] || (obj as any)[GRID_KEY]) && obj.visible) { obj.set({ visible: false }); changed = true; } });
      if (changed) fc.requestRenderAll();
    };

    const handleMoving = () => {
      const objs = fc.getObjects();
      let changed = false;
      objs.forEach(obj => { if (((obj as any)[GUIDE_KEY] || (obj as any)[GRID_KEY]) && !obj.visible) { obj.set({ visible: true }); changed = true; } });
      if (!isTransforming) setIsTransforming(true);
      if (changed) fc.requestRenderAll();
    };

        const handleMouseUp = () => {
      interactingRef.current = false;
      setIsTransforming(false);
      hideGuides();
      if ((fc as any).__isPanning) {
        (fc as any).__isPanning = false; fc.selection = true;
        const newCursor = spacePressedRef.current ? 'grab' : 'default';
        fc.defaultCursor = newCursor; fc.setCursor(newCursor);
        fc.setViewportTransform(fc.viewportTransform!); fc.renderAll();
      }
    };

    fc.on('object:modified', (e) => { handleModified(e); hideGuides(); });
    fc.on('object:moving', handleMoving);
    fc.on('object:scaling', () => setIsTransforming(true));
    fc.on('object:rotating', () => setIsTransforming(true));
    fc.on('mouse:up', handleMouseUp);
    fc.on('selection:created', handleSelection);
    fc.on('selection:updated', handleSelection);
    fc.on('selection:cleared', handleSelection);
    fc.on('text:changed', handleTextChanged);
    fc.on('text:editing:entered', () => { isEditingRef.current = true; });
    fc.on('text:editing:exited', () => { isEditingRef.current = false; const active = fc.getActiveObject(); if (active) handleModified({ target: active }); });

    return () => {
      fc.off('object:modified'); fc.off('object:moving'); fc.off('object:scaling'); fc.off('object:rotating');
      fc.off('mouse:up'); fc.off('selection:created'); fc.off('selection:updated'); fc.off('selection:cleared');
      fc.off('text:changed'); fc.off('text:editing:entered'); fc.off('text:editing:exited');
    };
  }, [canvasW, canvasH]);

    useImperativeHandle(ref, () => ({
    toDataURL: (includeShadow = true) => {
      const fc = fabricRef.current;
      if (!fc) return null;
      const paperObj = fc.getObjects().find((o: any) => o[PAPER_KEY]);
      const originalShadow = paperObj?.shadow;
      if (paperObj && !includeShadow) {
        paperObj.set({ shadow: undefined });
        fc.renderAll();
      }
      const dataUrl = fc.toDataURL({ format: 'png', quality: 1, multiplier: 2 });
      if (paperObj && !includeShadow) {
        paperObj.set({ shadow: originalShadow });
        fc.renderAll();
      }
      return dataUrl;
    },
    toFullResDataURL: (includeShadow = true) => {
      const fc = fabricRef.current;
      if (!fc) return null;
      const paperObj = fc.getObjects().find((o: any) => o[PAPER_KEY]);
      const originalShadow = paperObj?.shadow;
      if (paperObj && !includeShadow) {
        paperObj.set({ shadow: undefined });
        fc.renderAll();
      }
      const dataUrl = fc.toDataURL({ format: 'png', quality: 1, multiplier: 4 });
      if (paperObj && !includeShadow) {
        paperObj.set({ shadow: originalShadow });
        fc.renderAll();
      }
      return dataUrl;
    },
    toMockupDataURL: () => {
      const fc = fabricRef.current;
      if (!fc) return null;
      const dataUrl = fc.toDataURL({ format: 'png', quality: 0.5, multiplier: 1 });
      return dataUrl;
    },
    getZoomToFit: () => fitZoomRef.current,
    getCanvasJSON: () => fabricRef.current?.toJSON() || null,
    loadCanvasJSON: async (json) => { if (fabricRef.current) await fabricRef.current.loadFromJSON(json); }
  }));

  return (
        <div ref={containerRef} className="w-full h-full relative overflow-hidden bg-[#f1f5f9] select-none">
      <canvas ref={canvasElRef} />
    </div>
  );
});
