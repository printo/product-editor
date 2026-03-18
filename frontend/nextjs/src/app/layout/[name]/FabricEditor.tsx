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
      `${f.processedUrl || 'orig'}_${f.fitMode}_${f.rotation}_${f.scale}_${f.offset.x}_${f.offset.y}`
    ).join('|');
    const textParts = c.textOverlays.map(t =>
      `${t.text}_${t.x}_${t.y}_${t.fontSize}_${t.color}_${t.fontFamily}_${t.textAlign}`
    ).join('|');
    const shapeParts = c.shapeOverlays.map(s =>
      `${s.shapeType}_${s.x}_${s.y}_${s.width}_${s.height}_${s.fill}_${s.stroke}_${s.strokeWidth}_${s.opacity}_${s.rotation}`
    ).join('|');
    const imgParts = (c.imageOverlays || []).map(img =>
      `${img.src}_${img.x}_${img.y}_${img.width}_${img.height}_${img.opacity}_${img.rotation}`
    ).join('|');
    return `${c.bgColor}::${frameParts}::${textParts}::${shapeParts}::${imgParts}`;
  }, []);

  // ── Initialize Fabric canvas ──────────────────────────────────────────────

  useEffect(() => {
    const el = canvasElRef.current;
    const container = containerRef.current;
    if (!el || !container) return;

    const rect = container.getBoundingClientRect();
    const cw = rect.width;
    const ch = rect.height;

    const fc = new Canvas(el, {
      width: cw,
      height: ch,
      backgroundColor: '#f1f5f9', // workspace bg (slate-100)
      selection: true,
    });
    fabricRef.current = fc;

    // Calculate zoom-to-fit
    // Initial zoom-to-fit
    const pad = 40;
    const fitZoom = Math.min((cw - pad * 2) / canvasW, (ch - pad * 2) / canvasH);
    fitZoomRef.current = fitZoom;

    // Apply initial zoom & center
    fc.setZoom(fitZoom * viewZoom);
    fc.viewportTransform![4] = (cw - canvasW * fc.getZoom()) / 2;
    fc.viewportTransform![5] = (ch - canvasH * fc.getZoom()) / 2;

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
      setTimeout(() => { interactingRef.current = false; }, 100);
    });

    // Text editing guards — CRITICAL: prevents rebuild during inline editing
    fc.on('text:editing:entered', () => { isEditingRef.current = true; });
    fc.on('text:editing:exited', () => {
      setTimeout(() => { isEditingRef.current = false; }, 150);
    });

    return () => {
      fc.dispose();
      fabricRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasW, canvasH]);

  // ── Fabric-native zoom: update when viewZoom changes ──────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    // Only sync if the prop zoom significantly differs from current
    const targetZoom = fitZoomRef.current * viewZoom;
    if (Math.abs(fc.getZoom() - targetZoom) > 0.01) {
      fc.setZoom(targetZoom);
      // Re-center on zoom change from prop
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        fc.viewportTransform![4] = (rect.width - canvasW * targetZoom) / 2;
        fc.viewportTransform![5] = (rect.height - canvasH * targetZoom) / 2;
      }
      fc.requestRenderAll();
    }
  }, [viewZoom, canvasW, canvasH]);

  // ── Full rebuild: editingCanvas → Fabric objects ──────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    // Skip rebuild if user is interacting or inline-editing text
    if (interactingRef.current || isEditingRef.current) return;

    // Skip rebuild if fingerprint is identical
    const fingerprint = getCanvasFingerprint(editingCanvas);
    if (fingerprint === lastCanvasIdRef.current) return;
    lastCanvasIdRef.current = fingerprint;

    const gen = ++buildGenRef.current;

    // ── Selective Managed Clear (keeps focus if possible) ────────────────
    const managed = fc.getObjects().filter((o: any) => o[DATA_KEY] || o[PAPER_KEY]);
    fc.discardActiveObject();
    managed.forEach(o => fc.remove(o));

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

        const rot = frameState.rotation || 0;
        const rad = (rot * Math.PI) / 180;
        const sinA = Math.abs(Math.sin(rad));
        const cosA = Math.abs(Math.cos(rad));
        const effW = img.width! * cosA + img.height! * sinA;
        const effH = img.width! * sinA + img.height! * cosA;

        const baseScale = frameState.fitMode === 'cover'
          ? Math.max(fw / effW, fh / effH)
          : Math.min(fw / effW, fh / effH);
        const finalScale = baseScale * frameState.scale;

        const imgW = effW * finalScale;
        const imgH = effH * finalScale;
        const imgX = fx + (fw - imgW) / 2 + frameState.offset.x;
        const imgY = fy + (fh - imgH) / 2 + frameState.offset.y;

        const clipRect = new Rect({
          left: fx, top: fy, width: fw, height: fh,
          originX: 'left', originY: 'top',
          absolutePositioned: true,
        });

        img.set({
          left: imgX + imgW / 2,
          top: imgY + imgH / 2,
          originX: 'center',
          originY: 'center',
          scaleX: finalScale,
          scaleY: finalScale,
          angle: rot,
          clipPath: clipRect,
          hasControls: true,
          hasBorders: true,
          cornerColor: '#6366f1',
          cornerSize: 8,
          cornerStyle: 'circle',
          transparentCorners: false,
          borderColor: '#6366f1',
        });
        (img as any)[DATA_KEY] = 'frame';
        (img as any).__frameIdx = frameIdx;
        (img as any).__clipRect = { fx, fy, fw, fh };

        if (fc === fabricRef.current && buildGenRef.current === gen) {
          fc.add(img);
        }
      } catch {
        // Image load failed
      }
    });

    // ── Text Overlays (Native Alignment) ──────────────────────────────────
    editingCanvas.textOverlays.forEach((overlay, oIdx) => {
      if (!overlay.text.trim()) return;

      const tx = (overlay.x / 100) * canvasW;
      const ty = (overlay.y / 100) * canvasH;

      const textbox = new Textbox(overlay.text, {
        left: tx,
        top: ty,
        // Native alignment: origin corresponds to textAlign
        originX: overlay.textAlign === 'left' ? 'left' : overlay.textAlign === 'right' ? 'right' : 'center',
        originY: 'center',
        fontSize: overlay.fontSize,
        fill: overlay.color || '#000000',
        fontFamily: overlay.fontFamily || 'sans-serif',
        textAlign: (overlay.textAlign || 'center') as any,
        width: canvasW * 0.8,
        editable: true,
        cornerColor: '#6366f1', cornerSize: 8, cornerStyle: 'circle',
        transparentCorners: false, borderColor: '#f97316',
      });
      (textbox as any)[DATA_KEY] = 'text';
      (textbox as any).__textIdx = oIdx;
      fc.add(textbox);
    });

    // ── Shape overlays ────────────────────────────────────────────────────
    editingCanvas.shapeOverlays.forEach((shape, sIdx) => {
      const sx = (shape.x / 100) * canvasW;
      const sy = (shape.y / 100) * canvasH;
      const sw = (shape.width / 100) * canvasW;
      const sh = (shape.height / 100) * canvasH;

      const commonOpts = {
        fill: shape.fill || 'transparent',
        stroke: shape.strokeWidth > 0 ? (shape.stroke || '#000000') : undefined,
        strokeWidth: shape.strokeWidth > 0 ? shape.strokeWidth : 0,
        opacity: shape.opacity ?? 1,
        angle: shape.rotation || 0,
        cornerColor: '#6366f1',
        cornerSize: 8,
        cornerStyle: 'circle' as const,
        transparentCorners: false,
        borderColor: '#a855f7',
      };

      let fabricObj: FabricObject | null = null;
      const def = getShapeDef(shape.shapeType);

      if (def?.fabricType === 'rect') {
        const isRounded = shape.shapeType === 'rounded-rect';
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
      } else {
        const pathStr = getShapePath(shape.shapeType, shape.svgPath);
        fabricObj = new Path(pathStr, {
          left: sx, top: sy,
          originX: 'left', originY: 'top',
          scaleX: sw / 100, scaleY: sh / 100,
          ...commonOpts,
        });
      }

      if (fabricObj) {
        (fabricObj as any)[DATA_KEY] = 'shape';
        (fabricObj as any).__shapeIdx = sIdx;
        fc.add(fabricObj);
      }
    });

    // ── Image overlays (clipart / icons) ──────────────────────────────────
    const imageOverlayPromises = (editingCanvas.imageOverlays || []).map(async (imgOverlay, iIdx) => {
      const ix = (imgOverlay.x / 100) * canvasW;
      const iy = (imgOverlay.y / 100) * canvasH;
      const iw = (imgOverlay.width / 100) * canvasW;
      const ih = (imgOverlay.height / 100) * canvasH;

      try {
        const img = await FabricImage.fromURL(imgOverlay.src, { crossOrigin: 'anonymous' });
        if (buildGenRef.current !== gen) return; // stale
        const scaleX = iw / (img.width || 1);
        const scaleY = ih / (img.height || 1);
        img.set({
          left: ix, top: iy,
          originX: 'left', originY: 'top',
          scaleX, scaleY,
          angle: imgOverlay.rotation || 0,
          opacity: imgOverlay.opacity ?? 1,
          cornerColor: '#6366f1',
          cornerSize: 8,
          cornerStyle: 'circle',
          transparentCorners: false,
          borderColor: '#10b981',
        });
        (img as any)[DATA_KEY] = 'image';
        (img as any).__imageIdx = iIdx;
        if (fc === fabricRef.current && buildGenRef.current === gen) fc.add(img);
      } catch {
        // Skip failed image loads
      }
    });

    // ── Mask overlay ──────────────────────────────────────────────────────
    if (layout?.maskUrl) {
      FabricImage.fromURL(layout.maskUrl).then(maskImg => {
        if (fc !== fabricRef.current || buildGenRef.current !== gen) return;
        maskImg.set({
          left: 0, top: 0,
          originX: 'left', originY: 'top',
          scaleX: canvasW / maskImg.width!,
          scaleY: canvasH / maskImg.height!,
          selectable: false,
          evented: false,
          opacity: 0.5,
        });
        (maskImg as any)[DATA_KEY] = 'mask';
        fc.add(maskImg);
        fc.renderAll();
      }).catch(() => {});
    }

    // Wait for async loads, then z-order and render
    Promise.all([...loadFramePromises, ...imageOverlayPromises]).then(() => {
      if (fc !== fabricRef.current || buildGenRef.current !== gen) return;

      // Re-order: paper → frames → shapes → images → text → mask
      const objs = fc.getObjects();
      const paperObjs = objs.filter((o: any) => o[PAPER_KEY]);
      const frameObjs = objs.filter((o: any) => o[DATA_KEY] === 'frame');
      const shapeObjs = objs.filter((o: any) => o[DATA_KEY] === 'shape');
      const imageObjs = objs.filter((o: any) => o[DATA_KEY] === 'image');
      const textObjs = objs.filter((o: any) => o[DATA_KEY] === 'text');
      const maskObjs = objs.filter((o: any) => o[DATA_KEY] === 'mask');

      fc.clear();
      fc.backgroundColor = '#f1f5f9';
      [...paperObjs, ...frameObjs, ...shapeObjs, ...imageObjs, ...textObjs, ...maskObjs].forEach(o => fc.add(o));

      // Restore selection
      if (selectedLayer) {
        let targetObj: FabricObject | undefined;
        if (selectedLayer.type === 'frame') {
          targetObj = fc.getObjects().find((o: any) => o[DATA_KEY] === 'frame' && o.__frameIdx === selectedLayer.index);
        } else if (selectedLayer.type === 'text') {
          targetObj = fc.getObjects().find((o: any) => o[DATA_KEY] === 'text' && o.__textIdx === selectedLayer.index);
        } else if (selectedLayer.type === 'shape') {
          targetObj = fc.getObjects().find((o: any) => o[DATA_KEY] === 'shape' && o.__shapeIdx === selectedLayer.index);
        } else if (selectedLayer.type === 'image') {
          targetObj = fc.getObjects().find((o: any) => o[DATA_KEY] === 'image' && o.__imageIdx === selectedLayer.index);
        }
        if (targetObj) fc.setActiveObject(targetObj);
      }
      fc.renderAll();
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCanvas, layout, selectedLayer, canvasW, canvasH, getFileUrl, getCanvasFingerprint]);

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

        const updated = { ...current, frames: newFrames };
        lastCanvasIdRef.current = getCanvasFingerprint(updated);
        onCanvasChange(updated);
      } else if (type === 'text') {
        const idx = (target as any).__textIdx as number;
        const newX = ((target.left ?? 0) / canvasW) * 100;
        const newY = ((target.top ?? 0) / canvasH) * 100;
        const textObj = target as Textbox;
        const newOverlays = current.textOverlays.map((t, i) => {
          if (i !== idx) return t;
          return {
            ...t,
            x: Math.round(newX * 10) / 10,
            y: Math.round(newY * 10) / 10,
            text: textObj.text || t.text,
            fontSize: Math.round(textObj.fontSize ?? t.fontSize),
          };
        });
        const updated = { ...current, textOverlays: newOverlays };
        lastCanvasIdRef.current = getCanvasFingerprint(updated);
        onCanvasChange(updated);
      } else if (type === 'shape') {
        const idx = (target as any).__shapeIdx as number;
        const newX = ((target.left ?? 0) / canvasW) * 100;
        const newY = ((target.top ?? 0) / canvasH) * 100;
        const newW = (((target.width ?? 100) * (target.scaleX ?? 1)) / canvasW) * 100;
        const newH = (((target.height ?? 100) * (target.scaleY ?? 1)) / canvasH) * 100;
        const newShapes = current.shapeOverlays.map((s, i) => {
          if (i !== idx) return s;
          return {
            ...s,
            x: Math.round(newX * 10) / 10,
            y: Math.round(newY * 10) / 10,
            width: Math.round(newW * 10) / 10,
            height: Math.round(newH * 10) / 10,
            rotation: Math.round(target.angle ?? s.rotation),
          };
        });
        const updated = { ...current, shapeOverlays: newShapes };
        lastCanvasIdRef.current = getCanvasFingerprint(updated);
        onCanvasChange(updated);
      } else if (type === 'image') {
        const idx = (target as any).__imageIdx as number;
        const newX = ((target.left ?? 0) / canvasW) * 100;
        const newY = ((target.top ?? 0) / canvasH) * 100;
        const newW = (((target.width ?? 100) * (target.scaleX ?? 1)) / canvasW) * 100;
        const newH = (((target.height ?? 100) * (target.scaleY ?? 1)) / canvasH) * 100;
        const newImages = (current.imageOverlays || []).map((img, i) => {
          if (i !== idx) return img;
          return {
            ...img,
            x: Math.round(newX * 10) / 10,
            y: Math.round(newY * 10) / 10,
            width: Math.round(newW * 10) / 10,
            height: Math.round(newH * 10) / 10,
            rotation: Math.round(target.angle ?? img.rotation),
          };
        });
        const updated = { ...current, imageOverlays: newImages };
        lastCanvasIdRef.current = getCanvasFingerprint(updated);
        onCanvasChange(updated);
      }
    };

    const handleSelection = (e: any) => {
      const selected = e.selected?.[0];
      if (!selected || !(selected as any)[DATA_KEY]) return;
      const type = (selected as any)[DATA_KEY];
      if (type === 'frame') onLayerSelect({ type: 'frame', index: (selected as any).__frameIdx });
      else if (type === 'text') onLayerSelect({ type: 'text', index: (selected as any).__textIdx });
      else if (type === 'shape') onLayerSelect({ type: 'shape', index: (selected as any).__shapeIdx });
      else if (type === 'image') onLayerSelect({ type: 'image', index: (selected as any).__imageIdx });
    };

    // Fabric inline text editing — sync text changes back to state
    // isEditingRef is TRUE here, so the resulting state change won't trigger a rebuild
    const handleTextChanged = (e: any) => {
      const target = e.target as Textbox;
      if (!target || (target as any)[DATA_KEY] !== 'text') return;
      const idx = (target as any).__textIdx as number;
      const current = editingCanvasRef.current;
      const newOverlays = current.textOverlays.map((t, i) => {
        if (i !== idx) return t;
        return { ...t, text: target.text || t.text };
      });
      const updated = { ...current, textOverlays: newOverlays };
      lastCanvasIdRef.current = getCanvasFingerprint(updated);
      onCanvasChange(updated);
    };

    fc.on('object:modified', handleModified);
    fc.on('selection:created', handleSelection);
    fc.on('selection:updated', handleSelection);
    fc.on('text:changed', handleTextChanged);

    return () => {
      fc.off('object:modified', handleModified);
      fc.off('selection:created', handleSelection);
      fc.off('selection:updated', handleSelection);
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
