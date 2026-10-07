'use client';

import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';

/** More photos picked than the order's quantity: keep the first N or choose
 *  again. A hard cap, so there is no proceed-with-all choice — see "Order
 *  quantity" in CLAUDE.md. */
export function OverQuantityDialog({ orderQty, selectedCount, onDecide }: {
  orderQty: number;
  selectedCount: number;
  onDecide: (keepFirst: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, null);
  return (
    <div className="fixed inset-0 z-[200003] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="More images than ordered"
        className="bg-white w-full sm:max-w-md sm:mx-4 rounded-t-3xl sm:rounded-2xl shadow-2xl p-5 sm:p-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-6 animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200"
      >
        <div className="sm:hidden w-10 h-1 rounded-full bg-slate-200 mx-auto mb-4" />
        <div className="flex items-start gap-3 sm:gap-4">
          <div className="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] sm:text-sm font-black text-slate-900 uppercase tracking-tight leading-tight">More images than ordered</p>
            <p className="text-[12px] text-slate-500 leading-relaxed mt-1.5">
              Your order is for <span className="font-black text-slate-800">{orderQty} {orderQty === 1 ? 'image' : 'images'}</span> but you selected <span className="font-black text-slate-800">{selectedCount}</span>. Only {orderQty} can be printed on this order — keep the first {orderQty}, or choose again to pick exactly the ones you want.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col sm:flex-row items-stretch gap-2">
          <button
            onClick={() => onDecide(true)}
            className="flex-1 min-h-[44px] px-4 py-3 text-[11px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
          >
            Keep first {orderQty}
          </button>
          <button
            onClick={() => onDecide(false)}
            className="flex-1 min-h-[44px] px-4 py-3 text-[11px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
          >
            Choose again
          </button>
        </div>
      </div>
    </div>
  );
}
