'use client';

import { useEffect, useMemo, useState } from 'react';
import { collectLowDpiFrames, type LowDpiFrame } from '@/lib/dpi-utils';
import { getImageSize } from '@/lib/image-utils';
import { collectEmptySurfaces } from '@/lib/submit-guards';
import type { CanvasItem, SurfaceState } from './types';

/** The warnings shown before submit and on the cards: sides that would print
 *  blank and photos below print resolution. Both warn; neither blocks. (The
 *  third, photos placed twice, is still in the page — see duplicateFills.) */
export function useSubmitGuards({ layout, surfaceStates, canvases, isBookProduct }: {
  layout: unknown;
  surfaceStates: SurfaceState[];
  canvases: CanvasItem[];
  isBookProduct: boolean;
}) {
  // Under-DPI frames for the low-resolution print warning (Phase 2 item 4).
  // Non-blocking: shows card pills + a pre-submit notice, never stops submit.
  const [lowDpiFrames, setLowDpiFrames] = useState<LowDpiFrame[]>([]);

  // Pre-submit guard (Phase 3): surfaces that would print blank.
  const emptySurfaces = useMemo(() => {
    // Blank inner pages are an intentional, common outcome for books (D3 —
    // "people leave pages for writing"), not a mistake, so exclude them from
    // this warning; covers being empty should still warn.
    const surfacesToCheck = isBookProduct
      ? surfaceStates.filter(s => !s.key.startsWith('page_'))
      : surfaceStates;
    return collectEmptySurfaces(surfacesToCheck);
  }, [surfaceStates, isBookProduct]);

  // Worst under-DPI frame per card, for the amber corner pill. Keyed by
  // `${surfaceKey ?? ''}:${canvasIdx}` to cover both grid variants.
  const lowDpiByCard = useMemo(() => {
    const map = new Map<string, LowDpiFrame>();
    for (const f of lowDpiFrames) {
      const key = `${f.surfaceKey ?? ''}:${f.canvasIdx}`;
      const cur = map.get(key);
      if (!cur || f.dpi < cur.dpi) map.set(key, f);
    }
    return map;
  }, [lowDpiFrames]);

  // ── Low-resolution sweep (Phase 2 item 4) ────────────────────────────────
  // Debounced: reacts to placed photos, saved modal zoom (FrameState.scale),
  // rotation, and fit-mode flips. Cache-warm getImageSize keeps re-runs
  // cheap; a first run may decode files not yet in the metadata cache.
  useEffect(() => {
    if (!layout) return;
    // Cancellation flag: an in-flight sweep from a previous state must not
    // land after a newer one and overwrite fresh results with stale ones.
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const groups = surfaceStates.length > 1
          ? surfaceStates.map(s => ({
              canvases: s.canvases,
              layoutDef: s.def,
              surfaceKey: s.key,
              surfaceLabel: s.label || s.key,
            }))
          : [{ canvases, layoutDef: layout, surfaceKey: null }];
        const result = await collectLowDpiFrames(groups as any, getImageSize);
        if (!cancelled) setLowDpiFrames(result);
      } catch {
        // The warning is best-effort — never let it disturb the editor.
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [canvases, surfaceStates, layout]);

  return { lowDpiFrames, emptySurfaces, lowDpiByCard };
}
