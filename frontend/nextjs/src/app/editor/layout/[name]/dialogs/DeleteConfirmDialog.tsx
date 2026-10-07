'use client';

import { useId } from 'react';

/** Confirms removing a photo from its canvas. */
export function DeleteConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7 animate-in zoom-in-95 duration-200" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <p id={titleId} className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Remove image?</p>
        <p id={messageId} className="text-xs text-slate-500 leading-relaxed mb-6">This image will be removed from the canvas. This cannot be undone.</p>
        <div className="flex items-center gap-3">
          <button
            onClick={onConfirm}
            className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-red-500 text-white rounded-xl hover:bg-red-600 transition-all active:scale-95"
          >
            Remove
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
