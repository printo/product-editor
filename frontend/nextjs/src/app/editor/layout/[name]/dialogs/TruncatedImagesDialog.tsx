'use client';

import { useId } from 'react';

/** Files that look cut off (an interrupted download or transfer): remove them
 *  or keep them anyway. */
export function TruncatedImagesDialog({ badFiles, onDecide }: {
  badFiles: File[];
  onDecide: (decision: 'keep' | 'remove') => void;
}) {
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-in zoom-in-95 duration-200" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
        <p id={titleId} className="text-[12px] font-black text-slate-900 uppercase tracking-tight mb-1">
          {badFiles.length === 1 ? 'Incomplete image detected' : `${badFiles.length} incomplete images detected`}
        </p>
        <p id={messageId} className="text-[10px] text-slate-500 leading-snug mb-3">
          {badFiles.length === 1 ? 'This file looks cut off (often from an interrupted download or transfer) and may print with a missing or grey edge:' : 'These files look cut off (often from an interrupted download or transfer) and may print with a missing or grey edge:'}
        </p>
        <ul className="text-[10px] text-slate-700 font-semibold max-h-24 overflow-y-auto mb-4 space-y-0.5">
          {badFiles.map((f, i) => <li key={i} className="truncate">• {f.name}</li>)}
        </ul>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDecide('remove')}
            className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
          >
            Remove {badFiles.length > 1 ? 'them' : 'it'}
          </button>
          <button
            onClick={() => onDecide('keep')}
            className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
          >
            Keep anyway
          </button>
        </div>
      </div>
    </div>
  );
}
