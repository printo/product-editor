'use client';

import type { Dispatch, RefObject, SetStateAction } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowLeftRight, ImagePlus, X } from 'lucide-react';

type Props = {
  swapSource: { idx: number; surfaceKey: string | null } | null;
  setSwapSource: Dispatch<SetStateAction<{ idx: number; surfaceKey: string | null } | null>>;
  persistDegraded: boolean;
  setPersistDegraded: Dispatch<SetStateAction<boolean>>;
  storageBlocked: boolean;
  setStorageBlocked: Dispatch<SetStateAction<boolean>>;
  uploadWarning: string | null;
  setUploadWarning: Dispatch<SetStateAction<string | null>>;
  colorWarning: string | null;
  setColorWarning: Dispatch<SetStateAction<string | null>>;
  unsupportedWarning: string | null;
  setUnsupportedWarning: Dispatch<SetStateAction<string | null>>;
  qtyUnder: { uploaded: number; needed: number } | null;
  setQtyUnder: Dispatch<SetStateAction<{ uploaded: number; needed: number } | null>>;
  headerHeight: number;
  toolbarHeight: number;
  setShowAutoFillPicker: Dispatch<SetStateAction<boolean>>;
  setPickerSelected: Dispatch<SetStateAction<Set<number>>>;
  uploadInputRef: RefObject<HTMLInputElement | null>;
};

/** The floating notices at the top of the editor: tap-to-swap, storage,
 *  upload, colour and unsupported-file warnings, and the under-quantity banner. */
export function EditorBanners({
  swapSource, setSwapSource, persistDegraded, setPersistDegraded, storageBlocked, setStorageBlocked,
  uploadWarning, setUploadWarning, colorWarning, setColorWarning, unsupportedWarning, setUnsupportedWarning,
  qtyUnder, setQtyUnder, headerHeight, toolbarHeight, setShowAutoFillPicker, setPickerSelected, uploadInputRef,
}: Props) {
  return (
    <>
      {swapSource && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200000] bg-indigo-600 text-white px-5 py-2.5 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300" role="status">
          <ArrowLeftRight className="w-4 h-4" />
          <span className="text-xs font-semibold">Tap another photo to swap</span>
          <button onClick={() => setSwapSource(null)} className="p-1 hover:bg-white/20 rounded-lg transition-all" aria-label="Cancel swap">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {(persistDegraded || storageBlocked) && (
        <div className="fixed bottom-6 right-8 z-[200000] max-w-sm bg-white/90 backdrop-blur-2xl border border-amber-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-amber-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group" role="status" aria-live="polite">
          <div className="w-7 h-7 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0 mt-1">
            <AlertTriangle className="w-3.5 h-3.5" />
          </div>
          <span className="flex-1 text-[10px] font-bold text-amber-900/80 tracking-tight leading-snug py-1.5">
            {storageBlocked
              ? "Your browser is blocking local storage — your photos stay safe in this tab, but refreshing will remove them. Finish and submit in one session."
              : "This device's storage is full, so your photos can't be backed up for recovery. Don't refresh or close this tab before submitting."}
          </span>
          <button onClick={() => { setPersistDegraded(false); setStorageBlocked(false); }} className="p-2 hover:bg-amber-50 rounded-xl transition-all" aria-label="Dismiss storage warning">
            <X className="w-3.5 h-3.5 text-amber-400" />
          </button>
        </div>
      )}
      {uploadWarning && (
        <div className="fixed top-24 right-8 z-[200000] max-w-xs bg-white/80 backdrop-blur-2xl border border-amber-200/50 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-amber-900/5 flex items-center gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group">
          <div className="w-7 h-7 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0">
            <span className="text-[14px] font-black">!</span>
          </div>
          <span className="flex-1 text-[10px] font-bold text-amber-900/80 uppercase tracking-tight leading-none">{uploadWarning}</span>
          <button onClick={() => setUploadWarning(null)} className="p-2 hover:bg-amber-50 rounded-xl transition-all group-hover:rotate-90">
            <X className="w-3.5 h-3.5 text-amber-400" />
          </button>
        </div>
      )}
      {colorWarning && (
        <div className={`fixed ${uploadWarning ? 'top-44' : 'top-24'} right-8 z-[200001] max-w-sm bg-white/90 backdrop-blur-2xl border border-orange-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-orange-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group`}>
          <div className="w-7 h-7 mt-0.5 rounded-xl bg-orange-500/10 text-orange-600 flex items-center justify-center shrink-0">
            <span className="text-[13px] font-black">⚠</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black text-orange-900/90 uppercase tracking-tight leading-none mb-1">CMYK → RGB colour shift</p>
            <p className="text-[10px] font-medium text-orange-800/70 leading-snug">{colorWarning}</p>
          </div>
          <button onClick={() => setColorWarning(null)} className="p-2 mt-0.5 hover:bg-orange-50 rounded-xl transition-all shrink-0">
            <X className="w-3.5 h-3.5 text-orange-400" />
          </button>
        </div>
      )}
      {unsupportedWarning && (
        <div className={clsx(
          'fixed right-8 z-[200001] max-w-sm bg-white/90 backdrop-blur-2xl border border-rose-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-rose-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group',
          ['top-24', 'top-44', 'top-64'][(uploadWarning ? 1 : 0) + (colorWarning ? 1 : 0)],
        )}>
          <div className="w-7 h-7 mt-0.5 rounded-xl bg-rose-500/10 text-rose-600 flex items-center justify-center shrink-0">
            <span className="text-[13px] font-black">!</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black text-rose-900/90 uppercase tracking-tight leading-none mb-1">Unsupported file</p>
            <p className="text-[10px] font-medium text-rose-800/70 leading-snug">{unsupportedWarning}</p>
          </div>
          <button onClick={() => setUnsupportedWarning(null)} className="p-2 mt-0.5 hover:bg-rose-50 rounded-xl transition-all shrink-0">
            <X className="w-3.5 h-3.5 text-rose-400" />
          </button>
        </div>
      )}
      {/* ── Under-upload banner ─────────────────────────────────────────────── */}
      {/* Offset by the MEASURED header height rather than a hardcoded `top-24`:
          the mobile header is two rows (72 + 56 px), so the old 96 px offset
          parked this card on top of it. Full-bleed with gutters on phones,
          centred card from `sm` up. */}
      {qtyUnder && (
        <div
          role="status"
          aria-live="polite"
          style={{ top: headerHeight + toolbarHeight + 12 }}
          className="fixed left-3 right-3 sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 z-[200002] bg-white/95 backdrop-blur-2xl border border-indigo-200/60 rounded-2xl shadow-2xl shadow-indigo-900/10 p-4 sm:p-5 animate-in fade-in slide-in-from-top-4 duration-400"
        >
          <div className="flex items-start gap-3 sm:gap-4">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
              <ImagePlus className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] sm:text-sm font-black text-slate-900 uppercase tracking-tight leading-tight">
                {qtyUnder.uploaded} of {qtyUnder.needed} images uploaded
              </p>
              <p className="text-[12px] text-slate-500 mt-1.5 leading-relaxed">
                Upload {qtyUnder.needed - qtyUnder.uploaded} more photo{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''}, or repeat from the images already uploaded.
              </p>
            </div>
            <button
              onClick={() => setQtyUnder(null)}
              aria-label="Dismiss"
              className="p-2 -mt-1 -mr-1 hover:bg-slate-100 rounded-xl transition-all shrink-0"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          {/* The count IS the message, so show it as a bar too. */}
          <div className="mt-4 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all duration-500"
              style={{ width: `${Math.min(100, Math.round((qtyUnder.uploaded / qtyUnder.needed) * 100))}%` }}
            />
          </div>

          {/* Stacked on phones — side by side, these two labels wrap to three
              lines each inside a 375 px viewport. */}
          <div className="mt-4 flex flex-col sm:flex-row items-stretch gap-2">
            <button
              onClick={() => { setShowAutoFillPicker(true); setPickerSelected(new Set()); }}
              className="flex-1 min-h-[44px] px-4 py-3 text-[11px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
            >
              Choose which to repeat
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              className="flex-1 min-h-[44px] px-4 py-3 text-[11px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
            >
              Upload More
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** The page's error message, top right. */
export function ErrorBanner({ error, setError }: {
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  return (
    <>
      {error && (
        <div className="fixed top-4 right-4 z-[200000] max-w-sm bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl shadow-lg flex items-center gap-3">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
    </>
  );
}
