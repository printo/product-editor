'use client';

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Canvas, Rect, FabricText, FabricImage, ActiveSelection, Textbox, type FabricObject } from 'fabric';
import { captionOverridesFromMm, resolveCaptionBox } from '@/lib/caption-layout';
import {
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
} from 'lucide-react';
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
import { alignFrames, nudgeFrames, type AlignEdge } from './frame-align';

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
  caption?: string;
  captionEnabled?: boolean;
  captionXMm?: number | string;
  captionYMm?: number | string;
  captionWidthMm?: number | string;
  captionFontMm?: number | string;
  captionAlign?: 'left' | 'center' | 'right';
  captionColor?: string;
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
  /** Master caption opt-in (layout.frameCaptionsEnabled). When true, frames
   *  with captionEnabled show a draggable caption box in the preview. */
  captionsEnabled?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID_SNAP_MM = 2; // snap every 2mm when grid enabled
const SNAP_THRESHOLD_PX = 6;

// Custom data key to identify our objects. Must match the property we
// actually stamp on objects below (`obj.__fabricEditor = ...`) — mirrors
// FabricEditor.tsx. A previous value ('__layoutPreview') matched nothing,
// so the cleanup filter never removed old objects and every frame edit
// stacked a fresh set of rects/labels onto the preview.
const DATA_KEY = '__fabricEditor';

// Align toolbar buttons shown when ≥2 print areas are selected.
const ALIGN_BUTTONS: { edge: AlignEdge; Icon: React.ComponentType<{ className?: string }>; title: string }[] = [
  { edge: 'left', Icon: AlignStartVertical, title: 'Align left edges' },
  { edge: 'centerH', Icon: AlignCenterVertical, title: 'Center horizontally' },
  { edge: 'right', Icon: AlignEndVertical, title: 'Align right edges' },
  { edge: 'top', Icon: AlignStartHorizontal, title: 'Align top edges' },
  { edge: 'middleV', Icon: AlignCenterHorizontal, title: 'Center vertically' },
  { edge: 'bottom', Icon: AlignEndHorizontal, title: 'Align bottom edges' },
];

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
  captionsEnabled = false,
}: LayoutFabricPreviewProps) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Track whether we are currently syncing from Fabric → parent to avoid loops
  const isSyncingRef = useRef(false);
  // Store the latest frames to avoid stale closure issues
  const framesRef = useRef(frames);
  framesRef.current = frames;
  // Multi-select support: ids of currently-selected frames + a count that
  // toggles the align toolbar. suppressSelectionRef silences selection events
  // while we programmatically move/reselect objects (see applyFrames), so a
  // rebuild doesn't clobber the selection we're about to restore.
  const selectedIdsRef = useRef<string[]>([]);
  const suppressSelectionRef = useRef(false);
  const [selectedCount, setSelectedCount] = useState(0);

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
      selection: true, // allow marquee / shift-click to pick multiple frames
    });
    fabricRef.current = fc;

    // Read the current Fabric selection → report the set of selected frame
    // ids to ourselves (for the align toolbar) and the primary id to the
    // parent (for single-frame highlighting). Silenced while we're
    // programmatically reselecting so it can't fight itself.
    const readSelection = () => {
      if (suppressSelectionRef.current) return;
      const ids = fc
        .getActiveObjects()
        .filter((o) => o.__fabricEditor === 'frame' && o.__frameId)
        .map((o) => o.__frameId as string);
      selectedIdsRef.current = ids;
      setSelectedCount(ids.length);
      onFrameSelect(ids.length === 1 ? ids[0] : null);
    };
    fc.on('selection:created', readSelection);
    fc.on('selection:updated', readSelection);
    fc.on('selection:cleared', readSelection);

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

    // Remove all existing managed objects EXCEPT the mask, which has its own
    // lifecycle effect below. Clearing it here would drop an uploaded mask on
    // every frame edit, because that effect doesn't re-run on frame changes.
    const existing = fc.getObjects().filter(
      (o: any) => o[DATA_KEY] && o[DATA_KEY] !== 'mask',
    );
    existing.forEach(o => fc.remove(o));

    // Add center guides
    const guides = createCenterGuides(cw, ch);
    guides.forEach(g => {
      g.__fabricEditor = 'guide';
      fc.add(g);
    });

    // Add grid lines when snap enabled
    if (snapGrid) {
      const gridPx = GRID_SNAP_MM * scale;
      const gridLines = createGridLines(cw, ch, gridPx);
      gridLines.forEach(l => {
        l.__fabricEditor = 'grid';
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
        br.__fabricEditor = 'bleed';
        br.__frameIdx = idx;
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
      rect.__fabricEditor = 'frame';
      rect.__frameIdx = idx;
      rect.__frameId = frame.id;

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
      label.__fabricEditor = 'label';
      label.__frameIdx = idx;
      fc.add(label);

      // Draggable caption box — only when captions are on for this frame.
      // Position/style come from the frame's caption* mm fields (default:
      // bottom-centre via resolveCaptionBox). Drag/resize writes them back.
      if (captionsEnabled && frame.captionEnabled) {
        const cbox = resolveCaptionBox(
          fxMm * scale, fyMm * scale, fwMm * scale, fhMm * scale,
          captionOverridesFromMm(frame, scale),
        );
        const capText = (frame.caption && String(frame.caption).trim()) || 'Caption';
        const cap = new Textbox(capText, {
          left: cbox.x, top: cbox.y, width: cbox.w,
          originX: 'left', originY: 'top',
          fontSize: cbox.fontPx, fontFamily: 'Inter, Arial, sans-serif',
          fill: cbox.color, textAlign: cbox.align,
          backgroundColor: 'rgba(99, 102, 241, 0.06)',
          editable: false, lockRotation: true,
          cornerColor: '#6366f1', cornerSize: 7, cornerStyle: 'circle',
          transparentCorners: false, borderColor: '#6366f1',
        });
        cap.__fabricEditor = 'frameCaption';
        cap.__frameIdx = idx;
        cap.__frameId = frame.id;
        // Width-only resize (ml/mr); font size is a sidebar control.
        cap.setControlsVisibility({ mt: false, mb: false, tl: false, tr: false, bl: false, br: false, mtr: false });
        fc.add(cap);
      }
    });

    fc.renderAll();
    // Re-run structural changes or dimensions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, widthMm, heightMm, snapGrid, getScale, captionsEnabled]);

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
      img.__fabricEditor = 'mask';
      fabricRef.current.add(img);
      fabricRef.current.renderAll();
    }).catch(() => {});

    return () => {
      if (maskFile && src) URL.revokeObjectURL(src);
    };
  }, [maskUrl, maskFile, widthMm, heightMm, getScale]);

  // ── Fabric events → parent state ─────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    const scale = getScale();
    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

    const handleModified = (e: any) => {
      const target = e.target as FabricObject;
      if (!target) return;

      // Caption box moved/resized → write its placement back to the frame in mm.
      if (target.__fabricEditor === 'frameCaption') {
        const cIdx = target.__frameIdx as number;
        const curFrames = framesRef.current;
        if (cIdx == null || cIdx < 0 || cIdx >= curFrames.length) return;
        const effW = (target.width ?? 0) * (target.scaleX ?? 1);
        target.set({ width: effW, scaleX: 1, scaleY: 1 });
        const capX = round2((target.left ?? 0) / scale);
        const capY = round2((target.top ?? 0) / scale);
        const capW = round2(effW / scale);
        const capFont = round2((((target as any).fontSize as number) ?? 12) / scale);
        const capAlign = (((target as any).textAlign as 'left' | 'center' | 'right')) ?? 'center';
        const capColor = (((target as any).fill as string)) ?? '#2a2a2a';
        isSyncingRef.current = true;
        onFramesChange(curFrames.map((f, i) => i === cIdx ? {
          ...f, captionXMm: capX, captionYMm: capY, captionWidthMm: capW,
          captionFontMm: capFont, captionAlign: capAlign, captionColor: capColor,
        } : f));
        requestAnimationFrame(() => { isSyncingRef.current = false; });
        return;
      }

      if (target.__fabricEditor !== 'frame') return;

      const idx = target.__frameIdx as number;
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
      if (!target || target.__fabricEditor !== 'frame') return;

      const idx = target.__frameIdx as number;
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
      if (!target || target.__fabricEditor !== 'frame') return;

      const idx = target.__frameIdx as number;
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
  }, [widthMm, heightMm, snapGrid, onFramesChange, getScale]);

  // Reposition the given frames' Fabric objects from their mm values and sync
  // back to the parent WITHOUT triggering a rebuild (isSyncingRef guards the
  // sync effect), so the active selection survives. Drives arrow-key nudging
  // and the align tools.
  const applyFrames = useCallback((next: LayoutFrame[], activeIds: string[]) => {
    const fc = fabricRef.current;
    if (!fc) return;
    const scale = getScale();
    const idSet = new Set(activeIds);

    suppressSelectionRef.current = true;
    isSyncingRef.current = true;

    fc.discardActiveObject();

    next.forEach((frame, idx) => {
      if (frame.id == null || !idSet.has(frame.id)) return;
      const xMm = Number(frame.xMm || 0);
      const yMm = Number(frame.yMm || 0);
      const wMm = Number(frame.widthMm || 0);
      const hMm = Number(frame.heightMm || 0);
      const bleed = Number(frame.bleedMm || 0);
      const radiusMm = Number(frame.borderRadiusMm || 0);
      fc.getObjects()
        .filter((o) => o.__frameIdx === idx)
        .forEach((o) => {
          if (o.__fabricEditor === 'frame') {
            o.set({ left: xMm * scale, top: yMm * scale, width: wMm * scale, height: hMm * scale, scaleX: 1, scaleY: 1 });
          } else if (o.__fabricEditor === 'bleed') {
            o.set({
              left: (xMm - bleed) * scale, top: (yMm - bleed) * scale,
              width: (wMm + bleed * 2) * scale, height: (hMm + bleed * 2) * scale,
              rx: radiusMm > 0 ? (radiusMm + bleed) * scale : 0,
              ry: radiusMm > 0 ? (radiusMm + bleed) * scale : 0,
            });
          } else if (o.__fabricEditor === 'label') {
            o.set({ left: xMm * scale + 3, top: yMm * scale + 2 });
          }
          o.setCoords();
        });
    });

    // Restore the selection so the user can keep nudging / chain alignments.
    const rects = fc.getObjects().filter((o) => o.__fabricEditor === 'frame' && o.__frameId && idSet.has(o.__frameId));
    if (rects.length > 1) {
      fc.setActiveObject(new ActiveSelection(rects, { canvas: fc }));
    } else if (rects.length === 1) {
      fc.setActiveObject(rects[0]);
    }

    suppressSelectionRef.current = false;
    fc.requestRenderAll();

    onFramesChange(next);
    requestAnimationFrame(() => { isSyncingRef.current = false; });
  }, [getScale, onFramesChange]);

  const handleAlign = useCallback((edge: AlignEdge) => {
    const ids = selectedIdsRef.current;
    if (ids.length < 2) return;
    applyFrames(alignFrames(framesRef.current, ids, edge), ids);
  }, [applyFrames]);

  // Arrow keys nudge the selected frame(s). Step = grid size when snapping is
  // on (else 1mm), ×5 with Shift. Ignored while a form field has focus so it
  // doesn't fight the number inputs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      const ids = selectedIdsRef.current;
      if (ids.length === 0) return;
      e.preventDefault();
      const step = (snapGrid ? GRID_SNAP_MM : 1) * (e.shiftKey ? 5 : 1);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      applyFrames(nudgeFrames(framesRef.current, ids, dx, dy, widthMm, heightMm), ids);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyFrames, snapGrid, widthMm, heightMm]);

  return (
    <div
      ref={containerRef}
      className="relative bg-slate-100 rounded-2xl flex items-center justify-center overflow-hidden w-full h-full min-h-[400px] p-6"
    >
      {selectedCount >= 2 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white/95 px-1.5 py-1 shadow-lg backdrop-blur">
          <span className="px-1.5 text-[9px] font-black uppercase tracking-wider text-slate-400">Align {selectedCount}</span>
          {ALIGN_BUTTONS.map(({ edge, Icon, title }) => (
            <button
              key={edge}
              type="button"
              title={title}
              onClick={() => handleAlign(edge)}
              className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      )}
      <div className="shadow-2xl rounded-sm">
        <canvas ref={canvasElRef} />
      </div>
    </div>
  );
}
