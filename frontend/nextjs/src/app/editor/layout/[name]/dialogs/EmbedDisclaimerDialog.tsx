'use client';

import { useId } from 'react';
import { X, SendHorizonal } from 'lucide-react';
import {
  LowDpiWarning, EmptySurfaceWarning, DuplicateFillWarning, QtyShortfallWarning, type PreSubmitNoticeData,
} from '../EditorNotices';

type Props = PreSubmitNoticeData & {
  disclaimerChecked: boolean;
  onDisclaimerChange: (checked: boolean) => void;
  onClose: () => void;
  onProceed: () => void;
};

/** Embed: the disclaimer before Save & Continue, with the pre-submit notices. */
export function EmbedDisclaimerDialog({
  disclaimerChecked, onDisclaimerChange,
  lowDpiFrames, emptySurfaces, duplicateFills, totalUploadedCount, qtyNeeded,
  onClose, onProceed,
}: Props) {
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-[0_32px_80px_-12px_rgba(0,0,0,0.25)] overflow-hidden animate-in zoom-in-95 duration-200" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        {/* Header */}
        <div className="px-7 pt-7 pb-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center">
                  <SendHorizonal className="w-4 h-4 text-indigo-600" />
                </div>
                <h3 id={titleId} className="text-base font-bold text-slate-900 tracking-tight">Ready to Submit?</h3>
              </div>
              <p id={messageId} className="text-sm text-slate-500 leading-relaxed">Please confirm before sending your design for production.</p>
            </div>
            <button onClick={onClose} aria-label="Close" className="mt-0.5 p-1.5 hover:bg-slate-100 rounded-xl transition-colors shrink-0">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>
        <div className="mx-7 border-t border-slate-100" />
        {/* Confirmation checkbox */}
        <div className="px-7 py-5">
          <label className="flex items-start gap-3.5 cursor-pointer group">
            <div className="relative mt-0.5 shrink-0">
              <input
                type="checkbox"
                checked={disclaimerChecked}
                onChange={(e) => onDisclaimerChange(e.target.checked)}
                className="peer w-4.5 h-4.5 rounded-md accent-indigo-600 cursor-pointer"
              />
            </div>
            <span className="text-sm text-slate-600 leading-relaxed group-hover:text-slate-800 transition-colors">
              I have previewed my design, all images are correctly placed in their frames, and I&apos;m ready to send for production.
            </span>
          </label>
        </div>
        <LowDpiWarning frames={lowDpiFrames} />
        <EmptySurfaceWarning surfaces={emptySurfaces} />
        <DuplicateFillWarning duplicates={duplicateFills} />
        <QtyShortfallWarning uploaded={totalUploadedCount} needed={qtyNeeded} />
        {/* Actions */}
        <div className="px-7 pb-7 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 text-sm font-semibold px-5 py-3 rounded-2xl border-2 border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all"
          >
            Go Back
          </button>
          <button
            onClick={onProceed}
            disabled={!disclaimerChecked}
            className="flex-1 text-sm font-semibold px-5 py-3 rounded-2xl bg-indigo-600 text-white hover:bg-indigo-700 transition-all disabled:opacity-35 disabled:cursor-not-allowed shadow-md shadow-indigo-200 enabled:hover:shadow-indigo-300"
          >
            Yes, Proceed
          </button>
        </div>
      </div>
    </div>
  );
}
