'use client';

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { SHAPE_CATALOG, type ShapeDef } from '@/lib/shape-catalog';
import type { ShapeOverlay } from './types';

// ─── Props ───────────────────────────────────────────────────────────────────

interface ShapesPickerProps {
  onAddShape: (shape: ShapeOverlay) => void;
}

// ─── Category tabs ───────────────────────────────────────────────────────────

const CATEGORIES = [
  { key: 'basic' as const, label: 'Basic' },
  { key: 'arrows' as const, label: 'Arrows' },
  { key: 'decorative' as const, label: 'Decorative' },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function ShapesPicker({ onAddShape }: ShapesPickerProps) {
  const [category, setCategory] = useState<'basic' | 'arrows' | 'decorative'>('basic');

  const filtered = SHAPE_CATALOG.filter(s => s.category === category);

  const handleAdd = (shape: ShapeDef) => {
    const overlay: ShapeOverlay = {
      id: Date.now(),
      shapeType: shape.key,
      svgPath: shape.svgPath,
      x: 35,
      y: 35,
      width: 15,
      height: 15,
      rotation: 0,
      fill: '#6366f1',
      stroke: '#000000',
      strokeWidth: 0,
      opacity: 1,
    };
    onAddShape(overlay);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col">
        <p className="text-[11px] font-medium text-slate-500 uppercase">Add Shape</p>
        <span className="text-[10px] text-slate-400 uppercase opacity-60">Vector Library</span>
      </div>

      {/* Category tabs */}
      <div className="flex items-center gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100 shadow-inner w-full">
        {CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => setCategory(cat.key)}
            className={clsx(
              'flex-1 px-2 py-2 text-[10px] font-medium rounded-lg transition-all text-center uppercase',
              category === cat.key
                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200 scale-100'
                : 'text-slate-400 hover:text-indigo-500 scale-[0.98]',
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Shape grid */}
      <div className="grid grid-cols-4 gap-2.5 p-3 bg-white border border-slate-100 rounded-2xl shadow-sm max-h-64 overflow-y-auto custom-scrollbar">
        {filtered.map(shape => (
          <button
            key={shape.key}
            onClick={() => handleAdd(shape)}
            title={shape.label}
            className="aspect-square p-2.5 bg-slate-50 border border-slate-100 rounded-xl hover:border-indigo-200 hover:bg-white hover:shadow-md transition-all group active:scale-90"
          >
            <svg
              viewBox="0 0 100 100"
              className="w-full h-full text-slate-400 group-hover:text-indigo-500 transition-all duration-300"
            >
              <path
                d={shape.svgPath}
                fill="currentColor"
                fillOpacity={0.1}
                stroke="currentColor"
                strokeWidth={4}
              />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
