'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { formatWait } from './editor-utils';

/** Embed post-submit status panel (Phase 3 — no more dead-end): polls
 *  render-status through the embed proxy and surfaces queued / rendering /
 *  done / failed honestly, with a way back into the editor. */
export function EmbedSubmittedOverlay({
  jobId, apiBase, getAuthHeaders, onBackToEditor,
}: {
  jobId: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  onBackToEditor: () => void;
}) {
  const [state, setState] = useState<{
    status: 'queued' | 'processing' | 'completed' | 'failed';
    waitSeconds: number | null;
    error: string | null;
  }>({ status: 'queued', waitSeconds: null, error: null });

  useEffect(() => {
    let cancelled = false;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${apiBase}/render-status/${jobId}/`, { headers: getAuthHeaders() });
        if (res.ok) {
          const s = await res.json();
          if (cancelled) return;
          setState({
            status: s.status === 'processing' ? 'processing'
              : s.status === 'completed' ? 'completed'
              : s.status === 'failed' ? 'failed' : 'queued',
            waitSeconds: typeof s.estimated_wait_seconds === 'number' ? s.estimated_wait_seconds : null,
            error: s.error || null,
          });
          if (s.status === 'completed' || s.status === 'failed') return; // stop polling
        }
      } catch {
        // Transient poll failure — keep the last known state and retry.
      }
      delay = Math.min(delay * 1.5, 10000);
      timer = setTimeout(poll, Math.round(delay * (0.8 + Math.random() * 0.4)));
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, apiBase, getAuthHeaders]);

  return (
    <div className="fixed inset-0 z-[300000] flex items-center justify-center bg-white/85 backdrop-blur-sm" role="status" aria-live="polite">
      <div className="text-center p-10 max-w-md">
        {state.status === 'failed' ? (
          <>
            <X className="w-14 h-14 text-rose-500 mx-auto mb-4 p-2.5 rounded-full bg-rose-50" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Something went wrong preparing your design</h2>
            <p className="text-sm text-slate-500 mb-6">
              {state.error || 'The print files could not be generated.'} Your design is safe — you can go back, check it, and submit again.
            </p>
            <button
              onClick={onBackToEditor}
              className="px-6 py-3 text-sm font-semibold rounded-2xl bg-indigo-600 text-white hover:bg-indigo-700 transition-all"
            >
              Back to editor
            </button>
          </>
        ) : state.status === 'completed' ? (
          <>
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Your design is ready</h2>
            <p className="text-sm text-slate-500 mb-6">The print files are prepared. You can close this window and continue with your order.</p>
            <button
              onClick={onBackToEditor}
              className="px-5 py-2.5 text-xs font-semibold rounded-2xl border-2 border-slate-200 text-slate-600 hover:bg-slate-50 transition-all"
            >
              Edit design again
            </button>
          </>
        ) : (
          <>
            <Loader2 className="w-14 h-14 text-indigo-500 mx-auto mb-4 animate-spin" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">
              {state.status === 'queued'
                ? (state.waitSeconds != null ? `Queued — about ${formatWait(state.waitSeconds)} wait` : 'Design submitted — queued…')
                : 'Preparing your print files…'}
            </h2>
            <p className="text-sm text-slate-500 mb-6">You can keep this window open, or close it — your design is submitted either way.</p>
            <button
              onClick={onBackToEditor}
              className="px-5 py-2.5 text-xs font-semibold rounded-2xl border-2 border-slate-200 text-slate-600 hover:bg-slate-50 transition-all"
            >
              Edit design
            </button>
          </>
        )}
      </div>
    </div>
  );
}
