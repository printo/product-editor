'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { pageCountBounds, pagesToSpreads, spineWidthMm, type BookLayoutLike } from '@/lib/book-layout';
import type { NormalizedLayout } from '@/lib/layout-utils';
import { reconcilePageCount, roleForSurfaceKey } from './book-pages';
import type { SurfaceState } from './types';

/** Book products: the customer's page count, the pages held back when the
 *  count shrinks, the "more photos than pages" prompt, and the spread
 *  preview. The prompt's decision handler is still in the page, beside the
 *  file intake it re-enters (split plan C6). */
export function useBookPages({ layout, normalizedLayoutState, surfaceStates, surfaceStatesRef, setSurfaceStates }: {
  layout: { productType?: string | null } | null;
  normalizedLayoutState: NormalizedLayout | null;
  surfaceStates: SurfaceState[];
  surfaceStatesRef: MutableRefObject<SurfaceState[]>;
  setSurfaceStates: Dispatch<SetStateAction<SurfaceState[]>>;
}) {
  // Book D3 overflow: more uploaded photos than the current page count can
  // hold. Held pending the customer's Extend / Keep-as-is decision, mirroring
  // pendingTruncated's pause-and-re-enter pattern — see processSelectedFiles.
  const [pendingBookOverflow, setPendingBookOverflow] = useState<{
    files: File[]; currentCapacity: number; suggestedCount: number;
  } | null>(null);
  // Set right before a decided batch re-enters processSelectedFiles so the
  // overflow check doesn't re-prompt for the same files a second time.
  const bookOverflowDecidedRef = useRef(false);

  // ── Book product state (BOOK_LAYOUT_PRD.md R1) ────────────────────────────
  // These only matter when layout.productType === 'book'. Page count is
  // CUSTOMER state (D2) — surfaceStates always holds exactly the currently
  // VISIBLE pages (cover, page_01..page_N, back_cover); pages shrunk out of
  // range are held in bookHiddenPages rather than discarded, and restored if
  // the count goes back up. See book-pages.ts::reconcilePageCount, the one
  // place this reconciliation happens (layout load / count change / restore).
  const isBookProduct = layout?.productType === 'book';
  const [bookPageCount, setBookPageCount] = useState<number>(0);
  const [bookHiddenPages, setBookHiddenPages] = useState<Record<string, SurfaceState>>({});
  const bookHiddenPagesRef = useRef(bookHiddenPages);
  useEffect(() => { bookHiddenPagesRef.current = bookHiddenPages; }, [bookHiddenPages]);

  // The template's {min,max,step,default} page-count grid, for the page-count
  // control below. `null` until the (book) layout has loaded.
  const bookPageBounds = useMemo(() => {
    if (!isBookProduct) return null;
    const raw = normalizedLayoutState?._raw as BookLayoutLike | undefined;
    return raw ? pageCountBounds(raw) : null;
  }, [isBookProduct, normalizedLayoutState]);

  // The one place a customer-driven page-count change happens (the control
  // below, and D3's overflow "extend to N pages?" offer) — always goes
  // through reconcilePageCount so growing/shrinking/restoring stay
  // consistent with the layout-load and restore call sites.
  const handleBookPageCountChange = useCallback((requested: number) => {
    const raw = normalizedLayoutState?._raw as BookLayoutLike | undefined;
    if (!raw) return;
    const { visible, archive, resolvedCount } = reconcilePageCount(
      raw, requested, surfaceStatesRef.current, bookHiddenPagesRef.current,
    );
    setSurfaceStates(visible);
    setBookHiddenPages(archive);
    setBookPageCount(resolvedCount);
  }, [normalizedLayoutState, surfaceStatesRef, setSurfaceStates]);

  // ── Book: read-only spread preview (D6 — edit single pages, preview
  // spreads) ─────────────────────────────────────────────────────────────
  // Groups the CURRENT VISIBLE pages only (never the held/archived ones —
  // previewing a page the customer can't currently see would be confusing).
  // Reuses each page's already-computed thumbnail (canvases[0].dataUrl, the
  // same one the card grid renders) rather than a fourth frame-drawing path
  // (CLAUDE.md "Three frame renderers") — this view only adds the spread
  // *layout*, never re-renders a frame.
  const [showSpreadPreview, setShowSpreadPreview] = useState(false);
  const { bookSpreads, bookCoverPreview, bookBackCoverPreview } = useMemo(() => {
    if (!isBookProduct) return { bookSpreads: [], bookCoverPreview: null, bookBackCoverPreview: null };
    // mm is the common unit for sizing the cover-wrap panels proportionally
    // against spineWidthMm below; px-only canvases fall back to treating
    // their pixel width as a proportional unit (still correct for the ratio,
    // just not a real mm figure).
    const widthMmOf = (canvas: { width?: number; widthMm?: number; dpi?: number } | undefined): number => {
      if (!canvas) return 0;
      if (canvas.widthMm) return canvas.widthMm;
      if (canvas.width && canvas.dpi) return (canvas.width / canvas.dpi) * 25.4;
      return canvas.width || 0;
    };
    const pages = surfaceStates.map(s => {
      const { role, pageIndex } = roleForSurfaceKey(s.key);
      return {
        key: s.key,
        role,
        pageIndex,
        label: s.label,
        dataUrl: s.canvases[0]?.dataUrl ?? null,
        canvasWidth: s.def.canvas?.width || 1200,
        canvasHeight: s.def.canvas?.height || 1800,
        canvasWidthMm: widthMmOf(s.def.canvas),
      };
    });
    // The standalone cover/back-cover spreads pagesToSpreads() produces are
    // redundant with the cover-wrap panel rendered separately below — filter
    // them out of the regular list rather than showing the cover twice.
    const innerSpreads = pagesToSpreads(pages).filter(spread =>
      !(spread.length === 1 && (spread[0].role === 'cover' || spread[0].role === 'backCover'))
    );
    return {
      bookSpreads: innerSpreads,
      bookCoverPreview: pages.find(p => p.role === 'cover') ?? null,
      bookBackCoverPreview: pages.find(p => p.role === 'backCover') ?? null,
    };
  }, [isBookProduct, surfaceStates]);

  // R2 (BOOK_LAYOUT_PRD.md) — recomputed from the CURRENT page count, same
  // as the backend does at materialize time (D4: spine changes whenever the
  // customer changes the page count, never resolved once at author time).
  const bookSpineWidthMm = useMemo(() => {
    if (!isBookProduct) return null;
    const raw = normalizedLayoutState?._raw as BookLayoutLike | undefined;
    if (!raw?.book) return null;
    return spineWidthMm(bookPageCount, raw.book.paperThicknessMm || 0, raw.book.coverThicknessMm || 0);
  }, [isBookProduct, normalizedLayoutState, bookPageCount]);

  return {
    isBookProduct, bookPageCount, setBookPageCount, bookHiddenPages, setBookHiddenPages, bookHiddenPagesRef,
    pendingBookOverflow, setPendingBookOverflow, bookOverflowDecidedRef,
    bookPageBounds, handleBookPageCountChange, showSpreadPreview, setShowSpreadPreview,
    bookSpreads, bookCoverPreview, bookBackCoverPreview, bookSpineWidthMm,
  };
}
