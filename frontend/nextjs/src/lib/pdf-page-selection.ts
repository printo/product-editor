/**
 * Pure page-selection-state helpers for the PDF page picker. No React/DOM
 * dependency — the modal's state is just a Set<number> of selected page
 * indices, mutated only through these functions so the toggle/select-all/
 * splice logic is unit-testable without rendering anything.
 *
 * Indexing convention: selection Sets here are 0-indexed (page position in
 * the document, matching generateThumbnails' `pageIndex0` callback param in
 * pdf-import.ts). pdf.js's own page-number APIs are 1-indexed — callers
 * convert (`pageIndex0 + 1`) only at the boundary where they call into
 * pdf-import.ts's rasterizeSelectedPages.
 */

/**
 * Toggle one page's selection. Unrestricted (maxSelectable: null) adds/
 * removes normally. maxSelectable === 1 (every single-slot entry point —
 * replace-photo, calendar cells, a surface-card drop) REPLACES the
 * selection instead of adding to it, so a customer can never end up with
 * more picks than the destination can use — re-clicking the already-
 * selected page clears it, so "nothing selected" stays reachable. Any
 * other numeric cap simply stops accepting new selections once full,
 * rather than guessing which existing pick to evict.
 */
export function togglePageSelection(
  selected: Set<number>,
  index: number,
  maxSelectable: number | null,
): Set<number> {
  if (maxSelectable === 1) {
    return selected.has(index) ? new Set() : new Set([index]);
  }
  const next = new Set(selected);
  if (next.has(index)) {
    next.delete(index);
  } else if (maxSelectable === null || next.size < maxSelectable) {
    next.add(index);
  }
  return next;
}

/** Select-all/none toggle for the multi-select grid. Selecting all when
 *  already all-selected clears the selection (one button, two states). */
export function toggleSelectAll(selected: Set<number>, totalPages: number): Set<number> {
  if (selected.size === totalPages) return new Set();
  return new Set(Array.from({ length: totalPages }, (_, i) => i));
}

/**
 * Splices each PDF's chosen (already-rasterized) pages back into the
 * original file array at that PDF's own position. Non-PDF files pass
 * through untouched. A cancelled PDF maps to an empty array — its position
 * contributes zero files, not a gap holding the original PDF File.
 */
export function spliceExpandedPdfPages(
  originalFiles: File[],
  resultsByIndex: Map<number, File[]>,
): File[] {
  const out: File[] = [];
  for (let i = 0; i < originalFiles.length; i++) {
    const expanded = resultsByIndex.get(i);
    if (expanded) {
      out.push(...expanded);
    } else {
      out.push(originalFiles[i]);
    }
  }
  return out;
}
