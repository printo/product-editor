'use client';

import { Loader2 } from 'lucide-react';

type Props = {
  isProcessing: boolean;
  isDownloading: boolean;
  isImposing: boolean;
  renderProgress: { current: number; total: number } | null;
  serverRenderLabel: string | null;
  heicConverting: boolean;
  embedToken: string | null;
};

/** The full-screen progress card (preview generation, the submit/download
 *  render, imposition) and the HEIC conversion card. */
export function ProcessingOverlay({
  isProcessing, isDownloading, isImposing, renderProgress, serverRenderLabel, heicConverting, embedToken,
}: Props) {
  return (
    <>
      {/* ── Fixed Processing Overlay ────────────────────────────────────── */}
      {/* isImposing included: executeImposition sets renderProgress on every
          placed item, but this overlay never rendered during an imposition,
          so the download showed a bare spinner. With no feedback, a slow
          render and a hung one look identical — which is exactly how a
          never-settling pica resize went unnoticed. */}
      {(isProcessing || isDownloading || isImposing) && renderProgress && (
        <div className="fixed inset-0 z-[300001] flex items-center justify-center bg-white/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-sm bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 space-y-5 animate-in zoom-in-95 duration-300">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-black text-slate-900 uppercase tracking-tight">
                  {/* Only the SUBMIT pass (isDownloading) is reworded for
                      embed — this same overlay also covers canvas preview
                      generation after a photo pick, which is not a save. */}
                  {isDownloading
                    ? (embedToken ? 'Saving Your Design' : 'Preparing Download')
                    : 'Processing Your Design'}
                </span>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  {isDownloading
                    ? (embedToken ? 'This may take a moment' : 'Bundling high-res print files')
                    : 'Optimizing images for print'}
                </span>
              </div>
              <span className="text-[14px] font-black text-indigo-600 tabular-nums bg-indigo-50 px-3 py-1 rounded-xl">
                {Math.round((renderProgress.current / renderProgress.total) * 100)}%
              </span>
            </div>

            <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden p-0.5">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300 ease-out shadow-[0_0_12px_rgba(99,102,241,0.4)]"
                style={{ width: `${Math.round((renderProgress.current / renderProgress.total) * 100)}%` }}
              />
            </div>

            <div className="flex items-center justify-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">
                {serverRenderLabel
                  ? serverRenderLabel
                  : isDownloading
                    ? (renderProgress.total === 100 ? `Zipping... ${renderProgress.current}%` : `Rendering File ${renderProgress.current} of ${renderProgress.total}`)
                    : `Rendering File ${renderProgress.current} of ${renderProgress.total}`
                }
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── HEIC → JPEG conversion (iPhone photos) ──────────────────────── */}
      {/* No percentage: heic2any's WASM decoder doesn't report progress,
          and this step is usually well under a couple of seconds. */}
      {heicConverting && (
        <div className="fixed inset-0 z-[300001] flex items-center justify-center bg-white/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-sm bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 space-y-3 animate-in zoom-in-95 duration-300 flex flex-col items-center">
            <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
            <span className="text-[12px] font-black text-slate-900 uppercase tracking-tight">
              Converting iPhone Photo
            </span>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Preparing HEIC image for editing
            </span>
          </div>
        </div>
      )}
    </>
  );
}
