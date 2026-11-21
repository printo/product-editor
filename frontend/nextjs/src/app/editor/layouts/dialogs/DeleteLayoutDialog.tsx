'use client';

import React from 'react';
import { Trash2 } from 'lucide-react';

/** Asks before a layout is deleted. */
export function DeleteLayoutDialog({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-xl shadow-xl ring-1 ring-slate-900/5 w-full max-w-sm p-6">
        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 bg-rose-50 text-rose-500 rounded-full flex items-center justify-center mb-4">
            <Trash2 className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 mb-1">Delete Layout?</h3>
          <p className="text-sm text-slate-500 mb-6 leading-relaxed">
            Delete <span className="font-bold text-slate-900">&quot;{name}&quot;</span>? This action is permanent and affects all users.
          </p>

          <div className="flex w-full gap-2">
            <button
              onClick={onCancel}
              className="flex-1 px-4 py-2 text-sm bg-slate-100 text-slate-600 font-bold rounded-lg hover:bg-slate-200 transition-all active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 px-4 py-2 text-sm bg-rose-600 text-white font-bold rounded-lg hover:bg-rose-700 shadow-lg shadow-rose-200 transition-all active:scale-95"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
