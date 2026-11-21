'use client';

import React from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { LayoutConfig } from '../layout-form-utils';

/** The JSON Specification window: a layout as the server holds it, with a Copy button. */
export function LayoutSpecModal({ layout, copied, onCopy, onClose }: {
  layout: LayoutConfig;
  copied: boolean;
  onCopy: (json: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col border border-slate-800">
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h2 className="text-xl font-bold text-white">JSON Specification</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onCopy(JSON.stringify(layout, null, 2))}
              aria-label="Copy JSON to clipboard"
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 hover:bg-slate-800 transition-colors"
            >
              {copied
                ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied</>
                : <><Copy className="w-3.5 h-3.5" /> Copy</>}
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          <pre className="text-indigo-400 font-mono text-xs leading-relaxed">
            {JSON.stringify(layout, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
