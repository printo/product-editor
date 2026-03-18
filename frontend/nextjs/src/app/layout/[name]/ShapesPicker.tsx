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
    <div className="space-y-2">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Add Shape</p>

      {/* Category tabs */}
      <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
        {CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => setCategory(cat.key)}
            className={clsx(
              'flex-1 px-2 py-1 text-[10px] font-bold rounded-md transition-all text-center',
              category === cat.key
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Shape grid */}
      <div className="grid grid-cols-4 gap-1.5">
        {filtered.map(shape => (
          <button
            key={shape.key}
            onClick={() => handleAdd(shape)}
            title={shape.label}
            className="aspect-square p-2 bg-white border border-slate-200 rounded-lg hover:border-indigo-400 hover:bg-indigo-50/50 transition-all group"
          >
            <svg
              viewBox="0 0 100 100"
              className="w-full h-full text-slate-400 group-hover:text-indigo-500 transition-colors"
            >
              <path
                d={shape.svgPath}
                fill="currentColor"
                fillOpacity={0.2}
                stroke="currentColor"
                strokeWidth={3}
              />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
