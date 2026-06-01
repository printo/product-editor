'use client';

/**
 * Interactive Fabric.js canvas preview for the calendar layout editor.
 * Shows photo frames (green) and calendar blocks (teal) as draggable /
 * resizable objects — mirrors the UX of LayoutFabricPreview for standard
 * layouts, adapted to the 0..1 fraction coordinate system used by calendar
 * layouts (no mm bleed zone, two object types instead of one).
 *
 * Design choices:
 *  - Frames and calendar blocks are simple colour-coded Rects with labels.
 *    Rendering a full buildCalendarFabricGroup inside each block would
 *    require rebuilding on every style change and makes Group resize complex;
 *    the MonthTileThumb aside already shows what the calendar looks like.
 *  - In poster auto-tile mode (posterCustomLayout=false) the 12 preview
 *    blocks derive their positions from calendars[0] and are read-only; only
 *    the seed block is interactive. Custom-layout mode (true) makes all 12
 *    individually draggable.
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Canvas, Rect, FabricText, FabricImage, type FabricObject } from 'fabric';
import {
  createCenterGuides,
  createGridLines,
  snapToGrid,
  constrainToCanvas,
  initAligningGuidelines,
} from '@/lib/fabric-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CalFrame {
  x: number; y: number; width: number; height: number;
}

export interface CalBlock {
  x: number; y: number; width: number; height: number;
  monthOffset?: number;
}

interface CalendarFabricPreviewProps {
  widthMm: number;
  heightMm: number;
  frames: CalFrame[];
  calendars: CalBlock[];
  mode: 'multi-surface' | 'poster';
  posterCustomLayout: boolean;
  onFramesChange: (f: CalFrame[]) => void;
  onCalendarsChange: (c: CalBlock[]) => void;
  maskFile?: File | null;
  maskUrl?: string | null;
  snapGrid?: boolean;
  zoom?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID_SNAP_MM = 5;   // 5mm grid — same visual density as the generic layout editor
const SNAP_THRESHOLD_PX = 6;
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Component ───────────────────────────────────────────────────────────────

export function CalendarFabricPreview({
  widthMm,
  heightMm,
  frames,
  calendars,
  mode,
  posterCustomLayout,
  onFramesChange,
  onCalendarsChange,
  maskFile = null,
  maskUrl = null,
  snapGrid = false,
  zoom = 1,
}: CalendarFabricPreviewProps) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef   = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  // Keep refs current to avoid stale closure issues in event handlers
  const framesRef    = useRef(frames);
  const calendarsRef = useRef(calendars);
  framesRef.current    = frames;
  calendarsRef.current = calendars;

  // Stable scale: only update when the container width changes by more than
  // 8 px so micro-layout shifts (left panel growing/shrinking by a few px
  // when posterCustomLayout toggles) don't rescale the canvas and look like
  // a zoom.
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      setContainerW(prev => (Math.abs(prev - w) > 8 ? w : prev));
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // px per mm on the preview canvas
  const getScale = useCallback(() => {
    const c = containerRef.current;
    if (!c) return 1;
    const availW = (containerW || c.clientWidth) - 48;
    const availH = c.clientHeight - 48;
    return Math.min(availW / widthMm, availH / heightMm, 4) * zoom;
  }, [containerW, widthMm, heightMm, zoom]);

  // ── Initialize Fabric canvas ─────────────────────────────────────────────

  useEffect(() => {
    const el = canvasElRef.current;
    if (!el) return;
    const scale = getScale();
    const fc = new Canvas(el, {
      width: widthMm * scale,
      height: heightMm * scale,
      backgroundColor: '#ffffff',
      selection: false,
    });
    fabricRef.current = fc;
    initAligningGuidelines(fc, { lineMargin: SNAP_THRESHOLD_PX });
    return () => {
      fc.dispose();
      fabricRef.current = null;
    };
    // Re-init only when canvas dimensions change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthMm, heightMm]);

  // ── Sync state → Fabric objects ──────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc || isSyncingRef.current) return;

    const scale = getScale();
    const cw = widthMm * scale;
    const ch = heightMm * scale;

    if (fc.width !== cw || fc.height !== ch) fc.setDimensions({ width: cw, height: ch });

    // Remove all objects we own
    fc.getObjects().filter((o: any) => o.__calPreview).forEach(o => fc.remove(o));

    // ── Guides + grid ────────────────────────────────────────────────────
    createCenterGuides(cw, ch).forEach(g => {
      g.__calPreview = true;
      g.__fabricEditor = 'guide';
      fc.add(g);
    });
    // Show grid lines only when snapGrid is enabled — mirrors LayoutFabricPreview
    if (snapGrid) {
      const gridPx = GRID_SNAP_MM * scale;
      createGridLines(cw, ch, gridPx).forEach(l => {
        l.__calPreview = true;
        l.__fabricEditor = 'grid';
        fc.add(l);
      });
    }

    // ── Photo frames (green dashed, draggable/resizable) ─────────────────
    frames.forEach((frame, idx) => {
      const rect = new Rect({
        left: frame.x * cw,
        top:  frame.y * ch,
        width:  frame.width  * cw,
        height: frame.height * ch,
        originX: 'left', originY: 'top',
        fill:   'rgba(16, 185, 129, 0.10)',
        stroke: '#10b981',
        strokeWidth: 1.5,
        strokeDashArray: [4, 3],
        selectable: true,
        hasControls: true,
        lockRotation: true,
        cornerColor: '#6366f1',
        cornerSize: 8,
        cornerStyle: 'circle' as const,
        transparentCorners: false,
        borderColor: '#6366f1',
        borderDashArray: [3, 3],
      });
      rect.__calPreview = true;
      rect.__fabricEditor = 'frame';
      rect.__frameIdx = idx;
      rect.setControlsVisibility({ mtr: false });
      fc.add(rect);

      const lbl = new FabricText(`Frame ${idx + 1}`, {
        left: frame.x * cw + 4,
        top:  frame.y * ch + 4,
        originX: 'left', originY: 'top',
        fontSize: 10, fontWeight: 'bold', fontFamily: 'sans-serif',
        fill: '#fff', backgroundColor: '#10b981',
        padding: 2,
        selectable: false, evented: false,
      });
      lbl.__calPreview = true;
      lbl.__fabricEditor = 'label';
      lbl.__frameIdx = idx;
      fc.add(lbl);
    });

    // ── Calendar blocks (teal, draggable/resizable) ───────────────────────
    type RenderBlock = {
      block: CalBlock; calIdx: number; label: string; interactive: boolean;
    };
    const toRender: RenderBlock[] = [];

    if (mode === 'multi-surface') {
      const base = calendars[0] ?? { x: 0.05, y: 0.55, width: 0.9, height: 0.42 };
      toRender.push({ block: base, calIdx: 0, label: 'Calendar', interactive: true });
    } else if (posterCustomLayout && calendars.length >= 12) {
      calendars.slice(0, 12).forEach((cal, i) => {
        toRender.push({ block: cal, calIdx: i, label: MONTH_SHORT[i], interactive: true });
      });
    } else {
      // Auto-tile poster mode: draw 12 non-interactive preview cells, then a
      // single transparent "group handle" rect over the whole 4×3 bounding box.
      // Dragging/resizing the handle updates calendars[0] (the seed); the sync
      // effect rebuilds all 12 cells from the new seed.
      const base = calendars[0] ?? { x: 0, y: 0, width: 0.25, height: 0.2 };
      const maxCellW = Math.max(0.01, (1 - base.x) / 4);
      const maxCellH = Math.max(0.01, (1 - base.y) / 3);
      const cellW = Math.min(base.width, maxCellW);
      const cellH = Math.min(base.height, maxCellH);

      // 12 preview cells (non-interactive) — queued; handle added AFTER so it
      // sits on top in Fabric's z-order and receives pointer events first.
      for (let i = 0; i < 12; i++) {
        const col = i % 4;
        const row = Math.floor(i / 4);
        toRender.push({
          block: {
            x: base.x + col * cellW,
            y: base.y + row * cellH,
            width:  cellW,
            height: cellH,
          },
          calIdx: -1,
          label: MONTH_SHORT[i],
          interactive: false,
        });
      }
    }

    toRender.forEach(({ block, calIdx, label, interactive }) => {
      const bx = block.x * cw;
      const by = block.y * ch;
      const bw = block.width  * cw;
      const bh = block.height * ch;

      const rect = new Rect({
        left: bx, top: by,
        width: bw, height: bh,
        originX: 'left', originY: 'top',
        fill:   'rgba(14, 165, 233, 0.12)',
        stroke: interactive ? '#0ea5e9' : '#7dd3fc',
        strokeWidth: interactive ? 1.5 : 1,
        strokeDashArray: interactive ? [4, 3] : [2, 4],
        selectable: interactive,
        hasControls: interactive,
        lockRotation: true,
        cornerColor: '#0ea5e9',
        cornerSize: 8,
        cornerStyle: 'circle' as const,
        transparentCorners: false,
        borderColor: '#0ea5e9',
        borderDashArray: [3, 3],
      });
      rect.__calPreview = true;
      rect.__fabricEditor = 'calendar';
      rect.__calendarIdx = calIdx;
      if (interactive) rect.setControlsVisibility({ mtr: false });
      fc.add(rect);

      const fontSize = Math.max(8, Math.min(11, bh * 0.15));
      const lbl = new FabricText(label, {
        left: bx + 4, top: by + 4,
        originX: 'left', originY: 'top',
        fontSize, fontWeight: 'bold', fontFamily: 'sans-serif',
        fill: '#fff', backgroundColor: '#0ea5e9',
        padding: 2,
        selectable: false, evented: false,
      });
      lbl.__calPreview = true;
      lbl.__fabricEditor = 'calendarLabel';
      lbl.__calendarIdx = calIdx;
      fc.add(lbl);
    });

    // Auto-tile group handle — added last so it sits on TOP of the 12 cells
    // in Fabric's z-order and receives pointer events correctly.
    if (mode === 'poster' && !posterCustomLayout) {
      const base = calendars[0] ?? { x: 0, y: 0, width: 0.25, height: 0.2 };
      const maxCellW = Math.max(0.01, (1 - base.x) / 4);
      const maxCellH = Math.max(0.01, (1 - base.y) / 3);
      const cellW = Math.min(base.width, maxCellW);
      const cellH = Math.min(base.height, maxCellH);
      const gridW = cellW * 4;
      const gridH = cellH * 3;
      const handle = new Rect({
        left: base.x * cw, top: base.y * ch,
        width: gridW * cw, height: gridH * ch,
        originX: 'left', originY: 'top',
        fill: 'transparent',
        stroke: '#0ea5e9',
        strokeWidth: 2,
        strokeDashArray: [6, 4],
        selectable: true,
        hasControls: true,
        lockRotation: true,
        cornerColor: '#0ea5e9',
        cornerSize: 10,
        cornerStyle: 'circle' as const,
        transparentCorners: false,
        borderColor: '#0ea5e9',
        borderDashArray: [4, 3],
      });
      handle.__calPreview = true;
      handle.__fabricEditor = 'calendar';
      handle.__calendarIdx = 0;
      (handle as any).__isAutoTileHandle = true;
      (handle as any).__cellColsRows = { cols: 4, rows: 3 };
      handle.setControlsVisibility({ mtr: false });
      fc.add(handle);
    }

    fc.renderAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, calendars, mode, posterCustomLayout, widthMm, heightMm, snapGrid, getScale]);

  // ── Fabric events → parent state ─────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    const scale = getScale();
    const round3 = (v: number) => Math.round(v * 1000) / 1000;

    const handleModified = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || !target.__calPreview) return;

      const cw = widthMm * scale;
      const ch = heightMm * scale;
      constrainToCanvas(target, cw, ch);

      const left = target.left ?? 0;
      const top  = target.top  ?? 0;
      const w    = (target.width  ?? 0) * (target.scaleX ?? 1);
      const h    = (target.height ?? 0) * (target.scaleY ?? 1);
      target.set({ width: w, height: h, scaleX: 1, scaleY: 1 });

      const nx = round3(left / cw);
      const ny = round3(top  / ch);
      const nw = round3(w    / cw);
      const nh = round3(h    / ch);

      isSyncingRef.current = true;

      if (target.__fabricEditor === 'frame') {
        const idx = target.__frameIdx as number;
        const updated = framesRef.current.map((f, i) =>
          i !== idx ? f : { ...f, x: nx, y: ny, width: nw, height: nh },
        );
        onFramesChange(updated);
      } else if (target.__fabricEditor === 'calendar') {
        const idx = target.__calendarIdx as number;
        if (idx >= 0) {
          if ((target as any).__isAutoTileHandle) {
            // Handle covers the full 4×3 grid; back-compute per-cell seed
            const { cols, rows } = (target as any).__cellColsRows ?? { cols: 4, rows: 3 };
            const seedW = round3(nw / cols);
            const seedH = round3(nh / rows);
            onCalendarsChange([{ x: nx, y: ny, width: seedW, height: seedH }]);
          } else {
            const updated = calendarsRef.current.map((c, i) =>
              i !== idx ? c : { ...c, x: nx, y: ny, width: nw, height: nh },
            );
            onCalendarsChange(updated);
          }
        }
      }

      requestAnimationFrame(() => { isSyncingRef.current = false; });
    };

    const handleMoving = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || !target.__calPreview) return;

      const cw = widthMm * scale;
      const ch = heightMm * scale;

      if (snapGrid) {
        const gridPx = GRID_SNAP_MM * scale;
        target.set({
          left: snapToGrid(target.left ?? 0, gridPx),
          top:  snapToGrid(target.top  ?? 0, gridPx),
        });
      }
      constrainToCanvas(target, cw, ch);

      if ((target as any).__isAutoTileHandle) {
        // Co-move all 12 non-interactive cells + their labels to follow
        // the group handle during drag so the visual stays coherent.
        const { cols, rows } = (target as any).__cellColsRows ?? { cols: 4, rows: 3 };
        const hLeft = target.left ?? 0;
        const hTop  = target.top  ?? 0;
        const hW    = (target.width  ?? 0) * (target.scaleX ?? 1);
        const hH    = (target.height ?? 0) * (target.scaleY ?? 1);
        const cellW = hW / cols;
        const cellH = hH / rows;

        // cells are stored with calIdx === -1
        const cells = fc.getObjects().filter((o: any) =>
          o.__calPreview && o.__fabricEditor === 'calendar' &&
          !(o as any).__isAutoTileHandle && (o as any).__calendarIdx === -1
        );
        const lbls = fc.getObjects().filter((o: any) =>
          o.__calPreview && o.__fabricEditor === 'calendarLabel' &&
          (o as any).__calendarIdx === -1
        );
        cells.forEach((cell: any, i: number) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          cell.set({ left: hLeft + col * cellW, top: hTop + row * cellH });
        });
        lbls.forEach((lbl: any, i: number) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          lbl.set({ left: hLeft + col * cellW + 4, top: hTop + row * cellH + 4 });
        });
      } else {
        // Keep the associated label glued to a normal frame or calendar block.
        const isFrame   = target.__fabricEditor === 'frame';
        const labelType = isFrame ? 'label' : 'calendarLabel';
        const idxKey    = isFrame ? '__frameIdx' : '__calendarIdx';
        const targetIdx = (target as any)[idxKey];

        fc.getObjects().filter((o: any) =>
          o.__calPreview && o.__fabricEditor === labelType && (o as any)[idxKey] === targetIdx
        ).forEach((lbl: any) => {
          lbl.set({ left: (target.left ?? 0) + 4, top: (target.top ?? 0) + 4 });
        });
      }
    };

    const handleScaling = (e: any) => {
      const target = e.target as FabricObject;
      if (!target || !target.__calPreview) return;

      const cw = widthMm * scale;
      const ch = heightMm * scale;
      const minPx = 5 * scale;
      const w = (target.width  ?? 0) * (target.scaleX ?? 1);
      const h = (target.height ?? 0) * (target.scaleY ?? 1);
      if (w < minPx) target.set({ scaleX: minPx / (target.width  ?? 1) });
      if (h < minPx) target.set({ scaleY: minPx / (target.height ?? 1) });
      constrainToCanvas(target, cw, ch);

      // Resize 12 cells live when scaling the group handle
      if ((target as any).__isAutoTileHandle) {
        const { cols, rows } = (target as any).__cellColsRows ?? { cols: 4, rows: 3 };
        const hLeft = target.left ?? 0;
        const hTop  = target.top  ?? 0;
        const hW    = (target.width  ?? 0) * (target.scaleX ?? 1);
        const hH    = (target.height ?? 0) * (target.scaleY ?? 1);
        const cellW = hW / cols;
        const cellH = hH / rows;

        const cells = fc.getObjects().filter((o: any) =>
          o.__calPreview && o.__fabricEditor === 'calendar' &&
          !(o as any).__isAutoTileHandle && (o as any).__calendarIdx === -1
        );
        const lbls = fc.getObjects().filter((o: any) =>
          o.__calPreview && o.__fabricEditor === 'calendarLabel' &&
          (o as any).__calendarIdx === -1
        );
        cells.forEach((cell: any, i: number) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          cell.set({ left: hLeft + col * cellW, top: hTop + row * cellH, width: cellW, height: cellH, scaleX: 1, scaleY: 1 });
        });
        lbls.forEach((lbl: any, i: number) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          lbl.set({ left: hLeft + col * cellW + 4, top: hTop + row * cellH + 4 });
        });
      }
    };

    fc.on('object:modified', handleModified);
    fc.on('object:moving',   handleMoving);
    fc.on('object:scaling',  handleScaling);
    return () => {
      fc.off('object:modified', handleModified);
      fc.off('object:moving',   handleMoving);
      fc.off('object:scaling',  handleScaling);
    };
  }, [widthMm, heightMm, snapGrid, onFramesChange, onCalendarsChange, getScale]);

  // ── Mask overlay (paper shape) ───────────────────────────────────────────

  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    // Remove any existing mask layer
    const existing = fc.getObjects().find((o: any) => o.__calPreview && o.__fabricEditor === 'mask');
    if (existing) fc.remove(existing);

    const src = maskFile ? URL.createObjectURL(maskFile) : maskUrl ?? null;
    if (!src) return;

    const scale = getScale();
    const cw = widthMm * scale;
    const ch = heightMm * scale;

    FabricImage.fromURL(src).then((img) => {
      if (!fabricRef.current) return;
      img.scaleToWidth(cw);
      img.scaleToHeight(ch);
      img.set({ left: 0, top: 0, originX: 'left', originY: 'top',
        selectable: false, evented: false, opacity: 0.55 });
      img.__calPreview = true;
      img.__fabricEditor = 'mask';
      fabricRef.current.add(img);
      fabricRef.current.renderAll();
    }).catch(() => {/* silently ignore broken URLs */});

    return () => {
      if (maskFile && src) URL.revokeObjectURL(src);
    };
  }, [maskFile, maskUrl, widthMm, heightMm, getScale]);

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
