'use client';

import { useId, useRef } from 'react';
import { useModalA11y } from '@/lib/use-modal-a11y';

/** Book D3: more photos than pages — warn and offer to extend the book. */
export function BookOverflowDialog({ overflow, pageCount, onDecide }: {
  overflow: { files: File[]; currentCapacity: number; suggestedCount: number };
  pageCount: number;
  onDecide: (decision: 'extend' | 'keep') => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, null);
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="fixed inset-0 overflow-hidden overscroll-contain z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div ref={dialogRef} className="bg-white rounded-xl shadow-xl ring-1 ring-slate-900/5 w-full max-w-sm mx-4 p-5" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <p id={titleId} className="text-[12px] font-black text-slate-900 uppercase tracking-tight mb-1">
          {overflow.files.length} photos won&apos;t fit on {pageCount} pages
        </p>
        <p id={messageId} className="text-[10px] text-slate-500 leading-snug mb-4">
          Only {overflow.currentCapacity} of {overflow.files.length} photos will be
          used unless you add more pages. Extend to {overflow.suggestedCount} pages to fit them all?
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDecide('extend')}
            className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all motion-safe:active:scale-95"
          >
            Extend to {overflow.suggestedCount} pages
          </button>
          <button
            onClick={() => onDecide('keep')}
            className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all motion-safe:active:scale-95"
          >
            Keep {pageCount} pages
          </button>
        </div>
      </div>
    </div>
  );
}
