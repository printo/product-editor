'use client';

import { useRef, type Dispatch, type SetStateAction } from 'react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { clsx } from 'clsx';
import { X, Check } from 'lucide-react';

type Props = {
  qtyUnder: { uploaded: number; needed: number };
  files: File[];
  getFileUrl: (file: File) => string;
  pickerSelected: Set<number>;
  setPickerSelected: Dispatch<SetStateAction<Set<number>>>;
  onClose: () => void;
  onConfirm: () => void;
};

/** Picks which photos repeat to fill an order that is short of its quantity.
 *  Bottom sheet on phones (thumb-reachable, full width, safe-area padded),
 *  centred dialog from `sm` up — same idiom as the editor sidebar. The
 *  thumbnail grid is the only scrolling region, so the title and the
 *  confirm button stay put however many photos are listed. */
export function AutoFillPickerDialog({
  qtyUnder, files, getFileUrl, pickerSelected, setPickerSelected, onClose, onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, null);
  return (
    <div className="fixed inset-0 z-[200003] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose images to repeat"
        className="bg-white w-full sm:max-w-lg sm:mx-4 rounded-t-3xl sm:rounded-2xl shadow-2xl p-5 sm:p-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-6 max-h-[88vh] sm:max-h-[80vh] flex flex-col animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200"
      >
        <div className="sm:hidden w-10 h-1 rounded-full bg-slate-200 mx-auto mb-4 shrink-0" />
        <div className="flex items-start justify-between gap-3 shrink-0">
          <p className="text-[13px] sm:text-sm font-black text-slate-900 uppercase tracking-tight">Choose images to repeat</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 -mt-1 -mr-1 hover:bg-slate-100 rounded-xl transition-all shrink-0"
          >
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <p className="text-[12px] text-slate-500 leading-relaxed mt-1.5 mb-4 shrink-0">
          Tap up to {qtyUnder.needed - qtyUnder.uploaded} image{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''} to duplicate into the remaining
          slot{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''}. Pick fewer and the rest cycle through your photos.
        </p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 mb-5 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {files.map((f, i) => {
            // Use the helper so the URL is tracked for cleanup; the bare
            // URL.createObjectURL fallback used to leak in the qty-picker.
            const url = getFileUrl(f);
            const isSelected = pickerSelected.has(i);
            return (
              <button
                key={i}
                aria-pressed={isSelected}
                onClick={() => setPickerSelected(prev => {
                  const next = new Set(prev);
                  if (isSelected) next.delete(i); else next.add(i);
                  return next;
                })}
                className={clsx('relative aspect-square rounded-xl overflow-hidden border-2 transition-all active:scale-95', isSelected ? 'border-indigo-500 shadow-md shadow-indigo-200' : 'border-slate-200 hover:border-indigo-300')}
              >
                <img src={url} alt={f.name} className="w-full h-full object-cover" />
                {isSelected && (
                  <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                    <div className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center shadow-sm">
                      <Check className="w-3.5 h-3.5" strokeWidth={3} />
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <button
          onClick={onConfirm}
          disabled={pickerSelected.size === 0}
          className="w-full min-h-[48px] py-3.5 text-[11px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0"
        >
          {pickerSelected.size === 0
            ? 'Select at least one image'
            : `Use ${pickerSelected.size} selected to fill ${qtyUnder.needed - qtyUnder.uploaded} slot${qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}
