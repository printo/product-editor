'use client';

import { Info, Loader2, X } from 'lucide-react';
import { RESTORE_NOTICE_TEXT, type RestoreNotice as Notice } from './useParentRestore';

/** Above the cards, for a design brought back from an earlier order: how far
 *  the photos have got while there is nothing to show yet, then what the
 *  customer should know about what came back. In the page, not floating, so
 *  it never covers a card or the toolbar on a phone. */
export function RestoreNotice({ notice, progress, onDismiss }: {
  notice: Notice | null;
  progress: { done: number; total: number } | null;
  onDismiss: () => void;
}) {
  if (progress) {
    return (
      <div role="status" className="mb-4 flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-900">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span>Bringing back your photos… {progress.done} of {progress.total}</span>
      </div>
    );
  }
  if (!notice) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-900">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="flex-1 leading-snug">{RESTORE_NOTICE_TEXT[notice]}</p>
      <button onClick={onDismiss} aria-label="Dismiss" className="rounded-lg p-1 text-indigo-500 transition-colors hover:bg-indigo-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
