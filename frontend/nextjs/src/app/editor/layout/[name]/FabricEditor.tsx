'use client';

// ── Dev-only logging helpers ──────────────────────────────────────────────────
// In production builds these are no-ops so the browser console stays clean and
// no internal layout geometry is exposed to end users.
const _DEV = process.env.NODE_ENV !== 'production';
const log              = _DEV ? (...a: unknown[]) => console.log(...a)             : (..._: unknown[]) => {};
const logGroup         = _DEV ? (...a: unknown[]) => console.group(...a)           : (..._: unknown[]) => {};
const logGroupCollapsed = _DEV ? (...a: unknown[]) => console.groupCollapsed(...a) : (..._: unknown[]) => {};
const logGroupEnd      = _DEV ? () => console.groupEnd()                       : () => {};

import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { computePinch, pointerDistance, pointerMidpoint, type PinchStart } from './pinch-utils';
import {
  Canvas, FabricImage, Textbox, Point, Path,
  Rect,
  Ellipse,
  Circle,
  Shadow,
  type FabricObject,
} from 'fabric';
import type { CanvasItem } from './types';
import { buildFrameFill, buildFrameCaption } from './frame-fill';
import type { LayerSelection } from './LayersPanel';
import { getShapeDef } from '@/lib/shape-catalog';
import {
  createShapeFromOverlay,
  centerCanvasViewport,
  createCenterGuides,
  createGridLines,
  updateRelativeClipPath,
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
  /** Two-finger pinch commits a frame scale+pan through this (Phase 3 —
   *  mobile). Wired by CanvasEditorModal to handleUpdateTransform. */
  onPinchTransform?: (frameIdx: number, updates: { scale: number; x: number; y: number }) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_KEY    = '__fabricEditor';
const PAPER_KEY   = '__paper';
const OUTLINE_KEY = '__outlineLayer';
const BG_KEY      = '__bgLayer';
const GUIDE_KEY   = '__guideLayer';
const GRID_KEY    = '__gridLayer';
const BLEED_KEY   = '__bleedLayer';
const SAFE_KEY    = '__safeLayer';

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
    if (_DEV) log('Shape Overlay Calculation (In-place Update):', { overlay, sx, sy, sw, sh });
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
    const left = (overlay.x / 100) * canvasW;
    const top = (overlay.y / 100) * canvasH;
    if (_DEV) log('Image Overlay Calculation (In-place Update):', { overlay, left, top });
    obj.set({
      left,
      top,
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
  onPinchTransform,
}, ref) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 });
  const [isTransforming, setIsTransforming] = React.useState(false);
  const fabricRef = useRef<Canvas | null>(null);
  const editingCanvasRef = useRef(editingCanvas);
  // Refs must be written from an effect, not synchronously during render
  // (React 19 / concurrent rendering can call render twice — the second pass
  // would see a ref value pulled from the first pass before commit). Effects
  // run before any event handler, so `editingCanvasRef.current` is always
  // current by the time a Fabric event callback fires.
  useEffect(() => {
    editingCanvasRef.current = editingCanvas;
  });

  // Guards to prevent rebuild loops
  const interactingRef = useRef(false);
  const isEditingRef = useRef(false);       // TRUE while Fabric inline text editing is active
  const buildGenRef = useRef(0);

  // ── Pinch-zoom (Phase 3 — mobile) ─────────────────────────────────────────
  // Fabric 7 discards the second touch entirely (mainTouchId gate), so pinch
  // did nothing on phones. We track pointers ourselves via React props on the
  // container (pointer events bubble up from Fabric's canvas); when two land,
  // Fabric's own drag is suspended and the gesture drives FrameState through
  // onPinchTransform — the same state path as the sidebar Zoom slider.
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ frameIdx: number; start: PinchStart } | null>(null);
  const pinchRafRef = useRef<number | null>(null);
  const gestureActiveRef = useRef(false);

  const handlePinchPointerDown = (e: React.PointerEvent) => {
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointersRef.current.size === 2 && onPinchTransform) {
      const [p1, p2] = Array.from(activePointersRef.current.values());
      // Target: the selected frame, else frame 0 (single-frame products are
      // the dominant mobile case).
      const frameIdx = selectedLayer?.type === 'frame' ? selectedLayer.index : 0;
      const frame = editingCanvasRef.current.frames[frameIdx];
      if (!frame) return;
      const fc = fabricRef.current;
      // Stop Fabric's primary-pointer object drag from fighting the gesture.
      fc?.discardActiveObject();
      if (fc) fc.selection = false;
      gestureActiveRef.current = true;
      pinchRef.current = {
        frameIdx,
        start: {
          distance: pointerDistance(p1, p2),
          midpoint: pointerMidpoint(p1, p2),
          frameScale: frame.scale,
          frameOffset: { ...frame.offset },
        },
      };
    }
  };

  const handlePinchPointerMove = (e: React.PointerEvent) => {
    if (!activePointersRef.current.has(e.pointerId)) return;
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinchRef.current || activePointersRef.current.size < 2 || !onPinchTransform) return;
    if (pinchRafRef.current != null) return; // one commit per animation frame
    pinchRafRef.current = requestAnimationFrame(() => {
      pinchRafRef.current = null;
      const pts = Array.from(activePointersRef.current.values());
      const pinch = pinchRef.current;
      if (pts.length < 2 || !pinch) return;
      const result = computePinch(
        pinch.start,
        { distance: pointerDistance(pts[0], pts[1]), midpoint: pointerMidpoint(pts[0], pts[1]) },
        fabricRef.current?.getZoom() || viewZoom || 1,
      );
      onPinchTransform(pinch.frameIdx, result);
    });
  };

  const endPinchPointer = (e: React.PointerEvent) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2 && pinchRef.current) {
      pinchRef.current = null;
      gestureActiveRef.current = false;
      const fc = fabricRef.current;
      if (fc) fc.selection = true;
    }
  };
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
  const prevLayoutNameRef = useRef<string>('');
  const prevIsTransformingRef = useRef(false);
  const prevFillSigRef = useRef<string>('');

  // ✅ Helper to generate paper overlay path string (punched holes)
  const getPaperPath = useCallback((isTransforming: boolean) => {
    let path = `M 0 0 L ${canvasW} 0 L ${canvasW} ${canvasH} L 0 ${canvasH} Z`;
    const frames = layout?.frames?.length > 0
      ? layout.frames
      : [{ x: 0, y: 0, width: canvasW, height: canvasH }];

    frames.forEach((frameSpec: any, _fIdx: number) => {
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

      // Round all coordinates to avoid floating point precision issues in SVG path strings
      fx = Math.round(fx * 10) / 10;
      fy = Math.round(fy * 10) / 10;
      fw = Math.round(fw * 10) / 10;
      fh = Math.round(fh * 10) / 10;

      const fr = Math.round(Math.min(fw / 2, fh / 2, frMm * pxPerMm) * 10) / 10;

      if (_DEV) {
        log(
          `[getPaperPath] Frame[${_fIdx}]:`,
          `isPercent=${isPercent} | isTransforming=${isTransforming}`,
          `| raw=(x:${frameSpec.x}, y:${frameSpec.y}, w:${frameSpec.width}, h:${frameSpec.height})`,
          `| hole px=(x:${fx}, y:${fy}, w:${fw}, h:${fh})`,
          `| coverage=${(fw / canvasW * 100).toFixed(1)}%×${(fh / canvasH * 100).toFixed(1)}%`,
          `| pxPerMm=${pxPerMm.toFixed(3)} bleed=${bleed}mm fr=${fr}px`,
        );
      }

      if (fr > 0) {
        // Punched-out rounded rect (A command for arcs)
        // Optimization: skip zero-length lines when fr is exactly half the width/height (circle)
        // Winding order: CCW (Top-Left -> Bottom-Left -> Bottom-Right -> Top-Right)
        const leftBar = fh - 2 * fr > 0.1 ? ` L ${fx} ${fy + fh - fr}` : '';
        const bottomBar = fw - 2 * fr > 0.1 ? ` L ${fx + fw - fr} ${fy + fh}` : '';
        const rightBar = fh - 2 * fr > 0.1 ? ` L ${fx + fw} ${fy + fr}` : '';
        const topBar = fw - 2 * fr > 0.1 ? ` L ${fx + fr} ${fy}` : '';

        path += ` M ${fx + fr} ${fy} A ${fr} ${fr} 0 0 0 ${fx} ${fy + fr}${leftBar} A ${fr} ${fr} 0 0 0 ${fx + fr} ${fy + fh}${bottomBar} A ${fr} ${fr} 0 0 0 ${fx + fw} ${fy + fh - fr}${rightBar} A ${fr} ${fr} 0 0 0 ${fx + fw - fr} ${fy} Z`;
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

    log(
      '[FabricEditor] Canvas element created | logical size: %d×%d px | clipPath: absolutePositioned=false',
      canvasW, canvasH,
    );

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
        fc.__isPanning = true;
        fc.selection = false; // Disable selection box while panning
        fc.defaultCursor = 'grabbing';
        fc.setCursor('grabbing');
      }
    });
    fc.on('mouse:move', (opt) => {
      if (fc.__isPanning) {
        const me = opt.e as MouseEvent;
        // ✅ Use Fabric's built-in relativePan instead of manual viewportTransform mutation
        fc.relativePan(new Point(me.movementX ?? 0, me.movementY ?? 0));
        fc.setViewportTransform(fc.viewportTransform!); // Force recalc of clipPath and bbox cache
        fc.renderAll(); // Force visual update to avoid delay
      }
    });
    fc.on('mouse:up', () => {
      interactingRef.current = false;
      if (fc.__isPanning) {
        fc.__isPanning = false;
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
    // Mount-once init: canvasW/canvasH/viewZoom are read at init time only.
    // Adding them to deps would tear down + rebuild the Fabric.js canvas
    // every time the user pans/zooms — exactly the behaviour we don't want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Smart rebuild or in-place update ──────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || containerSize.width === 0) return;

    if (isEditingRef.current) return;

    const currentOverlayCount = editingCanvas.overlays.length;
    const currentFrameCount = editingCanvas.frames.length;
    const currentTypeSig = editingCanvas.overlays.map(o => o.type).join(',');
    const currentLayoutName = layout?.name || '';
    // Fill/caption changes don't alter frame/overlay counts, so without this
    // they'd slip through as an in-place update and never add/remove the fill
    // object. Fold fitMode + fillStyle + caption into the rebuild signature.
    const currentFillSig = editingCanvas.frames
      .map(f => `${f.fitMode}:${f.fillStyle || ''}:${f.captionEnabled ? 1 : 0}:${(f.caption || '').trim().length}`)
      .join('|');

    const needsFullRebuild =
      currentOverlayCount !== prevOverlayCountRef.current ||
      currentFrameCount !== prevFrameCountRef.current ||
      currentTypeSig !== prevOverlayTypesRef.current ||
      currentLayoutName !== prevLayoutNameRef.current ||
      currentFillSig !== prevFillSigRef.current;

    const transformChanged = isTransforming !== prevIsTransformingRef.current;

    prevOverlayCountRef.current = currentOverlayCount;
    prevFrameCountRef.current = currentFrameCount;
    prevOverlayTypesRef.current = currentTypeSig;
    prevLayoutNameRef.current = currentLayoutName;
    prevIsTransformingRef.current = isTransforming;
    prevFillSigRef.current = currentFillSig;

    // ── Canvas Build Debug Summary (dev only) ───────────────────────────────
    // Gated explicitly: `log()` is a no-op in prod but JS still evaluates the
    // arguments at the call site — JSON.stringify(layout) and the per-frame
    // forEach below would otherwise run on every editingCanvas tick (i.e.
    // every keystroke + every drag frame). For a 12-frame layout that's
    // ~0.5–2 ms of pure dead computation per effect run.
    if (_DEV) {
      const _pxPerMm = canvasW / (layout?.canvas?.widthMm || 1);
      logGroupCollapsed(
        `[FabricEditor] Render | canvas=${canvasW}×${canvasH}px | frames=${editingCanvas.frames.length} | overlays=${editingCanvas.overlays.length} | needsFullRebuild=${needsFullRebuild}`,
      );
      log('Canvas logical WxH (used):', canvasW, '×', canvasH,
        '| from props:', canvasWidth, '×', canvasHeight,
        '| from layout.canvas:', layout?.canvas?.width, '×', layout?.canvas?.height);
      log('layout.canvas object:', JSON.stringify(layout?.canvas));
      log('pxPerMm:', _pxPerMm.toFixed(3), '(canvasW / widthMm =', canvasW, '/', layout?.canvas?.widthMm, ')');
      log('layout.frames:', JSON.stringify(layout?.frames));
      if (Array.isArray(layout?.frames) && layout.frames.length > 0) {
        (layout.frames as any[]).forEach((f: any, i: number) => {
          const _isP = f.width <= 1 && f.height <= 1;
          const _fx = _isP ? f.x * canvasW : f.x;
          const _fy = _isP ? f.y * canvasH : f.y;
          const _fw = _isP ? f.width * canvasW : f.width;
          const _fh = _isP ? f.height * canvasH : f.height;
          log(
            `  Frame[${i}]: isPercent=${_isP}`,
            `| raw=(x:${f.x}, y:${f.y}, w:${f.width}, h:${f.height})`,
            `| px=(x:${_fx.toFixed(1)}, y:${_fy.toFixed(1)}, w:${_fw.toFixed(1)}, h:${_fh.toFixed(1)})`,
            `| % of canvas: ${(_fw / canvasW * 100).toFixed(1)}% wide × ${(_fh / canvasH * 100).toFixed(1)}% tall`,
          );
        });
      }
      logGroupEnd();
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!needsFullRebuild) {
      // ── #3 In-place property update ─────────────
      if (_DEV) {
        log(
          `[FabricEditor] ↻ In-place update | canvas=${canvasW}×${canvasH}px | transformChanged=${transformChanged} | isTransforming=${isTransforming} | frames=${editingCanvas.frames.length} | overlays=${editingCanvas.overlays.length}`,
        );
      }
      const objs = fc.getObjects();

      // ✅ Update paper overlay in-place if transform status changed
      const paperObj = objs.find((o: any) => o[PAPER_KEY]) as Path;
      if (paperObj) {
        if (transformChanged || !paperObj.path) {
          // Use Path constructor to parse string into array of commands to avoid TypeError in toDataURL/toJSON
          const updatedPath = getPaperPath(isTransforming);
          if (_DEV) log(`  [Paper In-place] transformChanged=${transformChanged} | path (first 80 chars): "${updatedPath.substring(0, 80)}..."`);
          const tempPath = new Path(updatedPath);
          paperObj.set({ path: tempPath.path });
        }
        paperObj.set({
          fill: editingCanvas.paperColor || '#ffffff',
          shadow: isTransforming 
            ? new Shadow({ color: 'rgba(0,0,0,0.15)', blur: 25, offsetX: 0, offsetY: 0 }) 
            : undefined,
        });
      }

      // ✅ Update bleed zone visibility during transform
      objs.forEach((o: any) => {
        if (o[BLEED_KEY]) {
          if (_DEV) log(`  [Bleed update] Frame[${o.__frameIdx ?? '?'}] visible=${isTransforming} opacity=0.5`);
          o.set({ visible: isTransforming, opacity: 0.5 });
        }
        if (o[SAFE_KEY]) {
          const _safeOpacity = isTransforming ? 0.25 : 0.45;
          if (_DEV) log(`  [SafeZone update] Frame[${o.__frameIdx ?? '?'}] opacity=${_safeOpacity}`);
          o.set({ visible: true, opacity: _safeOpacity });
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
        .filter((o: any) => o.__fabricEditor === 'frame')
        .sort((a: any, b: any) => a.__frameIdx - b.__frameIdx);

      editingCanvas.frames.forEach((frameState, idx) => {
        const img = frameObjs.find((o: any) => o.__frameIdx === idx) as FabricImage;
        if (!img) return;

        const clip = img.__clipRect as { fx: number; fy: number; fw: number; fh: number };
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

        if (_DEV) {
          log('Frame Image Calculation (In-place Update):', {
            frameState, clip, imgW, imgH, scale, imgX, imgY,
            left: imgX + (imgW * scale) / 2,
            top: imgY + (imgH * scale) / 2,
          });
        }

        img.set({
          left: imgX + (imgW * scale) / 2,
          top: imgY + (imgH * scale) / 2,
          scaleX: scale, scaleY: scale,
          angle: frameState.rotation,
        });
        updateRelativeClipPath(img, clip.fx, clip.fy, clip.fw, clip.fh);
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

    if (_DEV) {
      logGroup(`[FabricEditor] 🔨 Full Rebuild (gen=${gen}) | canvas=${canvasW}×${canvasH}px | frames=${editingCanvas.frames.length} | overlays=${editingCanvas.overlays.length}`);
      log('bgColor:', editingCanvas.bgColor || '#ffffff', '| paperColor:', editingCanvas.paperColor || '#ffffff');
      log('layout.canvas:', JSON.stringify(layout?.canvas));
      log('layout.maskUrl:', layout?.maskUrl ?? '(none)');
    }

    let zIndex = 0;

    const bgRect = new Rect({
      left: 0, top: 0,
      originX: 'left', originY: 'top',
      width: canvasW, height: canvasH,
      fill: editingCanvas.bgColor || '#ffffff',
      selectable: false, evented: false,
    });
    bgRect.__bgLayer = true;
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

      if (_DEV) {
        log(
          `  [SafeZone Frame ${frameIdx}]`,
          `isPercent=${isPercent}`,
          `| raw: x=${frameSpec.x} y=${frameSpec.y} w=${frameSpec.width} h=${frameSpec.height}`,
          `| px: x=${fx.toFixed(1)} y=${fy.toFixed(1)} w=${fw.toFixed(1)} h=${fh.toFixed(1)}`,
          `| canvas coverage: ${(fw / canvasW * 100).toFixed(1)}% wide × ${(fh / canvasH * 100).toFixed(1)}% tall`,
          `| pxPerMm=${pxPerMm.toFixed(3)} borderRadius=${fr.toFixed(1)}px`,
        );
      }

      // ✅ Safe Zone Guide
      const sr = (fr > fw / 2 - 1 && fr > fh / 2 - 1)
        ? new Ellipse({
            left: fx, top: fy, originX: 'left', originY: 'top', rx: fw / 2, ry: fh / 2,
            fill: 'transparent', stroke: '#0f172a', strokeWidth: 2, strokeDashArray: [4, 3],
            selectable: false, evented: false, opacity: isTransforming ? 0.4 : 0.7,
            strokeUniform: true,
          })
        : new Rect({
            left: fx, top: fy, originX: 'left', originY: 'top', width: fw, height: fh,
            fill: 'transparent', stroke: '#0f172a', strokeWidth: 2, strokeDashArray: [4, 3],
            selectable: false, evented: false, opacity: isTransforming ? 0.4 : 0.7, rx: fr, ry: fr,
            strokeUniform: true,
          });
      sr.__safeLayer = true;
      sr.__frameIdx = frameIdx;
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

      if (_DEV) {
        log('Bleed Zone Calculation:', {
          frameSpec, canvasW, canvasH, isPercent,
          fx, fy, fw, fh, bleed, pxPerMm, bleedPx, fr,
        });
      }

      // ✅ Bleed Zone Guide
      const br = (fr > fw / 2 - 1 && fr > fh / 2 - 1)
        ? new Ellipse({
            left: fx - bleedPx, top: fy - bleedPx, originX: 'left', originY: 'top', rx: fw / 2 + bleedPx, ry: fh / 2 + bleedPx,
            fill: 'transparent', stroke: '#450a0a', strokeWidth: 2, strokeDashArray: [6, 4],
            selectable: false, evented: false, visible: isTransforming, opacity: 0.8,
            strokeUniform: true,
          })
        : new Rect({
            left: fx - bleedPx, top: fy - bleedPx, originX: 'left', originY: 'top', width: fw + (bleedPx * 2), height: fh + (bleedPx * 2),
            fill: 'transparent', stroke: '#450a0a', strokeWidth: 2, strokeDashArray: [6, 4],
            selectable: false, evented: false, visible: isTransforming, opacity: 0.8,
            rx: fr > 0 ? fr + bleedPx : 0, ry: fr > 0 ? fr + bleedPx : 0,
            strokeUniform: true,
          });
      br.__bleedLayer = true;
      br.__frameIdx = frameIdx;
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
        const rot = frameState.rotation || 0;
        const rad = (rot * Math.PI) / 180;
        const sinA = Math.abs(Math.sin(rad));
        const cosA = Math.abs(Math.cos(rad));
        const effW = imgW * cosA + imgH * sinA;
        const effH = imgW * sinA + imgH * cosA;

        let scale = frameState.scale;
        if (frameState.fitMode === 'contain' || frameState.fitMode === 'cover') {
          const sX = fw / effW;
          const sY = fh / effH;
          const baseScale = frameState.fitMode === 'contain' ? Math.min(sX, sY) : Math.max(sX, sY);
          scale = baseScale * frameState.scale;
        }
        img.__clipRect = { fx, fy, fw, fh };
        const w = effW * scale;
        const h = effH * scale;
        const imgX = fx + (fw - w) / 2 + frameState.offset.x;
        const imgY = fy + (fh - h) / 2 + frameState.offset.y;

        // ✅ Add clipPath to images in editor for robust circular/rounded layout support
        const pxPerMm = canvasW / (layout?.canvas?.widthMm || 1);
        const frMm = Number(frameSpec.borderRadiusMm || 0);
        const fr = Math.min(fw / 2, fh / 2, frMm * pxPerMm);
        const clipRect = new Rect({
          left: 0, top: 0, width: fw, height: fh,
          originX: 'center', originY: 'center',
          rx: fr, ry: fr,
        });

        img.set({
          left: imgX + w / 2, top: imgY + h / 2,
          originX: 'center', originY: 'center',
          scaleX: scale, scaleY: scale, angle: rot,
          selectable: true, hasControls: true,
          cornerColor: '#6366f1', cornerSize: 12, cornerStyle: 'circle',
          transparentCorners: false, borderColor: '#6366f1',
          clipPath: clipRect,
        });
        updateRelativeClipPath(img, fx, fy, fw, fh);
        img.__fabricEditor = 'frame';
        img.__frameIdx = frameIdx;
        fc.add(img);
        fc.moveObjectTo(img, frameZStart + frameIdx);

        // Fill sides (blur/border) behind the photo + optional caption above,
        // built by the SAME shared helper as the thumbnail/print renderer
        // (frame-fill.ts) so the live editor can't drift from the output.
        // Added here (float to top); final z-order is set in the Promise.all
        // below, relative to each photo — see "Fill / caption z-order".
        const _geom = { fx, fy, fw, fh, fr };
        const fillObj = buildFrameFill(
          frameState, _geom, imgW, imgH,
          img.getElement() as CanvasImageSource, editingCanvas.paperColor,
        );
        if (fillObj) {
          (fillObj as any).__fabricEditor = 'frameFill';
          (fillObj as any).__frameIdx = frameIdx;
          fc.add(fillObj);
        }
        const captionObj = buildFrameCaption(
          frameState, _geom, Boolean((layout as any)?.frameCaptionsEnabled),
        );
        if (captionObj) {
          (captionObj as any).__fabricEditor = 'frameCaption';
          (captionObj as any).__frameIdx = frameIdx;
          fc.add(captionObj);
        }
      } catch (err) { console.error(err); }
    });

    // ── Center Guides & Grid ──
    const centerGuides = createCenterGuides(canvasW, canvasH);
    centerGuides.forEach((g, i) => {
      g.__guideLayer = true; g.visible = false; fc.add(g);
      fc.moveObjectTo(g, 1 + frames.length + i);
    });
    const gridLines = createGridLines(canvasW, canvasH, 50); 
    gridLines.forEach((l, i) => {
      l.__gridLayer = true; l.visible = false; fc.add(l);
      fc.moveObjectTo(l, 1 + frames.length + centerGuides.length + i);
    });
    const guidesCount = centerGuides.length + gridLines.length;

    // ── Paper Overlay ──
    const _paperPathStr = getPaperPath(isTransforming);
    if (_DEV) {
      log(
        `  [Paper Overlay] fill=${editingCanvas.paperColor || '#ffffff'} | fillRule=evenodd | isTransforming=${isTransforming}`,
        `| path (first 120 chars): "${_paperPathStr.substring(0, 120)}..."`,
      );
    }
    const paperOverlay = new Path(_paperPathStr, {
      left: 0, top: 0, originX: 'left', originY: 'top', fill: editingCanvas.paperColor || '#ffffff',
      selectable: false, evented: false, fillRule: 'evenodd',
      shadow: isTransforming 
        ? new Shadow({ color: 'rgba(0,0,0,0.15)', blur: 25, offsetX: 0, offsetY: 0 }) 
        : undefined
    });
    paperOverlay.__paper = true;
    fc.add(paperOverlay);
    log(`  [Paper Overlay] added to canvas | path commands: ${(paperOverlay.path as any[])?.length ?? 'n/a'}`);
    const paperOverlayZ = 1 + frames.length + guidesCount + (frames.length * 2);
    fc.moveObjectTo(paperOverlay, paperOverlayZ);

    // ── Frame shape outlines — visible boundary indicator ────────────────────
    // Stroke-only rects drawn above the paper mask so the product shape is
    // always visible regardless of bg/paper color. No fill, no shadow, no glow.
    const outlineStrokeW = Math.max(1, Math.round(canvasW * 0.0025));
    frames.forEach((frameSpec: any) => {
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvasW : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvasH : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
      const pxPerMm = canvasW / (layout?.canvas?.widthMm || 1);
      const fr = Math.min(fw / 2, fh / 2, Number(frameSpec.borderRadiusMm || 0) * pxPerMm);
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
      outlineRect.__outlineLayer = true;
      fc.add(outlineRect);
      fc.moveObjectTo(outlineRect, paperOverlayZ + 1);
    });

    // ── Overlays ──
    const overlayZStart = paperOverlayZ + 1;
    const loadOverlayPromises = editingCanvas.overlays.map(async (overlay, oIdx) => {
      let fabricObj: FabricObject | null = null;
      if (overlay.type === 'text') {
        const left = (overlay.x / 100) * canvasW;
        const top = (overlay.y / 100) * canvasH;
        if (_DEV) log('Text Overlay Calculation (Full Rebuild):', { overlay, left, top });
        fabricObj = new Textbox(overlay.text, {
          left, top,
          originX: overlay.textAlign === 'left' ? 'left' : overlay.textAlign === 'right' ? 'right' : 'center',
          originY: 'center', fontSize: overlay.fontSize, fill: overlay.color || '#000000',
          fontFamily: overlay.fontFamily || 'sans-serif', textAlign: (overlay.textAlign || 'center') as any,
          width: canvasW * 0.8, editable: true, splitByGrapheme: true,
          cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle', transparentCorners: false, borderColor: '#f97316',
          angle: overlay.rotation || 0,
        });
        fabricObj.__fabricEditor = 'text';
      } else if (overlay.type === 'shape') {
        fabricObj = makeShapeObject(overlay as any, canvasW, canvasH);
        if (fabricObj) {
          if (_DEV) log('Shape Overlay Calculation (Full Rebuild):', { overlay, fabricObj });
          fabricObj.__fabricEditor = 'shape';
        }
      } else if (overlay.type === 'image') {
        try {
          const img = await FabricImage.fromURL(overlay.src, { crossOrigin: 'anonymous' });
          if (buildGenRef.current !== gen) return;
          const left = (overlay.x / 100) * canvasW;
          const top = (overlay.y / 100) * canvasH;
          log('Image Overlay Calculation (Full Rebuild):', { overlay, left, top });
          img.set({
            left, top,
            originX: 'left', originY: 'top', scaleX: ((overlay.width / 100) * canvasW) / (img.width || 1), scaleY: ((overlay.height / 100) * canvasH) / (img.height || 1),
            angle: overlay.rotation || 0, opacity: overlay.opacity ?? 1,
            cornerColor: '#6366f1', cornerSize: 14, cornerStyle: 'circle', transparentCorners: false, borderColor: '#10b981',
          });
          img.__fabricEditor = 'image'; img.__overlayIdx = oIdx;
          fc.add(img); fc.moveObjectTo(img, overlayZStart + oIdx);
          return;
        } catch (err) { console.error(err); return; }
      }
      if (fabricObj) {
        fabricObj.__overlayIdx = oIdx; fc.add(fabricObj); fc.moveObjectTo(fabricObj, overlayZStart + oIdx);
      }
    });

    // ── Mask ──
    let maskPromise = Promise.resolve();
    if (layout?.maskUrl) {
      log(`  [Mask] Loading from: ${layout.maskUrl}`);
      maskPromise = FabricImage.fromURL(layout.maskUrl).then(maskImg => {
        if (fc !== fabricRef.current || buildGenRef.current !== gen) return;
        const scaleX = canvasW / maskImg.width!;
        const scaleY = canvasH / maskImg.height!;
        log(
          `  [Mask] Loaded: naturalSize=${maskImg.width}×${maskImg.height}px`,
          `→ scaled to ${canvasW}×${canvasH}px (scaleX=${scaleX.toFixed(3)}, scaleY=${scaleY.toFixed(3)})`,
        );
        maskImg.set({
          left: 0, top: 0, originX: 'left', originY: 'top', scaleX, scaleY,
          selectable: false, evented: false, opacity: 1,
        });
        maskImg.__fabricEditor = 'mask'; fc.add(maskImg); fc.bringObjectToFront(maskImg);
      });
    } else {
      log('  [Mask] No maskUrl — skipping mask overlay');
    }

    Promise.all([...loadFramePromises, ...loadOverlayPromises, maskPromise]).then(() => {
      if (fc !== fabricRef.current || buildGenRef.current !== gen) return;

      // ── Fill / caption z-order ──────────────────────────────────────────────
      // Slot each frame's fill directly BELOW its photo and its caption directly
      // ABOVE, using the photo's LIVE index so we never disturb the carefully
      // ordered guide / paper / outline / mask layers stacked above the frames.
      const findFramePhoto = (idx: number) => fc.getObjects().find(
        (o: any) => o.__fabricEditor === 'frame' && o.__frameIdx === idx,
      );
      fc.getObjects()
        .filter((o: any) => o.__fabricEditor === 'frameFill')
        .forEach((fill) => {
          const photo = findFramePhoto((fill as any).__frameIdx);
          if (photo) fc.moveObjectTo(fill, fc.getObjects().indexOf(photo));
        });
      fc.getObjects()
        .filter((o: any) => o.__fabricEditor === 'frameCaption')
        .forEach((cap) => {
          const photo = findFramePhoto((cap as any).__frameIdx);
          if (photo) fc.moveObjectTo(cap, fc.getObjects().indexOf(photo) + 1);
        });

      logGroupEnd(); // close 🔨 Full Rebuild group
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
    // The smart-rebuild effect is keyed on canvas CONTENT (editingCanvas /
    // layout / dimensions / containerSize / isTransforming). Selection
    // (selectedLayer/onLayerSelect) and viewport (viewZoom/getPaperPath)
    // are intentionally NOT in the dep array — selection changes shouldn't
    // re-build the canvas, and viewport changes are handled by the
    // dedicated effect below (line ~905).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // A pinch owns the transform — Fabric's stale object:modified from the
      // abandoned single-finger drag must not clobber the gesture result.
      if (gestureActiveRef.current) return;
      const target = e.target as FabricObject;
      if (!target || !target.__fabricEditor) return;
      const type = target.__fabricEditor as string;
      const current = editingCanvasRef.current;
      setIsTransforming(false);

      if (type === 'frame') {
        const idx = target.__frameIdx as number;
        const clip = target.__clipRect;
        if (!clip) return;
        const newOffsetX = (target.left ?? 0) - (clip.fx + clip.fw / 2);
        const newOffsetY = (target.top ?? 0) - (clip.fy + clip.fh / 2);
        const newFrames = current.frames.map((f, i) => i !== idx ? f : { ...f, offset: { x: Math.abs(newOffsetX) < 8 ? 0 : newOffsetX, y: Math.abs(newOffsetY) < 8 ? 0 : newOffsetY }, rotation: Math.round(target.angle ?? f.rotation) });
        onCanvasChangeRef.current({ ...current, frames: newFrames });
      } else {
        const idx = target.__overlayIdx as number;
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
      if (!selected || !selected.__fabricEditor) {
        if (suppressSelectionEventsRef.current) return;
        onLayerSelect({ type: 'canvas', index: -1 }); return;
      }
      const type = selected.__fabricEditor;
      if (type === 'frame') onLayerSelectRef.current({ type: 'frame', index: selected.__frameIdx });
      else if (['text', 'shape', 'image'].includes(type)) onLayerSelectRef.current({ type, index: selected.__overlayIdx });
    };

    const handleTextChanged = (e: any) => {
      const target = e.target as Textbox;
      if (!target || target.__overlayIdx === undefined || isEditingRef.current) return;
      const current = editingCanvasRef.current;
      const newOverlays = current.overlays.map((o, i) => (i !== target.__overlayIdx || o.type !== 'text') ? o : { ...o, text: target.text || o.text });
      onCanvasChangeRef.current({ ...current, overlays: newOverlays });
    };

    const hideGuides = () => {
      const objs = fc.getObjects();
      let changed = false;
      objs.forEach(obj => { if ((obj.__guideLayer || obj.__gridLayer) && obj.visible) { obj.set({ visible: false }); changed = true; } });
      if (changed) fc.requestRenderAll();
    };

    const handleMoving = (e: { target?: FabricObject } = {}) => {
      // Frame images carry an image-local clipPath that defines the visible
      // window through the frame. Fabric updates left/top in real time during
      // drag, so the clipPath (anchored at image-local origin) drifts with
      // the image — without recomputing it, the user sees the same cropped
      // center of the image throughout the drag instead of the image scrolling
      // through a fixed frame window.
      const target = e.target;
      if (target?.__fabricEditor === 'frame' && target.__clipRect) {
        const clip = target.__clipRect;
        updateRelativeClipPath(target, clip.fx, clip.fy, clip.fw, clip.fh);
      }

      const objs = fc.getObjects();
      let changed = false;
      objs.forEach(obj => { if ((obj.__guideLayer || obj.__gridLayer) && !obj.visible) { obj.set({ visible: true }); changed = true; } });
      if (!isTransforming) setIsTransforming(true);
      if (changed) fc.requestRenderAll();
    };

    const handleScalingOrRotating = (e: { target?: FabricObject } = {}) => {
      // Same reason as handleMoving: scale/rotate also invalidate the
      // image-local clipPath placement.
      const target = e.target;
      if (target?.__fabricEditor === 'frame' && target.__clipRect) {
        const clip = target.__clipRect;
        updateRelativeClipPath(target, clip.fx, clip.fy, clip.fw, clip.fh);
      }
      if (!isTransforming) setIsTransforming(true);
    };

        const handleMouseUp = () => {
      interactingRef.current = false;
      setIsTransforming(false);
      hideGuides();
      if (fc.__isPanning) {
        fc.__isPanning = false; fc.selection = true;
        const newCursor = spacePressedRef.current ? 'grab' : 'default';
        fc.defaultCursor = newCursor; fc.setCursor(newCursor);
        fc.setViewportTransform(fc.viewportTransform!); fc.renderAll();
      }
    };

    fc.on('object:modified', (e) => { handleModified(e); hideGuides(); });
    fc.on('object:moving', handleMoving);
    fc.on('object:scaling', handleScalingOrRotating);
    fc.on('object:rotating', handleScalingOrRotating);
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
    // Event-handler binding effect — re-runs only on canvas size change.
    // The handlers close over `isTransforming` + `onLayerSelect` deliberately:
    // re-binding on every state flip would cause Fabric to lose mid-drag
    // state. The latest values are captured via refs (editingCanvasRef etc.)
    // for cases where a handler genuinely needs a fresh closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <div
      ref={containerRef}
      className="w-full h-full relative overflow-hidden bg-[#f1f5f9] select-none touch-none"
      onPointerDown={handlePinchPointerDown}
      onPointerMove={handlePinchPointerMove}
      onPointerUp={endPinchPointer}
      onPointerCancel={endPinchPointer}
    >
      <canvas ref={canvasElRef} />
    </div>
  );
});
