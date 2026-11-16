'use client';

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { convertAndPartitionFiles } from '@/lib/heic-convert';
import type { ServerHeicConverter } from '@/lib/heic-convert';
import { COVER_BACK, COVER_FRONT, isCoverKey, type CoverKey } from '@/lib/calendar-covers';
import type { CanvasItem, FitMode, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;

/** A calendar's front and back cover sheets: which the layout carries and how
 *  photos get onto them. The covers live in `surfaceStates` beside the month
 *  surface (so saving, photo storage and restore treat them like any other
 *  surface); this hook is the only place that fills one. */
export function useCalendarCovers({
  surfaceStates, setSurfaceStates, generateCanvasesForLayout, serverHeicConvert, setError, setUploadWarning,
}: {
  surfaceStates: SurfaceState[];
  setSurfaceStates: Setter<SurfaceState[]>;
  generateCanvasesForLayout: (
    layoutDef: any, files: File[], fitMode: FitMode, existing?: CanvasItem[],
  ) => Promise<CanvasItem[]>;
  serverHeicConvert?: ServerHeicConverter;
  setError: Setter<string | null>;
  setUploadWarning: Setter<string | null>;
}) {
  const [busyCover, setBusyCover] = useState<CoverKey | null>(null);

  const front = useMemo(() => surfaceStates.find(s => s.key === COVER_FRONT) ?? null, [surfaceStates]);
  const back = useMemo(() => surfaceStates.find(s => s.key === COVER_BACK) ?? null, [surfaceStates]);

  /** Put the picked photos on one cover, filling its photo windows in order.
   *  A new pick replaces that cover's photos, as picking again does on a side;
   *  edits to a photo that is picked again are kept (same identity reuse). */
  const addCoverPhotos = useCallback(async (key: CoverKey, picked: File[]) => {
    const surface = surfaceStates.find(s => s.key === key);
    if (!surface || picked.length === 0) return;
    setBusyCover(key);
    setError(null);
    try {
      const { accepted, warning } = await convertAndPartitionFiles(picked, serverHeicConvert);
      if (warning) setUploadWarning(warning);
      if (accepted.length === 0) return;
      const windows = Math.max(1, surface.def.frames?.length ?? 1);
      const files = accepted.slice(0, windows);
      if (accepted.length > windows) {
        setUploadWarning(`Only ${windows} photo${windows !== 1 ? 's' : ''} fit on the ${surface.label.toLowerCase()}.`);
        setTimeout(() => setUploadWarning(null), 5000);
      }
      // A cover is drawn from its own geometry only: none of the calendar's
      // fields, so no date grid and no calendar rotation rule.
      const layoutDef = {
        key,
        canvas: surface.def.canvas,
        frames: surface.def.frames,
        maskUrl: surface.def.maskUrl,
        maskOnExport: surface.def.maskOnExport,
        frameMaskUrl: surface.def.frameMaskUrl,
        artworkMaskUrl: surface.def.artworkMaskUrl,
        printSheet: surface.def.printSheet,
      };
      const canvases = await generateCanvasesForLayout(layoutDef, files, surface.globalFitMode, surface.canvases);
      setSurfaceStates(prev => prev.map(s => (s.key === key ? { ...s, files, canvases } : s)));
    } catch {
      setError('Failed to process images');
    } finally {
      setBusyCover(null);
    }
  }, [surfaceStates, setSurfaceStates, generateCanvasesForLayout, serverHeicConvert, setError, setUploadWarning]);

  return { front, back, busyCover, addCoverPhotos, hasCovers: Boolean(front || back), isCoverKey };
}
