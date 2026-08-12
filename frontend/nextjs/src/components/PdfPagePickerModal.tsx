'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileText, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { LazyImg } from '@/components/LazyImg';
import { useModalA11y } from '@/lib/use-modal-a11y';
import {
  openPdfDocument,
  generateThumbnails,
  rasterizeSelectedPages,
  type PdfDocumentHandle,
} from '@/lib/pdf-import';
import { togglePageSelection, toggleSelectAll } from '@/lib/pdf-page-selection';

interface PdfPagePickerModalProps {
  file: File;
  /** null = unrestricted multi-select. 1 = every single-slot entry point
   *  (replace-photo, calendar cells, a surface-card drop) — the picker
   *  constrains itself to exactly one page rather than letting a customer
   *  pick more than the destination can use and silently truncating. */
  maxSelectable: number | null;
  onConfirm: (files: File[]) => void;
  onCancel: () => void;
}

/**
 * Per-PDF page picker: thumbnail grid with a corner checkbox, select-all
 * (multi-select only), confirm/cancel. use-pdf-page-import.ts mounts one of
 * these at a time (keyed by file) for each PDF in a batch — this component
 * assumes `file` is stable for its whole mounted lifetime.
 */
export function PdfPagePickerModal({ file, maxSelectable, onConfirm, onCancel }: PdfPagePickerModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PdfDocumentHandle | null>(null);

  const [pageCount, setPageCount] = useState<number | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<number, string | null>>(new Map());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openError, setOpenError] = useState<string | null>(null);
  const [rasterizeError, setRasterizeError] = useState<string | null>(null);
  const [rasterizing, setRasterizing] = useState<{ current: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let handle: PdfDocumentHandle;
      try {
        handle = await openPdfDocument(file);
      } catch (err) {
        if (!cancelled) {
          setOpenError(err instanceof Error ? err.message : "This PDF couldn't be opened.");
        }
        return;
      }
      if (cancelled) {
        handle.destroy();
        return;
      }
      docRef.current = handle;
      setPageCount(handle.numPages);
      await generateThumbnails(handle, (pageIndex0, dataUrl) => {
        if (cancelled) return;
        setThumbnails(prev => new Map(prev).set(pageIndex0, dataUrl));
      });
    })();
    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
    // `file` never changes across this component's mounted lifetime — the
    // parent queue mounts a fresh instance (new key) per PDF.
  }, [file]);

  const handleCancel = () => {
    if (rasterizing) return; // no defined "abort mid-rasterize" behavior
    onCancel();
  };

  useModalA11y(containerRef, handleCancel, true);

  const handleConfirm = async () => {
    if (!docRef.current || selected.size === 0 || rasterizing) return;
    setRasterizeError(null);
    const pageNumbers = Array.from(selected).sort((a, b) => a - b).map(i => i + 1); // 0-indexed -> pdf.js's 1-indexed
    setRasterizing({ current: 0, total: pageNumbers.length });
    try {
      const files = await rasterizeSelectedPages(docRef.current, pageNumbers, file.name, (current, total) => {
        setRasterizing({ current, total });
      });
      onConfirm(files);
    } catch (err) {
      setRasterizing(null);
      setRasterizeError(
        err instanceof Error ? err.message : 'Something went wrong converting your selected pages.',
      );
    }
  };

  const toggleOne = (index: number) => {
    if (rasterizing) return;
    setSelected(prev => togglePageSelection(prev, index, maxSelectable));
  };

  return (
    <div className="fixed inset-0 z-[310000] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" onClick={handleCancel} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose pages from ${file.name}`}
        tabIndex={-1}
        className="relative w-full max-w-xl max-h-[85vh] flex flex-col bg-white rounded-3xl shadow-[0_32px_80px_-12px_rgba(0,0,0,0.25)] overflow-hidden"
      >
        {/* Header */}
        <div className="px-7 pt-7 pb-5 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 mb-1.5">
              <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4 text-indigo-600" />
              </div>
              <h3 className="text-base font-bold text-slate-900 tracking-tight truncate">
                Choose pages from &ldquo;{file.name}&rdquo;
              </h3>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">
              {maxSelectable === 1
                ? 'This side only holds one photo — choose the page you’d like to use.'
                : 'Select the pages you want to import — they’ll be added like any other photo.'}
            </p>
          </div>
          <button
            onClick={handleCancel}
            disabled={!!rasterizing}
            className="mt-0.5 p-1.5 hover:bg-slate-100 rounded-xl transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <div className="mx-7 border-t border-slate-100 shrink-0" />

        {/* Body */}
        <div className="px-7 py-5 overflow-y-auto custom-scrollbar flex-1">
          {openError ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <AlertTriangle className="w-8 h-8 text-rose-400" />
              <p className="text-sm text-slate-600">{openError}</p>
            </div>
          ) : pageCount === null ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Opening PDF…</p>
            </div>
          ) : (
            <>
              {maxSelectable !== 1 && (
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    {pageCount} page{pageCount !== 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={() => setSelected(prev => toggleSelectAll(prev, pageCount))}
                    disabled={!!rasterizing}
                    className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest hover:text-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {selected.size === pageCount ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
              )}

              {rasterizeError && (
                <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="text-xs">{rasterizeError}</span>
                </div>
              )}

              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {Array.from({ length: pageCount }, (_, i) => {
                  const thumb = thumbnails.get(i);
                  const isSelected = selected.has(i);
                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`Page ${i + 1}${isSelected ? ', selected' : ''}`}
                      onClick={() => toggleOne(i)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleOne(i);
                        }
                      }}
                      className={clsx(
                        'relative aspect-square rounded-xl overflow-hidden border-2 bg-slate-50 transition-all',
                        rasterizing ? 'cursor-not-allowed opacity-60' : 'cursor-pointer active:scale-95',
                        isSelected ? 'border-indigo-500 shadow-md shadow-indigo-200' : 'border-slate-200 hover:border-indigo-300',
                      )}
                    >
                      {thumb === undefined && <div className="absolute inset-0 bg-slate-100 animate-pulse" />}
                      {thumb === null && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400">
                          <AlertTriangle className="w-4 h-4" />
                          <span className="text-[8px] font-bold uppercase tracking-wide">No preview</span>
                        </div>
                      )}
                      {typeof thumb === 'string' && (
                        <LazyImg src={thumb} alt={`Page ${i + 1}`} className="w-full h-full object-contain" />
                      )}

                      <div className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-white/70 backdrop-blur-sm text-[8px] font-bold text-slate-600">
                        {i + 1}
                      </div>
                      <div className="absolute top-2 right-2 z-20 p-1 bg-white/40 backdrop-blur-md rounded-xl border border-white/40 shadow-sm">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!!rasterizing}
                          aria-label={`Select page ${i + 1}`}
                          onChange={() => toggleOne(i)}
                          onClick={e => e.stopPropagation()}
                          className="w-4 h-4 rounded-md accent-indigo-600 cursor-pointer"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-7 pb-7 pt-2 flex gap-3 shrink-0">
          <button
            onClick={handleCancel}
            disabled={!!rasterizing}
            className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-100 rounded-xl hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {openError ? 'Close' : 'Cancel'}
          </button>
          {!openError && pageCount !== null && (
            <button
              onClick={handleConfirm}
              disabled={selected.size === 0 || !!rasterizing}
              className="flex-[2] py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {rasterizing
                ? `Converting ${rasterizing.current}/${rasterizing.total}…`
                : `Use ${selected.size} page${selected.size !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
