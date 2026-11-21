'use client';

import React, { useEffect, useMemo } from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import type { MaskSlotSource } from './LayoutFabricPreview';

/**
 * One mask slot: pick, thumbnail, file name, remove. The two slots differ only
 * in where they are placed, which is what decides whether they print.
 */
export function MaskSlotRow({ title, hint, slot, inputRef, warning, onPick, onRemove }: {
  title: string;
  hint: string;
  slot: MaskSlotSource;
  inputRef: React.RefObject<HTMLInputElement | null>;
  warning?: string;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  // A picked file previews through an object URL (same pattern as the book
  // editor's mask preview), released when the file changes or the row unmounts.
  const previewSrc = useMemo(() => (slot.file ? URL.createObjectURL(slot.file) : slot.url), [slot.file, slot.url]);
  useEffect(() => {
    if (!slot.file || !previewSrc) return;
    return () => URL.revokeObjectURL(previewSrc);
  }, [slot.file, previewSrc]);
  const has = Boolean(slot.file || slot.url);
  return (
    <div className="space-y-2">
      <div className="flex flex-col">
        <span className="text-xs font-bold text-slate-700">{title}</span>
        <span className="text-[10px] text-slate-500">{hint}</span>
      </div>
      <input
        type="file"
        ref={inputRef}
        className="hidden"
        accept="image/png,image/svg+xml,.svg"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
        }}
      />
      {!has && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="w-full px-4 py-2.5 border border-slate-200 border-dashed rounded-lg text-xs font-bold text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition-all flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Upload PNG or SVG
        </button>
      )}
      {warning && (
        <div className="px-3 py-2 bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-bold rounded-lg flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {warning}
        </div>
      )}
      {has && (
        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
          <div
            className="w-20 h-20 shrink-0 rounded-md border border-slate-200 overflow-hidden"
            style={{ backgroundImage: 'repeating-conic-gradient(#e2e8f0 0% 25%, #fff 0% 50%)', backgroundSize: '12px 12px' }}
          >
            {previewSrc && <img src={previewSrc} alt={`${title} mask`} className="w-full h-full object-contain" />}
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-xs font-bold text-slate-700 truncate">
              {slot.file ? slot.file.name : (slot.url ?? '').split('?')[0].split('/').pop()}
            </span>
            <span className="text-[10px] text-slate-500">
              {slot.file ? 'Not saved yet — saves with the layout' : 'Saved mask'}
            </span>
          </div>
          <button
            type="button"
            title={`Remove ${title.toLowerCase()}`}
            aria-label={`Remove ${title.toLowerCase()}`}
            onClick={onRemove}
            className="p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
