'use client';

import { useRef } from 'react';
import type React from 'react';
import { getCanvasSpec, getFrames } from '@/lib/layout-utils';
import { getImageMetadata } from '@/lib/image-utils';
import type { CanvasItem, SurfaceState } from './types';

/** Drag-to-pan a photo inside its grid card (only while repositionMode is
 *  on). Coalesces moves to one re-render per frame, serialised, and leaves a
 *  flag that swallows the click that ends a drag. */
export function usePanGesture({ repositionMode, surfaceStates, canvases, layout, updateCanvasState }: {
  repositionMode: boolean;
  surfaceStates: SurfaceState[];
  canvases: CanvasItem[];
  layout: any;
  updateCanvasState: (idx: number, surfaceKey: string | null, updateFn: (c: CanvasItem) => CanvasItem | Promise<CanvasItem>) => Promise<CanvasItem | undefined>;
}) {
  /** Live drag state, captured on pointerdown so pointermove stays synchronous. */
  const panRef = useRef<{
    pointerId: number; idx: number; surfaceKey: string | null; frameIdx: number;
    startX: number; startY: number; startOffset: { x: number; y: number };
    ratioX: number; ratioY: number; panRoomX: number; panRoomY: number; moved: boolean;
  } | null>(null);
  /** Serialises re-renders so out-of-order thumbnails can't land. */
  const panQueueRef = useRef<Promise<void>>(Promise.resolve());
  const panPendingRef = useRef<{ x: number; y: number } | null>(null);
  const panFlushScheduledRef = useRef(false);
  /** Set when a drag actually moved, so the card's onClick doesn't open the editor. */
  const panSuppressClickRef = useRef(false);

  // ── Drag-to-pan on grid cards (gated by repositionMode) ────────────────────

  /** Resolve the layout def + canvas dims + frame specs for a card. */
  const panGeometry = (surfaceKey: string | null) => {
    const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
    const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
    const frames = getFrames(layoutDef) || [{ x: 0, y: 0, width: 1, height: 1 }];
    return { canvasW: canvasSpec.width, canvasH: canvasSpec.height, frames };
  };

  /** Push the latest offset, coalesced to one re-render per frame and serialised. */
  const commitPan = (p: NonNullable<typeof panRef.current>, x: number, y: number, immediate = false) => {
    panPendingRef.current = { x, y };
    const flush = () => {
      const pending = panPendingRef.current;
      panPendingRef.current = null;
      if (!pending) return;
      panQueueRef.current = panQueueRef.current
        .then(() => updateCanvasState(p.idx, p.surfaceKey, c => ({
          ...c,
          frames: c.frames.map((f, i) => i === p.frameIdx ? { ...f, offset: { x: pending.x, y: pending.y } } : f),
        })).then(() => {}))
        .catch(() => {});
    };
    if (immediate) { flush(); return; }
    if (panFlushScheduledRef.current) return;
    panFlushScheduledRef.current = true;
    requestAnimationFrame(() => { panFlushScheduledRef.current = false; flush(); });
  };

  const handlePanStart = async (e: React.PointerEvent<HTMLDivElement>, idx: number, surfaceKey: string | null = null) => {
    if (!repositionMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const host = e.currentTarget;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const canvas = surfaceKey
      ? surfaceStates.find(s => s.key === surfaceKey)?.canvases[idx]
      : canvases[idx];
    if (!canvas) return;

    const { canvasW, canvasH, frames } = panGeometry(surfaceKey);
    const ratioX = canvasW / rect.width;
    const ratioY = canvasH / rect.height;

    // Which frame is under the pointer? (single-frame layouts always hit 0)
    const px = (e.clientX - rect.left) * ratioX;
    const py = (e.clientY - rect.top) * ratioY;
    let frameIdx = 0;
    frames.forEach((fs: any, i: number) => {
      const isPct = fs.width <= 1 && fs.height <= 1;
      const fx = isPct ? fs.x * canvasW : fs.x;
      const fy = isPct ? fs.y * canvasH : fs.y;
      const fw = isPct ? fs.width * canvasW : fs.width;
      const fh = isPct ? fs.height * canvasH : fs.height;
      if (px >= fx && px <= fx + fw && py >= fy && py <= fy + fh) frameIdx = i;
    });

    const frame = canvas.frames[frameIdx];
    if (!frame?.originalFile) return; // nothing to pan (state restored without the File)

    const { width: iw, height: ih } = await getImageMetadata(frame.originalFile);
    const rad = ((frame.rotation || 0) * Math.PI) / 180;
    const effW = Math.abs(iw * Math.cos(rad)) + Math.abs(ih * Math.sin(rad));
    const effH = Math.abs(iw * Math.sin(rad)) + Math.abs(ih * Math.cos(rad));

    const fs = frames[frameIdx] || { x: 0, y: 0, width: 1, height: 1 };
    const isPct = fs.width <= 1 && fs.height <= 1;
    const fw = isPct ? fs.width * canvasW : fs.width;
    const fh = isPct ? fs.height * canvasH : fs.height;

    const base = frame.fitMode === 'contain'
      ? Math.min(fw / effW, fh / effH)
      : Math.max(fw / effW, fh / effH);
    const scale = base * (frame.scale || 1);

    // Pan room is the half-difference between the scaled image and the frame.
    // cover  → image overflows, pan reveals hidden edges (never exposes bg).
    // contain → image is inset, pan slides it to the frame edge (never leaves).
    const panRoomX = Math.abs(effW * scale - fw) / 2;
    const panRoomY = Math.abs(effH * scale - fh) / 2;

    try { host.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    panRef.current = {
      pointerId: e.pointerId, idx, surfaceKey, frameIdx,
      startX: e.clientX, startY: e.clientY, startOffset: { ...frame.offset },
      ratioX, ratioY, panRoomX, panRoomY, moved: false,
    };
  };

  const handlePanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || e.pointerId !== p.pointerId) return;
    const dx = (e.clientX - p.startX) * p.ratioX;
    const dy = (e.clientY - p.startY) * p.ratioY;
    if (!p.moved && (Math.abs(e.clientX - p.startX) > 3 || Math.abs(e.clientY - p.startY) > 3)) p.moved = true;
    const nx = Math.max(-p.panRoomX, Math.min(p.panRoomX, p.startOffset.x + dx));
    const ny = Math.max(-p.panRoomY, Math.min(p.panRoomY, p.startOffset.y + dy));
    commitPan(p, nx, ny);
  };

  const handlePanEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || e.pointerId !== p.pointerId) return;
    panRef.current = null;
    try { e.currentTarget.releasePointerCapture(p.pointerId); } catch { /* already released */ }
    if (!p.moved) return;
    panSuppressClickRef.current = true; // swallow the click that follows a drag
    const dx = (e.clientX - p.startX) * p.ratioX;
    const dy = (e.clientY - p.startY) * p.ratioY;
    const nx = Math.max(-p.panRoomX, Math.min(p.panRoomX, p.startOffset.x + dx));
    const ny = Math.max(-p.panRoomY, Math.min(p.panRoomY, p.startOffset.y + dy));
    commitPan(p, nx, ny, true); // final position always lands
  };

  return { handlePanStart, handlePanMove, handlePanEnd, panSuppressClickRef };
}
