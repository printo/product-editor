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
  const [expanded, setExpanded] = useState(true);
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
    <div className="border-t bg-white flex flex-col">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-50 transition-all border-b border-slate-100"
      >
        <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider flex items-center gap-1.5">
          <Layers className="w-3 h-3" /> Layers
          <span className="text-[9px] font-medium text-slate-400 ml-1">{totalLayers}</span>
        </p>
        <ChevronUp className={clsx('w-3.5 h-3.5 text-slate-400 transition-transform duration-200', expanded ? '' : 'rotate-180')} />
      </button>

      <div className={clsx('overflow-y-auto transition-all', expanded ? 'max-h-64' : 'max-h-0')}>
        <div className="flex flex-col">
          {/* Overlays (Text, Shape, Image) — Listed front-to-back (reverse array) */}
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
                  'flex items-center gap-2 px-3 py-2 cursor-pointer transition-all group border-b border-slate-50',
                  isSelected ? 'bg-violet-50 border-l-2 border-violet-500' : 'hover:bg-slate-50 border-l-2 border-transparent',
                  isDragging && 'opacity-30'
                )}
              >
                <GripVertical className="w-3 h-3 text-slate-300 group-hover:text-slate-400 cursor-grab" />
                
                {overlay.type === 'text' && <Type className="w-3 h-3 text-pink-400" />}
                {overlay.type === 'shape' && <Hexagon className="w-3 h-3 text-purple-400" />}
                {overlay.type === 'image' && <ImagePlus className="w-3 h-3 text-emerald-400" />}

                <span className={clsx('text-[11px] font-medium truncate flex-1', isSelected ? 'text-violet-700' : 'text-slate-600')}>
                  {overlay.type === 'text' ? (overlay.text.trim() || 'Text') : 
                   overlay.type === 'shape' ? (overlay.shapeType.replace(/-/g, ' ')) : 
                   overlay.label || 'Icon'}
                </span>

                <button
                  onClick={e => { e.stopPropagation(); onDeleteOverlay(oIdx); }}
                  className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded hover:bg-red-50"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* Frames — Always at the bottom */}
          {frames.map((frame, fIdx) => {
            const isSelected = selected?.type === 'frame' && selected.index === fIdx;
            return (
              <div
                key={`frame-${frame.id}`}
                onClick={() => onSelect({ type: 'frame', index: fIdx })}
                className={clsx(
                  'flex items-center gap-2 px-3 py-2 cursor-pointer transition-all group border-b border-slate-50',
                  isSelected ? 'bg-sky-50 border-l-2 border-sky-500' : 'hover:bg-slate-50 border-l-2 border-transparent',
                )}
              >
                <div className="w-3 h-3" /> {/* Spacer for grip alignment */}
                <ImageIcon className="w-3 h-3 text-sky-400" />
                <span className={clsx('text-[11px] font-medium truncate flex-1', isSelected ? 'text-sky-700' : 'text-slate-600')}>
                  {frames.length > 1 ? `Frame ${fIdx + 1}` : (frame.originalFile?.name || 'Base Image')}
                </span>
                {frame.processedUrl && <span className="text-[8px] font-black text-emerald-500 bg-emerald-50 px-1 py-0.5 rounded-full border border-emerald-100 uppercase tracking-tighter">AI</span>}
                <button
                  onClick={e => { e.stopPropagation(); onClearFrame(fIdx); }}
                  className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded hover:bg-red-50"
                  title="Reset image"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
