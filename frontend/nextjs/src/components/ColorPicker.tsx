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
    <div className={`flex items-center gap-2 ${className}`}>
      {label && (
        <span className="text-[9px] font-bold text-slate-400 uppercase whitespace-nowrap">
          {label}
        </span>
      )}
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-8 h-7 rounded-lg border border-slate-200 cursor-pointer"
      />
      {showHex && (
        <span className="text-[10px] font-mono text-slate-400">{value}</span>
      )}
    </div>
  );
}
