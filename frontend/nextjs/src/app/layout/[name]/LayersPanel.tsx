'use client';

import React, { useState } from 'react';
import { Layers, Type, Trash2, Image as ImageIcon, ChevronUp, Hexagon, ImagePlus, GripVertical } from 'lucide-react';
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
  onSelect: (layer: LayerSelection) => void;
  onDeleteOverlay: (index: number) => void;
  onReorderOverlays: (newOverlays: Overlay[]) => void;
  onClearFrame: (frameIndex: number) => void;
}

export function LayersPanel({
  editingCanvas, selected, onSelect, onDeleteOverlay, onReorderOverlays, onClearFrame,
}: LayersPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const overlays = editingCanvas.overlays;
  const frames = editingCanvas.frames;
  const totalLayers = frames.length + overlays.length;

  // Handle DnD
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDraggedIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === idx) return;
  };

  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === targetIdx) return;

    const newOverlays = [...overlays];
    const [moved] = newOverlays.splice(draggedIdx, 1);
    newOverlays.splice(targetIdx, 0, moved);
    onReorderOverlays(newOverlays);
    setDraggedIdx(null);
  };

  return (
    <div className="bg-transparent flex flex-col overflow-hidden">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full py-1 flex items-center justify-between transition-all group"
      >
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-indigo-50 flex items-center justify-center group-hover:bg-indigo-100 transition-all">
            <Layers className="w-2.5 h-2.5 text-indigo-600" />
          </div>
          <p className="text-[10px] font-medium text-slate-500 uppercase">
            Layers
            <span className="text-[9px] text-slate-400 ml-1 tabular-nums opacity-60">({totalLayers})</span>
          </p>
        </div>
        <ChevronUp className={clsx('w-3 h-3 text-slate-300 transition-transform duration-500', expanded ? '' : 'rotate-180')} />
      </button>

      <div className={clsx('overflow-y-auto transition-all duration-500 custom-scrollbar', expanded ? 'max-h-56 mt-1' : 'max-h-0')}>
        <div className="flex flex-col gap-0.5 py-0.5">
          {/* Overlays (Text, Shape, Image) */}
          {[...overlays].reverse().map((overlay, revIdx) => {
            const oIdx = overlays.length - 1 - revIdx;
            const isSelected = selected?.index === oIdx && (selected.type === overlay.type);
            const isDragging = draggedIdx === oIdx;

            return (
              <div
                key={`overlay-${overlay.id}`}
                draggable
                onDragStart={(e) => handleDragStart(e, oIdx)}
                onDragOver={(e) => handleDragOver(e, oIdx)}
                onDrop={(e) => handleDrop(e, oIdx)}
                onClick={() => onSelect({ type: overlay.type, index: oIdx })}
                className={clsx(
                  'flex items-center gap-2 px-2 py-1 cursor-pointer transition-all group rounded-md border',
                  isSelected 
                    ? 'bg-white border-indigo-100 shadow-sm' 
                    : 'bg-transparent border-transparent hover:bg-white/50',
                  isDragging && 'opacity-30'
                )}
              >
                <GripVertical className={clsx('w-2.5 h-2.5 text-slate-200 group-hover:text-slate-300 cursor-grab')} />
                
                <div className={clsx('w-6 h-6 rounded flex items-center justify-center transition-all', 
                  isSelected ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100/50 text-slate-400')}>
                  {overlay.type === 'text' && <Type className="w-3 h-3" />}
                  {overlay.type === 'shape' && <Hexagon className="w-3 h-3" />}
                  {overlay.type === 'image' && <ImageIcon className="w-3 h-3" />}
                </div>

                <span className={clsx('text-[10px] font-medium truncate flex-1 uppercase', 
                  isSelected ? 'text-indigo-600' : 'text-slate-500')}>
                  {overlay.type === 'text' ? (overlay.text.trim() || 'Text') : 
                   overlay.type === 'shape' ? (overlay.shapeType.replace(/-/g, ' ')) : 
                   overlay.label || 'Icon'}
                </span>

                <button
                  onClick={e => { e.stopPropagation(); onDeleteOverlay(oIdx); }}
                  className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded opacity-0 group-hover:opacity-100 transition-all"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            );
          })}

          {/* Frames */}
          {frames.map((frame, fIdx) => {
            const isSelected = selected?.type === 'frame' && selected.index === fIdx;
            return (
              <div
                key={`frame-${frame.id}`}
                onClick={() => onSelect({ type: 'frame', index: fIdx })}
                className={clsx(
                  'flex items-center gap-2 px-2 py-1 cursor-pointer transition-all group rounded-md border',
                  isSelected 
                    ? 'bg-white border-indigo-100 shadow-sm' 
                    : 'bg-transparent border-transparent hover:bg-white/50',
                )}
              >
                <div className="w-2.5 h-2.5" />
                <div className={clsx('w-6 h-6 rounded flex items-center justify-center transition-all', 
                  isSelected ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100/50 text-slate-400')}>
                  <ImageIcon className="w-3 h-3" />
                </div>
                <span className={clsx('text-[10px] font-medium truncate flex-1 uppercase', 
                  isSelected ? 'text-indigo-600' : 'text-slate-500')}>
                  {frames.length > 1 ? `Frame ${fIdx + 1}` : (frame.originalFile?.name || 'Base Image')}
                </span>
                
                <button
                  onClick={e => { e.stopPropagation(); onClearFrame(fIdx); }}
                  className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded opacity-0 group-hover:opacity-100 transition-all"
                  title="Reset image"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
