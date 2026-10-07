'use client';

import type React from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { clsx } from 'clsx';
import { Upload } from 'lucide-react';
import CanvasCardSkeleton from '@/components/CanvasCardSkeleton';
import type { CanvasItem } from './types';

type DragTarget = { idx: number, surfaceKey: string | null } | null;

/** Before the first card: placeholders while a saved design restores, else the
 *  drop zone that opens the photo picker. */
export function EmptyState({
  isProcessing, canvases, restorePending, restoreCount, layout, dragOverIdx, setDragOverIdx, uploadInputRef, handleFileChange,
}: {
  isProcessing: boolean;
  canvases: CanvasItem[];
  restorePending: boolean;
  restoreCount: number;
  layout: { canvas?: { width?: number; height?: number } };
  dragOverIdx: DragTarget;
  setDragOverIdx: Dispatch<SetStateAction<DragTarget>>;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
}) {
  return (
    <>
      {/* ── Restoring a saved design ──────────────────────────────────── */}
      {!isProcessing && canvases.length === 0 && restorePending && (
        <CanvasCardSkeleton
          count={restoreCount || 3}
          aspectRatio={`${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}`}
        />
      )}

      {/* ── Empty state (no canvases, not processing, nothing to restore) ─ */}
      {!isProcessing && canvases.length === 0 && !restorePending && (
        <div 
          className={clsx(
            "flex flex-col items-center justify-center py-24 gap-5 select-none border-2 border-dashed rounded-3xl transition-all cursor-pointer",
            dragOverIdx?.idx === -1 
              ? "border-indigo-500 bg-indigo-50/50 scale-[1.01]" 
              : "border-slate-200 bg-slate-50/50"
          )}
          role="button"
          tabIndex={0}
          onClick={() => uploadInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault();
              uploadInputRef.current?.click();
            }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOverIdx({ idx: -1, surfaceKey: null }); }}
          onDragLeave={() => setDragOverIdx(null)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOverIdx(null);
            const droppedFiles = Array.from(e.dataTransfer.files);
            if (droppedFiles.length > 0) {
              const event = { target: { files: e.dataTransfer.files } } as unknown as React.ChangeEvent<HTMLInputElement>;
              handleFileChange(event);
            }
          }}
        >
          <div className="w-16 h-16 rounded-3xl bg-indigo-50 flex items-center justify-center">
            <Upload className="w-7 h-7 text-indigo-400" />
          </div>
          <div className="text-center space-y-1.5">
            <p className="text-[13px] font-black text-slate-800 uppercase tracking-tight">
              No images selected
            </p>
            <p className="text-[11px] text-slate-400 font-medium max-w-[220px]">
              Drag and drop your photos here to get started
            </p>
          </div>
        </div>
      )}
    </>
  );
}
