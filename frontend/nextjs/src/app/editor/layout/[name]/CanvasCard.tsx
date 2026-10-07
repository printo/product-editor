'use client';

import type React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowLeftRight, Droplets, ImagePlus, Layout, Maximize, RotateCw, Trash2 } from 'lucide-react';
import { LazyImg } from '@/components/LazyImg';
import type { LowDpiFrame } from '@/lib/dpi-utils';
import { activatesCard } from './editor-utils';
import type { CanvasItem, SurfaceState } from './types';

type CardTarget = { idx: number; surfaceKey: string | null } | null;

/** What every card needs from the page: drag and pan, the quick actions, tap-to-swap. */
export type CardProps = {
  layout: { canvas?: { width?: number; height?: number }; frames?: unknown[] };
  dragOverIdx: CardTarget;
  setDragOverIdx: Dispatch<SetStateAction<CardTarget>>;
  repositionMode: boolean;
  handleDragStart: (e: React.DragEvent, idx: number, surfaceKey?: string | null) => void;
  handleDragOver: (e: React.DragEvent, idx: number, surfaceKey?: string | null) => void;
  handleDrop: (e: React.DragEvent, idx: number, surfaceKey?: string | null) => void;
  openEditor: (idx: number, surfaceKey?: string) => void;
  handleCardClick: (idx: number, surfaceKey?: string | null) => void;
  handlePanStart: (e: React.PointerEvent<HTMLDivElement>, idx: number, surfaceKey?: string | null) => void;
  handlePanMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  handlePanEnd: (e: React.PointerEvent<HTMLDivElement>) => void;
  requestReplacePhoto: (canvasIdx: number, frameIdx: number, surfaceKey?: string | null) => void;
  lowDpiByCard: Map<string, LowDpiFrame>;
  handleQuickRotate: (idx: number, surfaceKey?: string | null) => void;
  handleQuickToggleFit: (idx: number, surfaceKey?: string | null) => void;
  handleQuickToggleBlur: (idx: number, surfaceKey?: string | null) => void;
  swapSource: CardTarget;
  setSwapSource: Dispatch<SetStateAction<CardTarget>>;
  handleQuickDelete: (idx: number, surfaceKey?: string | null) => void;
};

/** One side of a multi-surface product (front/back, or a book page), with its own label and Edit button. */
export function SurfaceCard({
  surface, dragOverIdx, setDragOverIdx, repositionMode, handleDragStart, handleDragOver, handleDrop, openEditor,
  handleCardClick, handlePanStart, handlePanMove, handlePanEnd, requestReplacePhoto, lowDpiByCard,
  handleQuickRotate, handleQuickToggleFit, handleQuickToggleBlur, swapSource, setSwapSource, handleQuickDelete,
}: CardProps & { surface: SurfaceState }) {
    const cw = surface.def.canvas?.width || 1200;
    const ch = surface.def.canvas?.height || 1800;
    const surfaceCanvas = surface.canvases[0] || null;
    return (
      <div 
        className="shrink-0 flex flex-col gap-3"
        style={{ width: cw > ch ? '400px' : '280px' }}
        draggable={!repositionMode}
        onDragStart={(e) => handleDragStart(e, 0, surface.key)}
        onDragOver={(e) => handleDragOver(e, 0, surface.key)}
        onDragLeave={() => setDragOverIdx(null)}
        onDrop={(e) => handleDrop(e, 0, surface.key)}
      >
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-black text-slate-900 uppercase tracking-tight truncate">{surface.label}</h3>
          <button onClick={() => openEditor(0, surface.key)} className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100 uppercase tracking-wide">Edit</button>
        </div>
        <div className={clsx(
          "bg-white rounded-2xl border-2 transition-all overflow-hidden cursor-pointer group/card relative",
          dragOverIdx?.idx === 0 && dragOverIdx?.surfaceKey === surface.key 
            ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100" 
            : "border-slate-100 hover:border-indigo-400"
        )} onClick={() => handleCardClick(0, surface.key)}
          role="button"
          tabIndex={0}
          aria-label={`Edit ${surface.label || surface.key}`}
          onKeyDown={(e) => { if (activatesCard(e)) { e.preventDefault(); handleCardClick(0, surface.key); } }}
        >
          <div
            className={clsx(
              'relative overflow-hidden bg-slate-100',
              repositionMode && 'cursor-grab active:cursor-grabbing touch-none',
            )}
            style={{ aspectRatio: `${cw} / ${ch}` }}
            onPointerDown={(e) => handlePanStart(e, 0, surface.key)}
            onPointerMove={handlePanMove}
            onPointerUp={handlePanEnd}
            onPointerCancel={handlePanEnd}
          >
            {surfaceCanvas?.dataUrl ? <img src={surfaceCanvas.dataUrl} className="absolute inset-0 w-full h-full object-fill" alt={surface.label} /> : <div className="absolute inset-0 flex items-center justify-center text-slate-300"><Layout className="w-10 h-10 opacity-20" /></div>}

            {surfaceCanvas?.frames.some(f => (f.fileId || f.fileName) && !f.originalFile) ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const missingIdx = surfaceCanvas.frames.findIndex(f => (f.fileId || f.fileName) && !f.originalFile);
                  requestReplacePhoto(0, Math.max(0, missingIdx), surface.key);
                }}
                className="absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm bg-amber-50/90 border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors"
                title="This photo couldn't be recovered on this device — tap to re-upload it."
              >
                <AlertTriangle className="w-3 h-3" />
                Photo missing — tap to re-upload
              </button>
            ) : lowDpiByCard.has(`${surface.key}:0`) && (
              <div
                className={clsx(
                  'absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm',
                  lowDpiByCard.get(`${surface.key}:0`)!.severity === 'critical'
                    ? 'bg-rose-50/90 border-rose-200 text-rose-700'
                    : 'bg-amber-50/90 border-amber-200 text-amber-700'
                )}
                title="This photo is below print resolution — it may look soft or pixelated when printed. Use a larger photo or zoom out."
              >
                <AlertTriangle className="w-3 h-3" />
                Low res ~{Math.round(lowDpiByCard.get(`${surface.key}:0`)!.dpi)} DPI
              </div>
            )}

            <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 p-1.5 bg-white/40 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm">
              <button onClick={(e) => { e.stopPropagation(); handleQuickRotate(0, surface.key); }} className="p-2 bg-indigo-50/80 text-indigo-600 rounded-xl hover:bg-indigo-100 hover:scale-105 transition-all" title="Rotate 90°">
                <RotateCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(0, surface.key); }}
                className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all"
                title={surfaceCanvas?.frames.some(f => f.fitMode === 'contain')
                  ? 'Switch to Cover'
                  : 'Switch to Fit'}
              >
                <Maximize className="w-3.5 h-3.5" />
              </button>
              {/* Set Background Color — hidden from the UI on request, kept in
                  source in case it needs to come back. handleQuickSetBg itself
                  is untouched.
              <div className="relative">
                <button onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.nextElementSibling as HTMLInputElement; if (el) el.click(); }} className="p-2 bg-amber-50/80 text-amber-600 rounded-xl hover:bg-amber-100 hover:scale-105 transition-all" title="Set Background Color">
                  <Palette className="w-3.5 h-3.5" />
                </button>
                <input
                  type="color"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none"
                  value={surfaceCanvas?.bgColor || '#ffffff'}
                  onChange={(e) => handleQuickSetBg(0, e.target.value, surface.key)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              */}
              <button
                onClick={(e) => { e.stopPropagation(); handleQuickToggleBlur(0, surface.key); }}
                className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
                  surfaceCanvas?.frames.some(f => f.fillStyle === 'blur')
                    ? 'bg-indigo-600 text-white'
                    : 'bg-cyan-50/80 text-cyan-600 hover:bg-cyan-100')}
                title={surfaceCanvas?.frames.some(f => f.fillStyle === 'blur')
                  ? 'Remove Blur'
                  : 'Add Blur'}
              >
                <Droplets className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setSwapSource(prev =>
                    prev && prev.idx === 0 && prev.surfaceKey === surface.key ? null : { idx: 0, surfaceKey: surface.key }
                  );
                }}
                className={clsx('p-2 rounded-xl hover:scale-105 transition-all block md:hidden',
                  swapSource?.idx === 0 && swapSource?.surfaceKey === surface.key
                    ? 'bg-indigo-600 text-white'
                    : 'bg-violet-50/80 text-violet-600 hover:bg-violet-100')}
                title="Swap Photo"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
              </button>
              {/* Quick-download — hidden from the UI on request, kept in
                  source in case it needs to come back. handleQuickDownload
                  itself is untouched.
              <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(0, surface.key); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                <Download className="w-3.5 h-3.5" />
              </button>
              */}
              <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(0, surface.key); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Remove Photo">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="px-3 py-2 flex items-center justify-between bg-white border-t border-slate-50">
            <span className="text-[10px] font-bold text-slate-400">{surface.def.canvas?.widthMm}×{surface.def.canvas?.heightMm}mm</span>
          </div>
        </div>
      </div>
    );
}

/** One card of a single-surface product's grid: the print preview and its quick-action rail. */
export function CanvasCard({
  canvas, idx, layout, dragOverIdx, setDragOverIdx, repositionMode, handleDragStart, handleDragOver, handleDrop,
  handleCardClick, handlePanStart, handlePanMove, handlePanEnd, requestReplacePhoto, lowDpiByCard,
  handleQuickRotate, handleQuickToggleFit, handleQuickToggleBlur, swapSource, setSwapSource, handleQuickDelete,
}: CardProps & { canvas: CanvasItem; idx: number }) {
  return (
    <div className="w-[86vw] max-w-sm sm:w-auto sm:max-w-none">
      {/* Deliberately outside the bordered card below — this is a UI
          label, not part of the printed design, and boxing it together
          with the photo made it read as if it were. Dimensions/frame
          count are shown once already, in the page header above — not
          repeated per card. */}
      <div className="px-1 py-1.5">
        <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight truncate">
          Image {idx + 1}
        </h3>
      </div>
      <div
        className={clsx(
          // Mobile: one card per row, capped so ~1.5 cards show per
          // viewport (portrait prints) — a full-width 2-col card was
          // too short and clipped the quick-action rail.
          // Square corners throughout, no exceptions — this card is a
          // preview of the actual print shape (e.g. retro polaroid
          // layouts are square-cornered), and rounding any part of it,
          // even just the frame around the photo, reads as if the
          // print itself had rounded corners.
          "bg-white border-2 transition-all cursor-pointer group/card relative",
          dragOverIdx?.idx === idx && dragOverIdx?.surfaceKey === null
            ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100"
            : "border-slate-200 hover:border-indigo-400"
        )}
        onClick={() => handleCardClick(idx)}
        role="button"
        tabIndex={0}
        aria-label={`Edit canvas ${idx + 1}`}
        onKeyDown={(e) => { if (activatesCard(e)) { e.preventDefault(); handleCardClick(idx); } }}
        draggable={!repositionMode}
        onDragStart={(e) => handleDragStart(e, idx)}
        onDragOver={(e) => handleDragOver(e, idx)}
        onDragLeave={() => setDragOverIdx(null)}
        onDrop={(e) => handleDrop(e, idx)}
      >
        <div
          className={clsx(
            'relative overflow-hidden bg-slate-100',
            repositionMode && 'cursor-grab active:cursor-grabbing touch-none',
          )}
          style={{ aspectRatio: `${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}` }}
          onPointerDown={(e) => handlePanStart(e, idx)}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanEnd}
          onPointerCancel={handlePanEnd}
        >
          {canvas.dataUrl && <LazyImg src={canvas.dataUrl} className="absolute inset-0 w-full h-full object-fill" alt={`Canvas ${idx + 1}`} />}

        {canvas.frames.some(f => (f.fileId || f.fileName) && !f.originalFile) ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              const missingIdx = canvas.frames.findIndex(f => (f.fileId || f.fileName) && !f.originalFile);
              requestReplacePhoto(idx, Math.max(0, missingIdx));
            }}
            className="absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm bg-amber-50/90 border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors"
            title="This photo couldn't be recovered on this device — tap to re-upload it."
          >
            <AlertTriangle className="w-3 h-3" />
            Photo missing — tap to re-upload
          </button>
        ) : lowDpiByCard.has(`:${idx}`) && (
          <div
            className={clsx(
              'absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm',
              lowDpiByCard.get(`:${idx}`)!.severity === 'critical'
                ? 'bg-rose-50/90 border-rose-200 text-rose-700'
                : 'bg-amber-50/90 border-amber-200 text-amber-700'
            )}
            title="This photo is below print resolution — it may look soft or pixelated when printed. Use a larger photo or zoom out."
          >
            <AlertTriangle className="w-3 h-3" />
            Low res ~{Math.round(lowDpiByCard.get(`:${idx}`)!.dpi)} DPI
          </div>
        )}

        <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 p-1.5 bg-white/40 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm">
          <button onClick={(e) => { e.stopPropagation(); handleQuickRotate(idx); }} className="p-2 bg-indigo-50/80 text-indigo-600 rounded-xl hover:bg-indigo-100 hover:scale-105 transition-all" title="Rotate 90°">
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(idx); }}
            className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all"
            title={canvas.frames.some(f => f.fitMode === 'contain')
              ? 'Switch to Cover'
              : 'Switch to Fit'}
          >
            <Maximize className="w-3.5 h-3.5" />
          </button>
          {/* Set Background Color — hidden from the UI on request, kept in
              source in case it needs to come back. handleQuickSetBg itself
              is untouched.
          <div className="relative">
            <button onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.nextElementSibling as HTMLInputElement; if (el) el.click(); }} className="p-2 bg-amber-50/80 text-amber-600 rounded-xl hover:bg-amber-100 hover:scale-105 transition-all" title="Set Background Color">
              <Palette className="w-3.5 h-3.5" />
            </button>
            <input
              type="color"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none"
              value={canvas.bgColor || '#ffffff'}
              onChange={(e) => handleQuickSetBg(idx, e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          */}
          {(layout.frames?.length || 1) === 1 && (
            <button onClick={(e) => { e.stopPropagation(); requestReplacePhoto(idx, 0); }} className="p-2 bg-sky-50/80 text-sky-600 rounded-xl hover:bg-sky-100 hover:scale-105 transition-all" title="Replace Photo">
              <ImagePlus className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleQuickToggleBlur(idx); }}
            className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
              canvas.frames.some(f => f.fillStyle === 'blur')
                ? 'bg-indigo-600 text-white'
                : 'bg-cyan-50/80 text-cyan-600 hover:bg-cyan-100')}
            title={canvas.frames.some(f => f.fillStyle === 'blur')
              ? 'Remove Blur'
              : 'Add Blur'}
          >
            <Droplets className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSwapSource(prev =>
                prev && prev.idx === idx && prev.surfaceKey === null ? null : { idx, surfaceKey: null }
              );
            }}
            className={clsx('p-2 rounded-xl hover:scale-105 transition-all block md:hidden',
              swapSource?.idx === idx && swapSource?.surfaceKey === null
                ? 'bg-indigo-600 text-white'
                : 'bg-violet-50/80 text-violet-600 hover:bg-violet-100')}
            title="Swap Photo"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
          </button>
          {/* Quick-download — hidden from the UI on request, kept in
              source in case it needs to come back. handleQuickDownload
              itself is untouched.
          <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(idx); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
            <Download className="w-3.5 h-3.5" />
          </button>
          */}
          <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(idx); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Remove Photo">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
  );
}
