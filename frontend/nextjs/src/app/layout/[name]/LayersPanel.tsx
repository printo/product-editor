'use client';

import React, { useState } from 'react';
import { Layers, Type, Trash2, Image as ImageIcon, ChevronUp, Hexagon, ImagePlus, GripVertical, ChevronDown, Lock } from 'lucide-react';
import { clsx } from 'clsx';
import type { CanvasItem, Overlay } from './types';

export type LayerSelection =
  | { type: 'frame'; index: number }
  | { type: 'text'; index: number }
  | { type: 'shape'; index: number }
  | { type: 'image'; index: number }
  | { type: 'canvas'; index: number };

interface LayersPanelProps {
  editingCanvas: CanvasItem;
  selected: LayerSelection | null;
  onSelect: (sel: LayerSelection) => void;
  onDeleteOverlay: (idx: number) => void;
  onReorderOverlays: (overlays: Overlay[]) => void;
  onClearFrame: (idx: number) => void;
  onMoveFrameToOverlay: (fIdx: number, targetOIdx: number) => void;
}

export function LayersPanel({
  editingCanvas, selected, onSelect, onDeleteOverlay, onReorderOverlays, onClearFrame, onMoveFrameToOverlay,
}: LayersPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const overlays = editingCanvas.overlays;
  const frames = editingCanvas.frames;
  const totalLayers = frames.length + overlays.length;

  const handleMoveLayer = (idx: number, direction: 'up' | 'down') => {
    const newOverlays = [...overlays];
    const targetIdx = direction === 'up' ? idx + 1 : idx - 1;
    if (targetIdx < 0 || targetIdx >= overlays.length) return;
    const [moved] = newOverlays.splice(idx, 1);
    newOverlays.splice(targetIdx, 0, moved);
    onReorderOverlays(newOverlays);
    onSelect({ type: moved.type, index: targetIdx });
  };

  const handleMoveFrameToTop = (fIdx: number) => {
    // Moves frame to the bottom of overlays (which is top-most visually in reverse order)
    // ONLY if there are other layers to move over
    if (overlays.length === 0) return;
    onMoveFrameToOverlay(fIdx, overlays.length);
  };

  return (
    <div className="bg-transparent flex flex-col overflow-hidden">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full py-1.5 flex items-center justify-between transition-all group"
      >
        <div className="flex items-center gap-2.5">
          <Layers className="w-4 h-4 text-red-500" />
          <p className="text-[11px] font-bold text-slate-800 uppercase tracking-tight">
            Layers
            <span className="text-[9px] text-slate-500 ml-1.5 tabular-nums font-medium">({totalLayers})</span>
          </p>
        </div>
        <ChevronUp className={clsx('w-3.5 h-3.5 text-slate-400 transition-transform duration-500', expanded ? '' : 'rotate-180')} />
      </button>

      <div className={clsx('overflow-y-auto transition-all duration-500 custom-scrollbar', expanded ? 'max-h-52 mt-0.5' : 'max-h-0')}>
        <div className="flex flex-col gap-0.5 py-1">
          {/* Overlays (Text, Shape, Image) - Rendered in reverse (top-most first) */}
          {[...overlays].reverse().map((overlay, revIdx) => {
            const oIdx = overlays.length - 1 - revIdx;
            const isSelected = selected?.index === oIdx && (selected.type === overlay.type);
            const canMove = overlays.length > 1;

            return (
              <div
                key={`overlay-${overlay.id}`}
                onClick={() => onSelect({ type: overlay.type, index: oIdx })}
                className={clsx(
                  'flex items-center gap-1.5 px-2 py-0.5 cursor-pointer transition-all group rounded-lg border',
                  isSelected 
                    ? 'bg-white border-indigo-100 shadow-sm' 
                    : 'bg-transparent border-transparent hover:bg-white/40'
                )}
              >
                <div className={clsx('shrink-0 flex items-center justify-center transition-all', 
                  isSelected ? 'text-indigo-600' : 'text-slate-400')}>
                  {overlay.type === 'text' && <Type className="w-3 h-3" />}
                  {overlay.type === 'shape' && <Hexagon className="w-3 h-3" />}
                  {overlay.type === 'image' && <ImageIcon className="w-3 h-3" />}
                </div>

                <span className={clsx('text-[10px] font-bold truncate flex-1 uppercase tracking-tight', 
                  isSelected ? 'text-indigo-600' : 'text-slate-500')}>
                  {overlay.type === 'text' ? (overlay.text.trim() || 'Text') : 
                   overlay.type === 'shape' ? (overlay.shapeType.replace(/-/g, ' ')) : 
                   overlay.label || 'Icon'}
                </span>

                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {canMove && (
                    <>
                      <button
                        disabled={oIdx === overlays.length - 1}
                        onClick={e => { e.stopPropagation(); handleMoveLayer(oIdx, 'up'); }}
                        className="w-5.5 h-5.5 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-all disabled:opacity-10"
                        title="Move Up"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button
                        disabled={oIdx === 0}
                        onClick={e => { e.stopPropagation(); handleMoveLayer(oIdx, 'down'); }}
                        className="w-5.5 h-5.5 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-all disabled:opacity-10"
                        title="Move Down"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); onDeleteOverlay(oIdx); }}
                    className="w-5.5 h-5.5 flex items-center justify-center text-red-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-all"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}

          {/* Frames - Always at bottom */}
          {frames.map((frame, fIdx) => {
            const isSelected = selected?.type === 'frame' && selected.index === fIdx;
            const hasOverlays = overlays.length > 0;

            return (
              <div
                key={`frame-${frame.id}`}
                onClick={() => onSelect({ type: 'frame', index: fIdx })}
                className={clsx(
                  'flex items-center gap-1.5 px-2 py-0.5 cursor-pointer transition-all group rounded-lg border',
                  isSelected 
                    ? 'bg-white border-indigo-100 shadow-sm' 
                    : 'bg-transparent border-transparent hover:bg-white/40 opacity-60 grayscale-[0.5]'
                )}
              >
                <div className={clsx('shrink-0 flex items-center justify-center transition-all', 
                  isSelected ? 'text-indigo-600' : 'text-slate-300')}>
                  <Lock className="w-3 h-3" />
                </div>
                <span className={clsx('text-[10px] font-bold truncate flex-1 uppercase tracking-tight', 
                  isSelected ? 'text-indigo-600' : 'text-slate-400 italic')}>
                  {frames.length > 1 ? `Slot ${fIdx + 1}` : (frame.originalFile?.name || 'Base Layer')}
                </span>
                
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {frame.originalFile && hasOverlays && (
                    <button
                      onClick={e => { e.stopPropagation(); handleMoveFrameToTop(fIdx); }}
                      className="w-5.5 h-5.5 flex items-center justify-center text-emerald-500 hover:bg-emerald-50 rounded-md transition-all"
                      title="Bring to Top"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); onClearFrame(fIdx); }}
                    className="w-5.5 h-5.5 flex items-center justify-center text-red-300 hover:text-red-500 hover:bg-red-50 rounded-md transition-all"
                    title="Clear"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
