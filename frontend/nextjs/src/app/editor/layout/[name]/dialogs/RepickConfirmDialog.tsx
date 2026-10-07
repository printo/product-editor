'use client';

import { useRef } from 'react';
import { useModalA11y } from '@/lib/use-modal-a11y';

/** Asks before a re-pick discards the edits on pages whose photos are not
 *  in the new selection (Phase 3). */
export function RepickConfirmDialog({ losingCount, onDecide }: {
  losingCount: number;
  onDecide: (proceed: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepEditsRef = useRef<HTMLButtonElement>(null);
  useModalA11y(dialogRef, null, true, keepEditsRef);
  return (
    <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div ref={dialogRef} className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7 animate-in zoom-in-95 duration-200" role="alertdialog" aria-modal="true" aria-label="Replacing photos will discard edits">
        <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Replace photos?</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-6">
          {losingCount === 1
            ? 'One page you edited uses photos that are not in the new selection — its adjustments will be discarded.'
            : `${losingCount} pages you edited use photos that are not in the new selection — their adjustments will be discarded.`}
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onDecide(true)}
            className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
          >
            Replace anyway
          </button>
          <button
            ref={keepEditsRef}
            onClick={() => onDecide(false)}
            className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
          >
            Keep my edits
          </button>
        </div>
      </div>
    </div>
  );
}
