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
      <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/80 p-1.5 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 backdrop-blur-md shadow-inner w-full">
        {CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => setCategory(cat.key)}
            className={clsx(
              'flex-1 px-2 py-2 text-[10px] font-black rounded-xl transition-all text-center',
              category === cat.key
                ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-500/20'
                : 'text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400',
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Shape grid */}
      <div className="grid grid-cols-4 gap-2 p-2 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-800/50">
        {filtered.map(shape => (
          <button
            key={shape.key}
            onClick={() => handleAdd(shape)}
            title={shape.label}
            className="aspect-square p-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-lg hover:shadow-indigo-500/10 transition-all group active:scale-95"
          >
            <svg
              viewBox="0 0 100 100"
              className="w-full h-full text-slate-400 dark:text-slate-600 group-hover:text-indigo-500 dark:group-hover:text-indigo-400 transition-colors"
            >
              <path
                d={shape.svgPath}
                fill="currentColor"
                fillOpacity={0.15}
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
