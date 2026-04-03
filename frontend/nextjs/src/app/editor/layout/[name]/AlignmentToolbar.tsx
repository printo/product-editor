'use client';

import React from 'react';
import {
  AlignLeft, AlignCenter, AlignRight,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
} from 'lucide-react';
import { clsx } from 'clsx';

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

interface AlignmentToolbarProps {
  onHAlign: (key: HAlign) => void;
  onVAlign: (key: VAlign) => void;
  /** Highlighted horizontal key (optional) */
  activeH?: HAlign | null;
  /** Highlighted vertical key (optional) */
  activeV?: VAlign | null;
  /** Extra element rendered after the button groups */
  suffix?: React.ReactNode;
}

const H_ITEMS: { key: HAlign; icon: typeof AlignLeft; tip: string }[] = [
  { key: 'left', icon: AlignLeft, tip: 'Left' },
  { key: 'center', icon: AlignCenter, tip: 'Center' },
  { key: 'right', icon: AlignRight, tip: 'Right' },
];

const V_ITEMS: { key: VAlign; icon: typeof AlignStartHorizontal; tip: string }[] = [
  { key: 'top', icon: AlignStartHorizontal, tip: 'Top' },
  { key: 'middle', icon: AlignCenterHorizontal, tip: 'Middle' },
  { key: 'bottom', icon: AlignEndHorizontal, tip: 'Bottom' },
];

export function AlignmentToolbar({ onHAlign, onVAlign, activeH, activeV, suffix }: AlignmentToolbarProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
        {H_ITEMS.map(({ key, icon: Icon, tip }) => (
          <button key={key} title={tip}
            onClick={() => onHAlign(key)}
            className={clsx('p-1.5 rounded-md transition-all',
              activeH === key
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-indigo-600 hover:bg-white')}>
            <Icon className="w-3.5 h-3.5" />
          </button>
        ))}
      </div>
      <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
        {V_ITEMS.map(({ key, icon: Icon, tip }) => (
          <button key={key} title={tip}
            onClick={() => onVAlign(key)}
            className={clsx('p-1.5 rounded-md transition-all',
              activeV === key
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-indigo-600 hover:bg-white')}>
            <Icon className="w-3.5 h-3.5" />
          </button>
        ))}
      </div>
      {suffix}
    </div>
  );
}
