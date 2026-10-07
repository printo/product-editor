'use client';

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { normalizeLayout, filterSurfaces, type NormalizedLayout } from '@/lib/layout-utils';
import { printedHolidayLocale } from '@/lib/calendar';
import type { BookLayoutLike } from '@/lib/book-layout';
import { reconcilePageCount } from './book-pages';
import type { FitMode, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;

/** Loads the layout through /editor/init (layout JSON, fonts, and in the embed
 *  the session's order id and quantity) and seeds the page state from it; also
 *  loads the selected Google fonts. The state stays the page's; this sets it. */
export function useLayoutLoader({
  layoutName, embedToken, status, apiBase, getAuthHeaders, orderId, setOrderId, setSessionQty,
  selectedFonts, setSelectedFonts, loadGoogleFont, setError, setLayout, setLayoutLoading,
  setNormalizedLayoutState, setSurfaceStates, setActiveSurfaceKey, setBookPageCount, setBookHiddenPages,
}: {
  layoutName: string;
  embedToken: string | null;
  status: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  orderId: string;
  setOrderId: Setter<string>;
  setSessionQty: Setter<number | null>;
  selectedFonts: string[];
  setSelectedFonts: Setter<string[]>;
  loadGoogleFont: (font: string) => void;
  setError: Setter<string | null>;
  setLayout: Setter<any>;
  setLayoutLoading: Setter<boolean>;
  setNormalizedLayoutState: Setter<NormalizedLayout | null>;
  setSurfaceStates: Setter<SurfaceState[]>;
  setActiveSurfaceKey: Setter<string>;
  setBookPageCount: Setter<number>;
  setBookHiddenPages: Setter<Record<string, SurfaceState>>;
}) {
  // The client-generated id in play before the embed session id was adopted —
  // lets the restore effect fall back to a pre-adoption autosave once.
  const legacyOrderIdRef = useRef<string | null>(null);

  // (Fonts are no longer fetched here — they're batched with the layout JSON
  //  in the single /editor/init request below.)

  useEffect(() => {
    selectedFonts.forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

  useEffect(() => {
    const canFetch = embedToken || status === 'authenticated';
    if (!canFetch || !layoutName) return;

    const fetchLayout = async () => {
      setLayoutLoading(true);
      try {
        // C6 batched mount: one round trip for layout JSON + fonts list.
        // /editor/init re-uses GetLayoutView's cache, so no extra disk hit.
        const surfacesParam = new URLSearchParams(window.location.search).get('surfaces') || '';
        const initUrl = `${apiBase}/editor/init?layout=${encodeURIComponent(layoutName)}${surfacesParam ? `&surfaces=${encodeURIComponent(surfacesParam)}` : ''}`;
        const res = await fetch(initUrl, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        if (!res.ok) {
          setError(res.status === 404 ? 'Layout not found.' : 'Failed to load layout.');
          return;
        }
        const payload = await res.json();
        const item = payload.layout;
        // Embed mode adopts the SESSION order id (Phase 3): the proxy injects
        // it upstream and editor/init echoes it, so autosave/restore and the
        // eventual submit all key the same server row — an iframe reload
        // without ?order_id= no longer orphans the design. Set BEFORE
        // setLayout so React batches them and the run-once restore effect
        // fires with the adopted id. Dashboard: payload.order_id is null.
        if (embedToken && typeof payload.order_id === 'string' && payload.order_id && payload.order_id !== orderId) {
          legacyOrderIdRef.current = orderId;
          setOrderId(payload.order_id);
        }
        // Adopt the SESSION quantity when the caller set one — it outranks the
        // ?qty=N URL param because it is what editor/render enforces. Absent
        // (null) leaves the URL fallback in place; the layout resolves before
        // any file pick, so this is set before the first qty comparison runs.
        if (typeof payload.qty === 'number' && Number.isInteger(payload.qty) && payload.qty > 0) {
          setSessionQty(payload.qty);
        }
        if (Array.isArray(payload.fonts) && payload.fonts.length) {
          setSelectedFonts(payload.fonts);
        }
        let normalized: NormalizedLayout;
        let initSurfaces: SurfaceState[];
        // A book's surfaces are the customer's chosen page count, not a
        // fixed list — normalizeLayout() has no concept of that, so build
        // surfaceStates via the same reconciliation used for every later
        // page-count change (book-pages.ts::reconcilePageCount), starting
        // from the template's default count (BOOK_LAYOUT_PRD.md D2/R1).
        if (item.productType === 'book') {
          const { visible, resolvedCount } = reconcilePageCount(item as BookLayoutLike, undefined, [], {});
          initSurfaces = visible;
          setBookPageCount(resolvedCount);
          setBookHiddenPages({});
          normalized = {
            name: item.name || '',
            type: 'product',
            surfaces: visible.map(s => s.def),
            tags: item.tags || [],
            createdAt: item.createdAt ?? null,
            updatedAt: item.updatedAt ?? null,
            createdBy: item.createdBy || '',
            updatedBy: item.updatedBy || '',
            metadata: item.metadata || [],
            _raw: item,
          };
        } else {
          normalized = normalizeLayout(item);
          if (surfacesParam) {
            normalized = filterSurfaces(normalized, surfacesParam.split(',').map(s => s.trim()));
          }
          initSurfaces = normalized.surfaces.map(s => ({
            key: s.key,
            label: s.label,
            def: s,
            files: [],
            canvases: [],
            globalFitMode: 'contain' as FitMode,
          }));
        }
        setNormalizedLayoutState(normalized);
        setSurfaceStates(initSurfaces);
        const firstKey = normalized.surfaces[0]?.key || 'default';
        setActiveSurfaceKey(firstKey);
        const firstSurface = normalized.surfaces[0];
        setLayout({
          id: item.name,
          name: item.name,
          productType: item.productType || null,
          dimensions: firstSurface?.canvas?.widthMm && firstSurface?.canvas?.heightMm
            ? `${firstSurface.canvas.widthMm.toFixed(2)}x${firstSurface.canvas.heightMm.toFixed(2)}mm` : null,
          height: firstSurface?.canvas?.height || 0,
          canvas: firstSurface?.canvas || {},
          frames: firstSurface?.frames || [],
          tags: item.tags || [],
          maskUrl: firstSurface?.maskUrl || null,
          maskOnExport: firstSurface?.maskOnExport ?? false,
          createdAt: item.createdAt || null,
          updatedAt: item.updatedAt || null,
          createdBy: item.createdBy || 'System',
          updatedBy: item.updatedBy || 'System',
          metadata: item.metadata || [],
          weekStart: item.calendar?.weekStart || 'sunday',
          // null when the print carries no holidays (holidaySource off/absent).
          holidayLocale: printedHolidayLocale(item.calendar),
          calendarDefaultYear: item.monthRange?.defaultYear ?? 'current',
        });
      } catch {
        setError('Failed to load layout.');
      } finally {
        setLayoutLoading(false);
      }
    };
    fetchLayout();
    // orderId is read only for the embed adoption comparison — including it
    // would re-fetch the layout every time the id is adopted (loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutName, embedToken, status, apiBase, getAuthHeaders]);

  return { legacyOrderIdRef };
}

/** Keeps the page's `layout` (canvas, frames, mask, dimensions) on the active
 *  surface of a multi-surface product. */
export function useActiveSurfaceLayout({ activeSurfaceKey, activeSurface, normalizedLayoutState, setLayout }: {
  activeSurfaceKey: string;
  activeSurface: SurfaceState | undefined;
  normalizedLayoutState: NormalizedLayout | null;
  setLayout: Setter<any>;
}) {
  useEffect(() => {
    if (!activeSurface?.def || !normalizedLayoutState) return;
    setLayout((prev: any) => prev ? {
      ...prev,
      canvas: activeSurface.def.canvas,
      frames: activeSurface.def.frames,
      maskUrl: activeSurface.def.maskUrl,
      maskOnExport: activeSurface.def.maskOnExport,
      dimensions: activeSurface.def.canvas?.widthMm && activeSurface.def.canvas?.heightMm
        ? `${activeSurface.def.canvas.widthMm.toFixed(2)}x${activeSurface.def.canvas.heightMm.toFixed(2)}mm` : prev?.dimensions,
    } : prev);
  }, [activeSurfaceKey, activeSurface?.def, normalizedLayoutState, setLayout]);
}
