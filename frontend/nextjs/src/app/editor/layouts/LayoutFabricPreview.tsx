'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { Canvas, Rect, FabricText, FabricImage, type FabricObject } from 'fabric';
import {
  createFrameRect,
  createBleedRect,
  createFrameLabel,
  createCenterGuides,
  createGridLines,
  snapToGrid,
  constrainToCanvas,
  initAligningGuidelines,
} from '@/lib/fabric-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LayoutFrame {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xMm?: number | string;
  yMm?: number | string;
  widthMm?: number | string;
  heightMm?: number | string;
  bleedMm?: number | string;
  borderRadiusMm?: number | string;
}

interface LayoutFabricPreviewProps {
  widthMm: number;
  heightMm: number;
  dpi: number;
  frames: LayoutFrame[];
  maskUrl: string | null;
  maskFile: File | null;
  snapGrid: boolean;
  onFramesChange: (frames: LayoutFrame[]) => void;
  onFrameSelect: (frameId: string | null) => void;
  selectedFrameId?: string | null;
  zoom?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID_SNAP_MM = 2; // snap every 2mm when grid enabled
const SNAP_THRESHOLD_PX = 6;

// Custom data key to identify our objects
const DATA_KEY = '__layoutPreview';

// ─── Component ───────────────────────────────────────────────────────────────

export function LayoutFabricPreview({
  widthMm,
  heightMm,
  dpi,
  frames,
  maskUrl,
  maskFile,
  snapGrid,
  onFramesChange,
  onFrameSelect,
  selectedFrameId,
  zoom = 1,
}: LayoutFabricPreviewProps) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Track whether we are currently syncing from Fabric → parent to avoid loops
  const isSyncingRef = useRef(false);
  // Store the latest frames to avoid stale closure issues
  const framesRef = useRef(frames);
  framesRef.current = frames;

  // Scale: how many CSS px per mm on the preview canvas
  const getScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 1;
    const maxW = container.clientWidth - 48; // padding
    const maxH = container.clientHeight - 48;
    const fitZoom = Math.min(maxW / widthMm, maxH / heightMm, 4);
    return fitZoom * zoom;
  }, [widthMm, heightMm, zoom]);

  // ── Initialize Fabric canvas ─────────────────────────────────────────────

  useEffect(() => {
    const el = canvasElRef.current;
    if (!el) return;

    const scale = getScale();
    const cw = widthMm * scale;
    const ch = heightMm * scale;

    const fc = new Canvas(el, {
      width: cw,
      height: ch,
      backgroundColor: '#ffffff',
      selection: false,
    });
    fabricRef.current = fc;

    // Synchronize selectedFrameId to Fabric's internal state
    const handleSelection = (e: any) => {
      const selected = e.selected?.[0];
      if (selected && (selected as any)[DATA_KEY] === 'frame') {
        onFrameSelect((selected as any).__frameId || null);
      }
    };
    fc.on('selection:created', handleSelection);
    fc.on('selection:updated', handleSelection);
    fc.on('selection:cleared', () => onFrameSelect(null));

    initAligningGuidelines(fc, { lineMargin: SNAP_THRESHOLD_PX });

    return () => {
      fc.dispose();
      fabricRef.current = null;
    };
    // Re-initialize only when basic dimensions change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthMm, heightMm]);

  // ── Sync frames → Fabric objects ─────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || isSyncingRef.current) return;

    const scale = getScale();
    const cw = widthMm * scale;
    const ch = heightMm * scale;

    // Resize canvas if needed
    if (fc.width !== cw || fc.height !== ch) {
      fc.setDimensions({ width: cw, height: ch });
    }

    // Remove all existing managed objects
    const existing = fc.getObjects().filter(
      (o: any) => o[DATA_KEY],
    );
    existing.forEach(o => fc.remove(o));

    // Add center guides
    const guides = createCenterGuides(cw, ch);
    guides.forEach(g => {
      (g as any)[DATA_KEY] = 'guide';
      fc.add(g);
    });

    // Add grid lines when snap enabled
    if (snapGrid) {
      const gridPx = GRID_SNAP_MM * scale;
      const gridLines = createGridLines(cw, ch, gridPx);
      gridLines.forEach(l => {
        (l as any)[DATA_KEY] = 'grid';
        fc.add(l);
      });
    }

    // Add frame rects (bleed behind, then safe area)
    frames.forEach((frame, idx) => {
      const bleed = Number(frame.bleedMm || 0);
      const fxMm = Number(frame.xMm || 0);
      const fyMm = Number(frame.yMm || 0);
      const fwMm = Number(frame.widthMm || 0);
      const fhMm = Number(frame.heightMm || 0);
      const radiusMm = Number(frame.borderRadiusMm || 0);

      // Bleed rect (non-interactive)
      if (bleed > 0) {
        const br = createBleedRect(
          (fxMm - bleed) * scale,
          (fyMm - bleed) * scale,
          (fwMm + bleed * 2) * scale,
          (fhMm + bleed * 2) * scale,
          radiusMm > 0 ? (radiusMm + bleed) * scale : 0
        );
        (br as any)[DATA_KEY] = 'bleed';
        (br as any).__frameIdx = idx;
        fc.add(br);
      }

      // Safe area rect (interactive)
      const isSelected = frame.id === selectedFrameId;
      const rect = createFrameRect(
        fxMm * scale,
        fyMm * scale,
        fwMm * scale,
        fhMm * scale,
        {
          stroke: isSelected ? '#6366f1' : '#10b981',
          fill: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'rgba(16, 185, 129, 0.08)',
          rx: radiusMm * scale,
          ry: radiusMm * scale,
        },
      );
      (rect as any)[DATA_KEY] = 'frame';
      (rect as any).__frameIdx = idx;
      (rect as any).__frameId = frame.id;

      // Constrain resize to stay within canvas
      rect.setControlsVisibility({
        mtr: false, // no rotation
      });

      fc.add(rect);

      // Label
      const label = createFrameLabel(
        `${idx + 1}`,
        fxMm * scale,
        fyMm * scale,
      );
      (label as any)[DATA_KEY] = 'label';
      (label as any).__frameIdx = idx;
      fc.add(label);
    });

    fc.renderAll();
    // Re-run structural changes or dimensions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, widthMm, heightMm, snapGrid, getScale]);

  // ── Sync selection color → Fabric objects ─────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    const objects = fc.getObjects().filter((o: any) => o[DATA_KEY] === 'frame');
    objects.forEach((obj: any) => {
      const isSelected = obj.__frameId === selectedFrameId;
      obj.set({
        stroke: isSelected ? '#6366f1' : '#10b981',
        fill: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'rgba(16, 185, 129, 0.08)',
        strokeWidth: isSelected ? 2 : 1,
      });
      // If selected prop changed from parent, ensure Fabric's internal selection matches
      if (isSelected && fc.getActiveObject() !== obj) {
        fc.setActiveObject(obj);
      }
    });
    fc.requestRenderAll();
  }, [selectedFrameId]);

  // ── Mask overlay ─────────────────────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    // Remove existing mask
    const existingMask = fc.getObjects().find((o: any) => o[DATA_KEY] === 'mask');
    if (existingMask) fc.remove(existingMask);

    const src = maskFile ? URL.createObjectURL(maskFile) : maskUrl;
    if (!src) return;

    const scale = getScale();
    const cw = widthMm * scale;
    const ch = heightMm * scale;

    FabricImage.fromURL(src).then(img => {
      if (!fabricRef.current) return;
      img.scaleToWidth(cw);
      img.scaleToHeight(ch);
      img.set({
        left: 0,
        top: 0,
        originX: 'left',
        originY: 'top',
        selectable: false,
        evented: false,
        opacity: 0.6,
      });
      (img as any)[DATA_KEY] = 'mask';
      fabricRef.current.add(img);
      fabricRef.current.renderAll();
    }).catch(() => {});

    return () => {
      if (maskFile && src) URL.revokeObjectURL(src);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maskUrl, maskFile, widthMm, heightMm, getScale]);

  // ── Fabric events → parent state ─────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    const scale = getScale();
    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

    const handleModified = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || (target as any)[DATA_KEY] !== 'frame') return;

      const idx = (target as any).__frameIdx as number;
      const curFrames = framesRef.current;
      if (idx < 0 || idx >= curFrames.length) return;

      const cw = widthMm * scale;
      const ch = heightMm * scale;
      constrainToCanvas(target, cw, ch);

      const left = target.left ?? 0;
      const top = target.top ?? 0;
      const w = (target.width ?? 0) * (target.scaleX ?? 1);
      const h = (target.height ?? 0) * (target.scaleY ?? 1);

      target.set({ width: w, height: h, scaleX: 1, scaleY: 1 });

      const newXMm = round2(left / scale);
      const newYMm = round2(top / scale);
      const newWMm = round2(w / scale);
      const newHMm = round2(h / scale);

      isSyncingRef.current = true;
      const updated = curFrames.map((f, i) => {
        if (i !== idx) return f;
        return { ...f, xMm: newXMm, yMm: newYMm, widthMm: newWMm, heightMm: newHMm };
      });
      onFramesChange(updated);
      requestAnimationFrame(() => { isSyncingRef.current = false; });
    };

    const handleMoving = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || (target as any)[DATA_KEY] !== 'frame') return;

      const idx = (target as any).__frameIdx as number;
      const cw = widthMm * scale;
      const ch = heightMm * scale;

      if (snapGrid) {
        const gridPx = GRID_SNAP_MM * scale;
        const left = target.left ?? 0;
        const top = target.top ?? 0;
        target.set({
          left: snapToGrid(left, gridPx),
          top: snapToGrid(top, gridPx),
        });
      }
      constrainToCanvas(target, cw, ch);

      // Sync associated objects (bleed, label)
      const left = target.left ?? 0;
      const top = target.top ?? 0;
      const curFrames = framesRef.current;
      const frame = curFrames[idx];
      const bleed = Number(frame?.bleedMm || 0);

      const objects = fc.getObjects().filter((o: any) => o.__frameIdx === idx);
      objects.forEach((obj: any) => {
        if (obj[DATA_KEY] === 'bleed') {
          obj.set({
            left: left - bleed * scale,
            top: top - bleed * scale,
          });
        } else if (obj[DATA_KEY] === 'label') {
          obj.set({
            left: left + 3,
            top: top + 2,
          });
        }
      });
    };

    const handleScaling = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || (target as any)[DATA_KEY] !== 'frame') return;

      const idx = (target as any).__frameIdx as number;
      const cw = widthMm * scale;
      const ch = heightMm * scale;

      const minPx = 5 * scale;
      const w = (target.width ?? 0) * (target.scaleX ?? 1);
      const h = (target.height ?? 0) * (target.scaleY ?? 1);
      if (w < minPx) target.set({ scaleX: minPx / (target.width ?? 1) });
      if (h < minPx) target.set({ scaleY: minPx / (target.height ?? 1) });

      constrainToCanvas(target, cw, ch);

      // Sync associated objects (bleed, label)
      const left = target.left ?? 0;
      const top = target.top ?? 0;
      const curFrames = framesRef.current;
      const frame = curFrames[idx];
      const bleed = Number(frame?.bleedMm || 0);
      const radiusMm = Number(frame?.borderRadiusMm || 0);

      const objects = fc.getObjects().filter((o: any) => o.__frameIdx === idx);
      objects.forEach((obj: any) => {
        if (obj[DATA_KEY] === 'bleed') {
          obj.set({
            left: left - bleed * scale,
            top: top - bleed * scale,
            width: w + (bleed * 2) * scale,
            height: h + (bleed * 2) * scale,
            rx: radiusMm > 0 ? (radiusMm + bleed) * scale : 0,
            ry: radiusMm > 0 ? (radiusMm + bleed) * scale : 0,
          });
        } else if (obj[DATA_KEY] === 'label') {
          obj.set({
            left: left + 3,
            top: top + 2,
          });
        }
      });
    };

    fc.on('object:modified', handleModified);
    fc.on('object:moving', handleMoving);
    fc.on('object:scaling', handleScaling);

    return () => {
      fc.off('object:modified', handleModified);
      fc.off('object:moving', handleMoving);
      fc.off('object:scaling', handleScaling);
      // selection events are handled in initialization effect
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthMm, heightMm, snapGrid, onFramesChange, getScale]);

  return (
    <div
      ref={containerRef}
      className="relative bg-slate-100 rounded-2xl flex items-center justify-center overflow-hidden w-full h-full min-h-[400px] p-6"
    >
      <div className="shadow-2xl rounded-sm">
        <canvas ref={canvasElRef} />
      </div>
    </div>
  );
}
