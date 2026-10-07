'use client';

import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { getCanvasSpec, getFrames } from '@/lib/layout-utils';
import { getImageMetadata } from '@/lib/image-utils';
import { detectFileOrientation } from '@/lib/ml-orientation';
import { pdfDerivedFiles } from '@/lib/pdf-import';
import { planCanvasReuse } from './canvas-merge';
import { resolveRotation } from './editor-utils';
import { renderCanvas as renderCanvasCore, calculateSmartCropOffsets } from './fabric-renderer';
import { planFrameSlots } from './surface-allocation';
import type { CanvasItem, FitMode, FrameState, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;

/** One blob URL per photo File, cached so a photo is never turned into two
 *  URLs. The page revokes them all on unmount, and on a fresh photo pick. */
export function useObjectUrls() {
  // WeakMap allows the File entry to be GC'd when the user removes a frame —
  // a Map would pin every File ever inserted for the lifetime of the page.
  // The parallel Set tracks created URL strings so unmount/cleanup can revoke
  // them (WeakMap isn't iterable).
  const fileUrlCache = useRef<WeakMap<File, string>>(new WeakMap());
  const createdObjectURLs = useRef<Set<string>>(new Set());

  const getFileUrl = useCallback((file: File): string => {
    let url = fileUrlCache.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      fileUrlCache.current.set(file, url);
      createdObjectURLs.current.add(url);
    }
    return url;
  }, []);

  return { getFileUrl, fileUrlCache, createdObjectURLs };
}

/** Draws a canvas with the current layout (or an override) — the preview
 *  and thumbnail renderer the whole page uses. */
export function useRenderCanvas(layout: any, getFileUrl: (file: File) => string) {
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const renderCanvas = useCallback(async (
    canvasItem: CanvasItem,
    options: {
      excludeFrameIdx?: number | null;
      isExport?: boolean;
      includeMask?: boolean;
      layoutOverride?: any;
      thumbnail?: boolean;
    } = {}
  ) => {
    return renderCanvasCore(canvasItem, options.layoutOverride || layoutRef.current, getFileUrl, options);
  }, [getFileUrl]);

  return renderCanvas;
}

/** Builds the cards from the photos (orientation, smart crop, reusing each
 *  photo's previous edits), and re-renders them when the customer flips
 *  Fit/Cover or Blur Effect for the whole design. */
export function useCanvasGeneration({
  layout, files, isProcessing, setIsProcessing, setError, isCalendarProduct, setRenderProgress, canvasesRef, setCanvases,
  renderCanvas, apiBase, getAuthHeaders, globalFitModeRef, globalBlurFillRef, skipNextGenerateRef, surfaceStates,
  setSurfaceStates, fitModeUserToggledRef, globalFitMode, activeSurfaceKey, blurFillUserToggledRef, globalBlurFill,
}: {
  layout: any;
  files: File[];
  isProcessing: boolean;
  setIsProcessing: Setter<boolean>;
  setError: Setter<string | null>;
  isCalendarProduct: boolean;
  setRenderProgress: Setter<{ current: number; total: number } | null>;
  canvasesRef: Ref<CanvasItem[]>;
  setCanvases: Setter<CanvasItem[]>;
  renderCanvas: ReturnType<typeof useRenderCanvas>;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  globalFitModeRef: Ref<FitMode>;
  globalBlurFillRef: Ref<boolean>;
  skipNextGenerateRef: Ref<boolean>;
  surfaceStates: SurfaceState[];
  setSurfaceStates: Setter<SurfaceState[]>;
  fitModeUserToggledRef: Ref<boolean>;
  globalFitMode: FitMode;
  activeSurfaceKey: string;
  blurFillUserToggledRef: Ref<boolean>;
  globalBlurFill: boolean;
}) {
  const generateCanvasesForLayout = useCallback(async (
    layoutDef: any, surfaceFiles: File[], fitMode: FitMode,
    existingCanvases: CanvasItem[] = canvasesRef.current
  ): Promise<CanvasItem[]> => {
    if (!layoutDef || surfaceFiles.length === 0) return [];
    const frameCount = layoutDef.frames?.length || 1;
    // Same 12-page cap as generateCanvases for calendar products.
    const canvasCount = layoutDef.productType === 'calendar'
      ? Math.min(Math.ceil(surfaceFiles.length / frameCount), 12)
      : Math.ceil(surfaceFiles.length / frameCount);
    // Identity-based reuse (Phase 3 — never lose edits); see generateCanvases.
    const plannedSlots = planFrameSlots(surfaceFiles, frameCount, canvasCount);
    const reusePlan = planCanvasReuse(existingCanvases, plannedSlots);

    const newCanvases: CanvasItem[] = [];
    for (let i = 0; i < canvasCount; i++) {
      const canvasFrames: FrameState[] = [];

      for (let f = 0; f < frameCount; f++) {
        const file = plannedSlots[i][f];
        const claimedFrame = reusePlan.frames[i][f];

        if (file) {
            if (claimedFrame) {
            canvasFrames.push({
              ...claimedFrame,
              id: f,
              originalFile: file, // Ensure we use the latest file object
              fileName: file.name,
              fileSize: file.size,
            });
          } else {
            const { width: imgW, height: imgH, element: imgEl } = await getImageMetadata(file);
            const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
            const frames = getFrames(layoutDef) || [];
            const frameSpec = frames[f] || { x: 0, y: 0, width: 1, height: 1 };
            const canvasW = canvasSpec.width;
            const canvasH = canvasSpec.height;
            const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
            const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
            const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

            // Server-side MediaPipe Pose Landmarker decides rotation when the
            // aspect heuristic doesn't already call for a fill-rotate — see
            // resolveRotation. PDF-derived pages are document content, not
            // photos: pose detection would find nothing (wasting a round
            // trip) and the aspect heuristic could rotate a deliberately-
            // designed page just because its ratio doesn't match the frame —
            // skip both entirely for those.
            const rotation = pdfDerivedFiles.has(file)
              ? 0
              : resolveRotation(
                  await detectFileOrientation(apiBase, file, imgEl, getAuthHeaders ? getAuthHeaders() : undefined),
                  imgW, imgH, frameW, frameH,
                );

            let offset = { x: 0, y: 0 };
            if (fitMode === 'cover') {
              const ck = `${file.name}:${file.size}:${file.lastModified}:${frameW}x${frameH}:${rotation}`;
              offset = await calculateSmartCropOffsets(imgEl, frameW, frameH, rotation, ck);
            }

            canvasFrames.push({
              id: f, originalFile: file,
              fileName: file.name, fileSize: file.size,
              offset, scale: 1, rotation, fitMode,
              fillStyle: globalBlurFillRef.current ? 'blur' : undefined, // Blur Effect on by default
            });
          }
        }
      }
      const carry = reusePlan.carry[i];
      const item: CanvasItem = {
        id: i,
        frames: canvasFrames,
        overlays: carry?.overlays || [],
        bgColor: carry?.bgColor || '#ffffff',
        paperColor: carry?.paperColor || '#ffffff',
        dataUrl: carry?.dataUrl || null
      };

      if (!item.dataUrl) {
          // Use thumbnail for grid previews to save memory and CPU
          item.dataUrl = await renderCanvas({ ...item, dataUrl: null }, { thumbnail: true, layoutOverride: layoutDef });
        }

      newCanvases.push(item);
    }
    return newCanvases;
  }, [renderCanvas, apiBase, getAuthHeaders, canvasesRef, globalBlurFillRef]);

  const generateCanvases = useCallback(async () => {
    if (!layout || files.length === 0 || isProcessing) return;
    setIsProcessing(true);
    setError(null);

    const frameCount = layout.frames?.length || 1;
    // Calendar products render exactly 12 month pages — cap the photo
    // canvases so canvas i previews month i's photo and the ZIP holds 12
    // files, not 12 per photo (server slices per-surface the same way).
    const canvasCount = isCalendarProduct
      ? Math.min(Math.ceil(files.length / frameCount), 12)
      : Math.ceil(files.length / frameCount);
    setRenderProgress({ current: 0, total: canvasCount });
    
    // Use current canvases from ref to preserve transforms without creating a dependency loop
    const existingCanvases = [...canvasesRef.current];

    // Identity-based reuse plan (Phase 3 — never lose edits): each slot's
    // file claims its previous edits by name:size:lastModified, so adding,
    // removing or reordering photos no longer resets pans/zooms or leaves
    // overlays glued to the wrong page. Planned synchronously up front so
    // the parallel batch builders below stay deterministic.
    const plannedSlots: (File | null)[][] = Array.from({ length: canvasCount }, (_, c) =>
      Array.from({ length: frameCount }, (_, f) => files[(c * frameCount + f) % files.length] || null)
    );
    const reusePlan = planCanvasReuse(existingCanvases, plannedSlots);

    try {
      const built: CanvasItem[] = [];
      // 8 simultaneous getImageMetadata + smartcrop calls. Each pins a
      // full-res HTMLImageElement (~50 MB for a 12 MP photo). At 8 in
      // flight we're ceiling at ~400 MB peak, well within desktop and
      // the median tablet's headroom; bumping further (16) reaches the
      // OOM zone on 4 GB devices for 200-photo batches. Was 5 — the
      // next 3 slots roughly halve the metadata+smartcrop wall time on
      // big uploads without changing the memory ceiling enough to
      // matter.
      const BATCH_SIZE = 8;
      
      for (let i = 0; i < canvasCount; i += BATCH_SIZE) {
        const end = Math.min(i + BATCH_SIZE, canvasCount);
        const batchPromises: Promise<CanvasItem>[] = [];

        for (let batchIdx = i; batchIdx < end; batchIdx++) {
          const p: Promise<CanvasItem> = (async () => {
            const canvasFrames: FrameState[] = [];

            for (let f = 0; f < frameCount; f++) {
              const file = plannedSlots[batchIdx][f];
              const claimedFrame = reusePlan.frames[batchIdx][f];

              if (file) {
                if (claimedFrame) {
                  canvasFrames.push({
                    ...claimedFrame,
                    id: f,
                    originalFile: file,
                    fileName: file.name,
                    fileSize: file.size,
                  });
                } else {
                  const { width: imgW, height: imgH, element: imgEl } = await getImageMetadata(file);
                  const frameSpec = layout.frames?.[f] || { width: 1, height: 1 };
                  const canvasW = layout.canvas?.width || layout.surfaces?.[0]?.canvas?.width || 1200;
                  const canvasH = layout.canvas?.height || layout.surfaces?.[0]?.canvas?.height || 1800;
                  const frameW = frameSpec.width <= 1 ? frameSpec.width * canvasW : frameSpec.width;
                  const frameH = frameSpec.height <= 1 ? frameSpec.height * canvasH : frameSpec.height;

                  // PDF-derived pages skip auto-orientation entirely — see
                  // the other call site above for why.
                  const rotation = pdfDerivedFiles.has(file)
                    ? 0
                    : resolveRotation(
                        await detectFileOrientation(apiBase, file, imgEl, getAuthHeaders ? getAuthHeaders() : undefined),
                        imgW, imgH, frameW, frameH,
                      );

                  let offset = { x: 0, y: 0 };
                  if (globalFitModeRef.current === 'cover') {
                    const ck = `${file.name}:${file.size}:${file.lastModified}:${frameW}x${frameH}:${rotation}`;
                    offset = await calculateSmartCropOffsets(imgEl, frameW, frameH, rotation, ck);
                  }

                  canvasFrames.push({
                    id: f, originalFile: file,
                    fileName: file.name, fileSize: file.size,
                    offset, scale: 1, rotation, fitMode: globalFitModeRef.current,
                    fillStyle: globalBlurFillRef.current ? 'blur' : undefined, // Blur Effect on by default
                  });
                }
              }
            }
            
            const carry = reusePlan.carry[batchIdx];
            const item: CanvasItem = {
              id: batchIdx,
              frames: canvasFrames,
              overlays: carry?.overlays || [],
              bgColor: carry?.bgColor || '#ffffff',
              paperColor: carry?.paperColor || '#ffffff',
              // The plan only carries a dataUrl when every frame kept its
              // original slot — anything else needs a fresh thumbnail.
              dataUrl: carry?.dataUrl || null,
            };

            if (!item.dataUrl) {
              item.dataUrl = await renderCanvas({ ...item, dataUrl: null }, { thumbnail: true });
            }
            return item;
          })();
          batchPromises.push(p);
        }

        const batchResults = await Promise.all(batchPromises);
        built.push(...batchResults);
        
        // Update UI every batch
        setCanvases([...built]);
        setRenderProgress({ current: built.length, total: canvasCount });
        
        // Yield to main thread
        await new Promise(r => setTimeout(r, 0));
      }
    } catch (err) {
      console.error(err);
      setError('Failed to process images');
    } finally {
      setIsProcessing(false);
      setRenderProgress(null);
    }
    // isProcessing is read as a re-entry GUARD, not a trigger — including it
    // in deps would cause generateCanvases to re-create on every flip,
    // re-firing the (layout, files, generateCanvases) effect below in a
    // tight loop. globalFitMode similarly excluded — passed through into
    // renderCanvas, which captures the latest value via its own closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, files, renderCanvas]);

  useEffect(() => {
    if (skipNextGenerateRef.current) { skipNextGenerateRef.current = false; return; }
    if (layout && files.length > 0) generateCanvases();
  }, [layout, files, generateCanvases, skipNextGenerateRef]);

  useEffect(() => {
    if (surfaceStates.length === 0) return;
    // Only a USER toggle of Fit/Cover may recompute smartcrop offsets
    // (Phase 3): restore and surface-switch also set globalFitMode, and
    // letting them through overwrote every manual pan with smartcrop
    // defaults on reload of a cover-mode session.
    if (!fitModeUserToggledRef.current) return;
    fitModeUserToggledRef.current = false;
    let cancelled = false;
    (async () => {
      setIsProcessing(true);
      setRenderProgress({ current: 0, total: surfaceStates.reduce((acc, s) => acc + s.canvases.length, 0) });

      const updatedSurfaces: SurfaceState[] = [];
      let totalProcessed = 0;

      for (const s of surfaceStates) {
        const updatedCanvases: CanvasItem[] = [];
        // Process canvases in small chunks to avoid hanging the UI
        const chunkSize = 5;
        for (let i = 0; i < s.canvases.length; i += chunkSize) {
          if (cancelled) return;
          const chunk = s.canvases.slice(i, i + chunkSize);
          const processedChunk = await Promise.all(chunk.map(async (c) => {
            const patchedFrames = await Promise.all(c.frames.map(async (f, fIdx) => {
              let newOffset = { ...f.offset };
              if (globalFitMode === 'cover' && f.originalFile) {
                const { element: imgEl } = await getImageMetadata(f.originalFile);
                const frames = s.def.frames || [];
                const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
                const canvasW = s.def.canvas?.width || 1200;
                const canvasH = s.def.canvas?.height || 1800;
                const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
                const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
                const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;
                const ck = f.fileId
                  ? `${f.fileId}:${frameW}x${frameH}:${f.rotation}`
                  : `${f.originalFile.name}:${f.originalFile.size}:${f.originalFile.lastModified}:${frameW}x${frameH}:${f.rotation}`;
                newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, f.rotation, ck);
              } else if (globalFitMode === 'contain') {
                newOffset = { x: 0, y: 0 };
              }
              return { ...f, fitMode: globalFitMode, offset: newOffset };
            }));
            const patchedCanvas = { ...c, frames: patchedFrames };
            const dataUrl = await renderCanvas(patchedCanvas, { thumbnail: true, layoutOverride: s.def });
            return { ...patchedCanvas, dataUrl };
          }));
          updatedCanvases.push(...processedChunk);
          totalProcessed += processedChunk.length;
          setRenderProgress(prev => prev ? { ...prev, current: totalProcessed } : null);
        }
        updatedSurfaces.push({ ...s, globalFitMode, canvases: updatedCanvases });
      }

      if (cancelled) return;

      setSurfaceStates(updatedSurfaces);
      
      // Synchronize the active canvases state
      const active = updatedSurfaces.find(s => s.key === activeSurfaceKey);
      if (active) {
        setCanvases(active.canvases);
      }

      setIsProcessing(false);
      setRenderProgress(null);
    })();
    return () => { cancelled = true; };
    // surfaceStates + activeSurfaceKey deliberately excluded — including
    // them creates a self-feeding loop because the effect calls
    // setSurfaceStates inside. The latest values are read via a stable
    // setSurfaceStates updater pattern in nearby effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFitMode, renderCanvas]);

  // Global "Blur sides" toggle — set fillStyle on every frame + re-render the
  // grid thumbnails. Guarded so it only fires on a real user toggle, never on
  // mount/restore. Fill shows only on contain frames (the renderer gates it);
  // setting it on cover frames is harmless.
  useEffect(() => {
    if (!blurFillUserToggledRef.current) return;
    blurFillUserToggledRef.current = false;
    let cancelled = false;
    (async () => {
      // Show the same progress UI as the Fit/Cover toggle so the customer sees
      // the thumbnails re-rendering instead of a frozen screen.
      setIsProcessing(true);
      setRenderProgress({ current: 0, total: surfaceStates.reduce((a, s) => a + s.canvases.length, 0) });
      const nextStyle: 'blur' | undefined = globalBlurFill ? 'blur' : undefined;
      const updatedSurfaces: SurfaceState[] = [];
      let done = 0;
      for (const s of surfaceStates) {
        const updatedCanvases: CanvasItem[] = [];
        for (const c of s.canvases) {
          if (cancelled) return;
          const patchedFrames = c.frames.map(f => ({ ...f, fillStyle: nextStyle }));
          const patchedCanvas = { ...c, frames: patchedFrames };
          const dataUrl = await renderCanvas(patchedCanvas, { thumbnail: true, layoutOverride: s.def });
          updatedCanvases.push({ ...patchedCanvas, dataUrl });
          done += 1;
          setRenderProgress(prev => (prev ? { ...prev, current: done } : null));
        }
        updatedSurfaces.push({ ...s, canvases: updatedCanvases });
      }
      if (cancelled) return;
      setSurfaceStates(updatedSurfaces);
      const active = updatedSurfaces.find(su => su.key === activeSurfaceKey);
      if (active) setCanvases(active.canvases);
      setIsProcessing(false);
      setRenderProgress(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalBlurFill, renderCanvas]);

  return { generateCanvasesForLayout };
}
