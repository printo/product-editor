'use client';

import { useCallback, useRef, useState } from 'react';
import { isPdfFile } from '@/lib/pdf-import';
import { spliceExpandedPdfPages } from '@/lib/pdf-page-selection';
import { PdfPagePickerModal } from './PdfPagePickerModal';

interface QueueItem {
  file: File;
  /** Position in the original array this PDF must be spliced back into. */
  index: number;
  maxSelectable: number | null;
}

/**
 * Orchestrates PDF page-picking for a batch of picked/dropped files.
 * `expandPdfPages` is a drop-in pre-step for any existing file-pick handler:
 * non-PDF files pass through untouched, and any PDFs are resolved one at a
 * time (a PdfPagePickerModal per PDF, in pick order) before the returned
 * promise settles — so callers never have to know whether a picker was
 * shown at all. Cancelling a PDF's picker contributes zero files for it but
 * doesn't abort the rest of the batch.
 */
export function usePdfPageImport() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const originalFilesRef = useRef<File[]>([]);
  const resultsRef = useRef<Map<number, File[]>>(new Map());
  const resolveRef = useRef<((files: File[]) => void) | null>(null);

  const expandPdfPages = useCallback(
    (files: File[], opts: { maxSelectable: number | null }): Promise<File[]> => {
      const pdfIndices = files.reduce<number[]>((acc, f, i) => {
        if (isPdfFile(f)) acc.push(i);
        return acc;
      }, []);
      if (pdfIndices.length === 0) return Promise.resolve(files);

      return new Promise<File[]>(resolve => {
        originalFilesRef.current = files;
        resultsRef.current = new Map();
        resolveRef.current = resolve;
        setQueue(pdfIndices.map(index => ({ file: files[index], index, maxSelectable: opts.maxSelectable })));
      });
    },
    [],
  );

  // Records the current queue head's result, advances the queue, and
  // resolves the outer promise once nothing is left — done as plain
  // function-body logic (not inside the setQueue updater) so the resolve
  // side-effect can't double-fire under an updater re-invocation.
  const resolveCurrentAndAdvance = (filesForCurrent: File[]) => {
    const current = queue[0];
    if (!current) return;
    resultsRef.current.set(current.index, filesForCurrent);
    const remaining = queue.slice(1);
    setQueue(remaining);
    if (remaining.length === 0) {
      const result = spliceExpandedPdfPages(originalFilesRef.current, resultsRef.current);
      resolveRef.current?.(result);
      resolveRef.current = null;
    }
  };

  const current = queue[0];
  const pdfPickerElement = current ? (
    <PdfPagePickerModal
      key={`${current.index}:${current.file.name}:${current.file.size}:${current.file.lastModified}`}
      file={current.file}
      maxSelectable={current.maxSelectable}
      onConfirm={files => resolveCurrentAndAdvance(files)}
      onCancel={() => resolveCurrentAndAdvance([])}
    />
  ) : null;

  return { expandPdfPages, pdfPickerElement };
}
