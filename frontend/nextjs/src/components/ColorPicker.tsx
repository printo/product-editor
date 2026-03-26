'use client';

import React from 'react';

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  label?: string;
  /** Show hex code next to swatch (default true) */
  showHex?: boolean;
  className?: string;
}

export function ColorPicker({
  value,
  onChange,
  label,
  showHex = true,
  className = '',
}: ColorPickerProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {label && (
        <span className="text-[11px] font-medium text-slate-500 uppercase">
          {label}
        </span>
      )}
      <div className="relative group flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl p-0.5 bg-white border border-slate-200 shadow-sm group-hover:shadow-md transition-all relative overflow-hidden">
          <input
            type="color"
            value={value}
            onChange={e => onChange(e.target.value)}
            className="absolute inset-0 w-full h-full scale-150 cursor-pointer opacity-0"
          />
          <div 
            className="w-full h-full rounded-lg border border-black/5"
            style={{ backgroundColor: value }}
          />
        </div>
        {showHex && (
          <div className="px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-100 group-hover:border-indigo-200 transition-all">
            <span className="text-[11px] font-mono font-medium text-slate-600 uppercase">{value}</span>
          </div>
        )}
      </div>
    </div>
  );
}
