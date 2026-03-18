'use client';

import React, { useState } from 'react';
import { Layers, Type, Trash2, Image as ImageIcon, ChevronUp, Pentagon, ImagePlus } from 'lucide-react';
import { clsx } from 'clsx';
import type { CanvasItem } from './types';

// ─── Layer selection model ────────────────────────────────────────────────────

export type LayerSelection =
  | { type: 'frame'; index: number }
  | { type: 'text'; index: number }
  | { type: 'shape'; index: number }
  | { type: 'image'; index: number };

// ─── Props ────────────────────────────────────────────────────────────────────

interface LayersPanelProps {
  editingCanvas: CanvasItem;
  selected: LayerSelection | null;
  onSelect: (layer: LayerSelection) => void;
  onDeleteText: (textIndex: number) => void;
  onDeleteShape: (shapeIndex: number) => void;
  onDeleteImage: (imageIndex: number) => void;
  onClearFrame: (frameIndex: number) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LayersPanel({
  editingCanvas, selected, onSelect, onDeleteText, onDeleteShape, onDeleteImage, onClearFrame,
}: LayersPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const frames = editingCanvas.frames;
  const texts = editingCanvas.textOverlays;
  const shapes = editingCanvas.shapeOverlays;
  const images = editingCanvas.imageOverlays || [];
  const totalLayers = frames.length + texts.length + shapes.length + images.length;

  return (
    <div className="border-t bg-white">
      {/* Collapse toggle header */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-50 transition-all"
      >
        <p className="text-[10px] font-bold text-orange-500 uppercase tracking-wider flex items-center gap-1.5">
          <Layers className="w-3 h-3" /> Layers
          <span className="text-[9px] font-medium text-slate-400 ml-1">{totalLayers}</span>
        </p>
        <ChevronUp className={clsx('w-3.5 h-3.5 text-slate-400 transition-transform duration-200', expanded ? '' : 'rotate-180')} />
      </button>

      {/* Collapsible layer list — slides up from bottom */}
      <div className={clsx(
        'overflow-hidden transition-all duration-200 ease-in-out',
        expanded ? 'max-h-48' : 'max-h-0',
      )}>
        <div className="overflow-y-auto max-h-48 border-t border-slate-100">
          {/* Text overlays — highest z-order, listed first */}
          {texts.map((overlay, oIdx) => {
            const isSelected = selected?.type === 'text' && selected.index === oIdx;
            return (
              <div
                key={`text-${overlay.id}`}
                onClick={() => onSelect({ type: 'text', index: oIdx })}
                className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-all group',
                  isSelected
                    ? 'bg-indigo-50 border-l-2 border-indigo-500'
                    : 'hover:bg-slate-50 border-l-2 border-transparent',
                )}
              >
                <Type className="w-3 h-3 flex-shrink-0 text-orange-400" />
                <span className={clsx(
                  'text-[11px] font-medium truncate flex-1',
                  isSelected ? 'text-indigo-700' : 'text-slate-600',
                )}>
                  {overlay.text.trim() || 'Empty text'}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onDeleteText(oIdx); }}
                  className="p-0.5 text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded"
                  title="Delete text"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* Shape overlays — middle z-order */}
          {shapes.map((shape, sIdx) => {
            const isSelected = selected?.type === 'shape' && selected.index === sIdx;
            return (
              <div
                key={`shape-${shape.id}`}
                onClick={() => onSelect({ type: 'shape', index: sIdx })}
                className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-all group',
                  isSelected
                    ? 'bg-indigo-50 border-l-2 border-indigo-500'
                    : 'hover:bg-slate-50 border-l-2 border-transparent',
                )}
              >
                <Pentagon className="w-3 h-3 flex-shrink-0 text-purple-400" />
                <span className={clsx(
                  'text-[11px] font-medium truncate flex-1',
                  isSelected ? 'text-indigo-700' : 'text-slate-600',
                )}>
                  {shape.shapeType.charAt(0).toUpperCase() + shape.shapeType.slice(1).replace(/-/g, ' ')}
                </span>
                <div
                  className="w-3 h-3 rounded-sm border border-slate-200 flex-shrink-0"
                  style={{ backgroundColor: shape.fill }}
                />
                <button
                  onClick={e => { e.stopPropagation(); onDeleteShape(sIdx); }}
                  className="p-0.5 text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded"
                  title="Delete shape"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* Image overlays (clipart/icons) — between shapes and frames */}
          {images.map((imgOverlay, iIdx) => {
            const isSelected = selected?.type === 'image' && selected.index === iIdx;
            return (
              <div
                key={`image-${imgOverlay.id}`}
                onClick={() => onSelect({ type: 'image', index: iIdx })}
                className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-all group',
                  isSelected
                    ? 'bg-indigo-50 border-l-2 border-indigo-500'
                    : 'hover:bg-slate-50 border-l-2 border-transparent',
                )}
              >
                <ImagePlus className="w-3 h-3 flex-shrink-0 text-emerald-400" />
                <span className={clsx(
                  'text-[11px] font-medium truncate flex-1',
                  isSelected ? 'text-indigo-700' : 'text-slate-600',
                )}>
                  {imgOverlay.label || (imgOverlay.source === 'clipart' ? 'Clipart' : 'Icon')}
                </span>
                <span className="text-[8px] font-bold text-emerald-500 bg-emerald-50 px-1 py-0.5 rounded uppercase">
                  {imgOverlay.source}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onDeleteImage(iIdx); }}
                  className="p-0.5 text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded"
                  title="Delete image"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* Frame images — base layers, listed last */}
          {frames.map((frame, fIdx) => {
            const isSelected = selected?.type === 'frame' && selected.index === fIdx;
            const fileName = frame.originalFile?.name || `Image ${fIdx + 1}`;
            return (
              <div
                key={`frame-${frame.id}`}
                onClick={() => onSelect({ type: 'frame', index: fIdx })}
                className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-all group',
                  isSelected
                    ? 'bg-indigo-50 border-l-2 border-indigo-500'
                    : 'hover:bg-slate-50 border-l-2 border-transparent',
                )}
              >
                <ImageIcon className="w-3 h-3 flex-shrink-0 text-sky-400" />
                <span className={clsx(
                  'text-[11px] font-medium truncate flex-1',
                  isSelected ? 'text-indigo-700' : 'text-slate-600',
                )}>
                  {frames.length > 1 ? `Frame ${fIdx + 1}` : fileName}
                </span>
                {frame.processedUrl && (
                  <span className="text-[8px] font-bold text-emerald-500 bg-emerald-50 px-1 py-0.5 rounded">AI</span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); onClearFrame(fIdx); }}
                  className="p-0.5 text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded"
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
