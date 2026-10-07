'use client';

import { X, Download, Archive, FileText } from 'lucide-react';
import {
  LowDpiWarning, EmptySurfaceWarning, DuplicateFillWarning, QtyShortfallWarning, type PreSubmitNoticeData,
} from '../EditorNotices';

type Props = PreSubmitNoticeData & {
  disclaimerChecked: boolean;
  onDisclaimerChange: (checked: boolean) => void;
  includeUploads: boolean;
  onIncludeUploadsChange: (checked: boolean) => void;
  onClose: () => void;
  onDownloadZip: () => void;
  onImposition: () => void;
};

/** Dashboard: the disclaimer and download options (ZIP or imposition), with
 *  the pre-submit notices. */
export function DownloadOptionsDialog({
  disclaimerChecked, onDisclaimerChange, includeUploads, onIncludeUploadsChange,
  lowDpiFrames, emptySurfaces, duplicateFills, totalUploadedCount, qtyNeeded,
  onClose, onDownloadZip, onImposition,
}: Props) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-[0_32px_80px_-12px_rgba(0,0,0,0.25)] overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-7 pt-7 pb-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center">
                  <Download className="w-4 h-4 text-indigo-600" />
                </div>
                <h3 className="text-base font-bold text-slate-900 tracking-tight">Ready to Download?</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">Please review and confirm before generating your print-ready files.</p>
            </div>
            <button onClick={onClose} className="mt-0.5 p-1.5 hover:bg-slate-100 rounded-xl transition-colors shrink-0">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Divider */}
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
              I have previewed my design, all images are correctly placed in their frames, and I&apos;m ready to generate the final print-ready files.
            </span>
          </label>
        </div>

        {/* Optional — include the customer's original uploaded photos.
            Off by default: keeps the ZIP small and the download fast. */}
        <div className="px-7 pb-5">
          <label className="flex items-start gap-3.5 cursor-pointer group">
            <div className="relative mt-0.5 shrink-0">
              <input
                type="checkbox"
                checked={includeUploads}
                onChange={(e) => onIncludeUploadsChange(e.target.checked)}
                className="peer w-4.5 h-4.5 rounded-md accent-indigo-600 cursor-pointer"
              />
            </div>
            <span className="text-sm text-slate-600 leading-relaxed group-hover:text-slate-800 transition-colors">
              Also include the customer&apos;s original uploaded photos in the ZIP. Off by default — leaving it off makes the download much smaller and faster; turn it on only when you need the source files.
            </span>
          </label>
        </div>

        <LowDpiWarning frames={lowDpiFrames} />
        <EmptySurfaceWarning surfaces={emptySurfaces} />
        <DuplicateFillWarning duplicates={duplicateFills} />
        <QtyShortfallWarning uploaded={totalUploadedCount} needed={qtyNeeded} />

        {/* Download options */}
        <div className="px-7 pb-7 flex gap-3">
          <button
            onClick={onDownloadZip}
            disabled={!disclaimerChecked}
            className="flex-1 group flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed border-slate-100 bg-slate-50/50 enabled:hover:border-indigo-300 enabled:hover:bg-indigo-50 enabled:hover:shadow-md enabled:hover:shadow-indigo-100/60"
          >
            <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 flex items-center justify-center shadow-sm group-enabled:group-hover:border-indigo-200 group-enabled:group-hover:shadow-indigo-100 transition-all">
              <Archive className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="text-center">
              <div className="text-sm font-bold text-slate-800 tracking-tight">ZIP Archive</div>
              <div className="text-xs text-slate-400 mt-0.5">All files packed</div>
            </div>
          </button>
          <button
            onClick={onImposition}
            disabled={!disclaimerChecked}
            className="flex-1 group flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed border-slate-100 bg-slate-50/50 enabled:hover:border-emerald-300 enabled:hover:bg-emerald-50 enabled:hover:shadow-md enabled:hover:shadow-emerald-100/60"
          >
            <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 flex items-center justify-center shadow-sm group-enabled:group-hover:border-emerald-200 group-enabled:group-hover:shadow-emerald-100 transition-all">
              <FileText className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="text-center">
              <div className="text-sm font-bold text-slate-800 tracking-tight">Imposition</div>
              <div className="text-xs text-slate-400 mt-0.5">Print sheet layout</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
