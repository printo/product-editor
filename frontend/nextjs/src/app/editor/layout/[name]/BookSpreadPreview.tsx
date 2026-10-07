'use client';

import type { Dispatch, SetStateAction } from 'react';
import { clsx } from 'clsx';
import { Layout, X } from 'lucide-react';

/** One page as the spread preview draws it. */
export type BookPreviewPage = {
  key: string;
  label: string;
  dataUrl: string | null;
  canvasWidth: number;
  canvasHeight: number;
  canvasWidthMm: number;
};

/** Book: the page-count stepper and the Preview spreads button (BOOK_LAYOUT_PRD.md D2/R1). */
export function BookPageCount({ isBookProduct, bookPageBounds, bookPageCount, handleBookPageCountChange, setShowSpreadPreview }: {
  isBookProduct: boolean;
  bookPageBounds: [number, number, number, number] | null;
  bookPageCount: number;
  handleBookPageCountChange: (requested: number) => void;
  setShowSpreadPreview: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
      {/* ── Book: page-count control (BOOK_LAYOUT_PRD.md D2/R1) ─────────── */}
      {/* Visible regardless of upload state — pages exist as blank cards
          via the generic multi-surface grid below the moment the count
          is set, same as any other multi-surface product. */}
      {isBookProduct && bookPageBounds && (
        <div className="flex items-center justify-between gap-4 bg-white rounded-2xl border-2 border-slate-100 px-4 py-3 mx-4">
          <div>
            <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">Pages</p>
            <p className="text-[10px] text-slate-400 font-medium">
              {bookPageBounds[0]}–{bookPageBounds[1]} pages, in steps of {bookPageBounds[2]}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleBookPageCountChange(bookPageCount - bookPageBounds[2])}
              disabled={bookPageCount <= bookPageBounds[0]}
              aria-label="Fewer pages"
              className="w-8 h-8 rounded-full border-2 border-slate-200 text-slate-500 font-black text-lg flex items-center justify-center disabled:opacity-30 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
            >
              −
            </button>
            <span className="text-sm font-black text-slate-900 tabular-nums min-w-[6rem] text-center">
              {bookPageCount} pages
            </span>
            <button
              type="button"
              onClick={() => handleBookPageCountChange(bookPageCount + bookPageBounds[2])}
              disabled={bookPageCount >= bookPageBounds[1]}
              aria-label="More pages"
              className="w-8 h-8 rounded-full border-2 border-slate-200 text-slate-500 font-black text-lg flex items-center justify-center disabled:opacity-30 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setShowSpreadPreview(true)}
              className="ml-2 text-[10px] font-black uppercase tracking-widest text-indigo-600 bg-indigo-50 px-3 py-2 rounded-full border-2 border-indigo-100/50 hover:bg-indigo-100 transition-colors"
            >
              Preview spreads
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Book: the read-only spread preview (D6) — the cover wrap, then the inner spreads. */
export function BookSpreadPreview({
  showSpreadPreview, setShowSpreadPreview, bookSpreads, bookCoverPreview, bookBackCoverPreview, bookSpineWidthMm,
}: {
  showSpreadPreview: boolean;
  setShowSpreadPreview: Dispatch<SetStateAction<boolean>>;
  bookSpreads: BookPreviewPage[][];
  bookCoverPreview: BookPreviewPage | null;
  bookBackCoverPreview: BookPreviewPage | null;
  bookSpineWidthMm: number | null;
}) {
  return (
    <>
      {/* ── Book: read-only spread preview (D6) ─────────────────────────── */}
      {showSpreadPreview && (
        <div className="fixed inset-0 z-[200004] bg-black/60 backdrop-blur-sm flex flex-col animate-in fade-in duration-200">
          <div className="flex items-center justify-between px-6 py-4 bg-white/95 border-b border-slate-200 shrink-0">
            <div>
              <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">Spread preview</h2>
              <p className="text-[10px] text-slate-400 font-medium">Read-only — edit individual pages in the grid</p>
            </div>
            <button
              onClick={() => setShowSpreadPreview(false)}
              aria-label="Close spread preview"
              className="p-2 hover:bg-slate-100 rounded-xl transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center gap-8">
            {bookSpreads.length === 0 && !bookCoverPreview && !bookBackCoverPreview && (
              <p className="text-sm text-slate-400 mt-10">No pages to preview yet.</p>
            )}

            {/* ── Cover wrap: back · spine · front, joined edge-to-edge as one
                physical printed sheet (R2/D4) — placeholders make the spine's
                real proportion to the covers visible before it's printed. ─ */}
            {(bookCoverPreview || bookBackCoverPreview) && (() => {
              const frontMm = bookCoverPreview?.canvasWidthMm || 1;
              const backMm = bookBackCoverPreview?.canvasWidthMm || frontMm;
              const spineMm = Math.max(bookSpineWidthMm || 0, 0);
              const wrapHeight = bookCoverPreview?.canvasHeight || bookBackCoverPreview?.canvasHeight || 1800;
              const wrapWidth = bookCoverPreview?.canvasWidth || bookBackCoverPreview?.canvasWidth || 1200;
              return (
                <div className="flex flex-col items-center gap-2">
                  <div
                    className="flex items-stretch shadow-xl rounded-lg overflow-hidden bg-white"
                    style={{ aspectRatio: `${wrapWidth * ((backMm + spineMm + frontMm) / frontMm)} / ${wrapHeight}`, height: '38vh' }}
                  >
                    <div className="relative bg-slate-100 flex items-center justify-center" style={{ flex: `${backMm} 0 0px` }}>
                      {bookBackCoverPreview?.dataUrl ? (
                        <img src={bookBackCoverPreview.dataUrl} alt="Back cover" className="w-full h-full object-fill" />
                      ) : (
                        <Layout className="w-8 h-8 text-slate-300 opacity-40" />
                      )}
                    </div>
                    <div
                      className="relative bg-gradient-to-b from-amber-100 to-amber-200 border-x-2 border-amber-300 flex items-center justify-center shrink-0"
                      style={{ flex: `${spineMm || 0.001} 0 0px`, minWidth: spineMm > 0 ? '6px' : '0px' }}
                      title={bookSpineWidthMm != null ? `Spine: ${bookSpineWidthMm.toFixed(1)}mm` : undefined}
                    >
                      {spineMm > 3 && (
                        <span
                          className="text-[7px] font-black text-amber-700 uppercase tracking-widest whitespace-nowrap"
                          style={{ writingMode: 'vertical-rl' }}
                        >
                          Spine
                        </span>
                      )}
                    </div>
                    <div className="relative bg-slate-100 flex items-center justify-center" style={{ flex: `${frontMm} 0 0px` }}>
                      {bookCoverPreview?.dataUrl ? (
                        <img src={bookCoverPreview.dataUrl} alt="Front cover" className="w-full h-full object-fill" />
                      ) : (
                        <Layout className="w-8 h-8 text-slate-300 opacity-40" />
                      )}
                    </div>
                  </div>
                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">
                    Cover wrap — back · spine
                    {bookSpineWidthMm != null ? ` (~${bookSpineWidthMm.toFixed(1)}mm)` : ''} · front
                  </p>
                </div>
              );
            })()}

            {bookSpreads.map((spread, i) => (
              <div key={i} className="flex flex-col items-center gap-2">
                <div className="flex items-stretch shadow-xl rounded-lg overflow-hidden bg-white">
                  {spread.map((page, pi) => (
                    <div
                      key={page.key}
                      className={clsx(
                        'relative bg-slate-100 flex items-center justify-center',
                        spread.length === 2 && pi === 0 && 'border-r-2 border-slate-300',
                      )}
                      style={{ aspectRatio: `${page.canvasWidth} / ${page.canvasHeight}`, height: '38vh' }}
                    >
                      {page.dataUrl ? (
                        <img src={page.dataUrl} alt={page.label} className="w-full h-full object-fill" />
                      ) : (
                        <Layout className="w-8 h-8 text-slate-300 opacity-40" />
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">
                  {spread.map(p => p.label).join(' · ')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
