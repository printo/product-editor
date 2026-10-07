'use client';

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type React from 'react';
import { getCanvasSpec, getFrames, type NormalizedLayout } from '@/lib/layout-utils';
import { getImageMetadata } from '@/lib/image-utils';
import { convertAndPartitionFiles, isHeicFile } from '@/lib/heic-convert';
import { checkOrderQty } from '@/lib/submit-guards';
import { calculateSmartCropOffsets } from './fabric-renderer';
import { surfaceFrameCount } from './surface-allocation';
import { usePanGesture } from './usePanGesture';
import type { CanvasItem, FitMode, FrameState, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;
type CardTarget = { idx: number; surfaceKey: string | null };

/** What the grid cards do: open the editor, the quick actions (rotate, fit,
 *  blur, remove), drag-to-pan, tap-to-swap, and drag-and-drop (photos from
 *  the desktop, or one card onto another). The state stays the page's. */
export function useCardActions({
  layout, files, setFiles, canvases, setCanvases, surfaceStates, setSurfaceStates, activeSurfaceKey, setActiveSurfaceKey,
  normalizedLayoutState, activeCanvasIdx, setActiveCanvasIdx, setEditingCanvas, renderCanvas, generateCanvasesForLayout,
  repositionMode, swapSource, setSwapSource, deleteConfirm, setDeleteConfirm, orderQty, setQtyUnder,
  dragOverIdx, setDragOverIdx, isProcessing, heicConverting, setHeicConverting, expandPdfPages, serverHeicConvert,
  setUnsupportedWarning,
}: {
  layout: any;
  files: File[];
  setFiles: Setter<File[]>;
  canvases: CanvasItem[];
  setCanvases: Setter<CanvasItem[]>;
  surfaceStates: SurfaceState[];
  setSurfaceStates: Setter<SurfaceState[]>;
  activeSurfaceKey: string;
  setActiveSurfaceKey: Setter<string>;
  normalizedLayoutState: NormalizedLayout | null;
  activeCanvasIdx: number | null;
  setActiveCanvasIdx: Setter<number | null>;
  setEditingCanvas: Setter<CanvasItem | null>;
  renderCanvas: (canvasItem: CanvasItem, options?: { excludeFrameIdx?: number | null; isExport?: boolean; includeMask?: boolean; layoutOverride?: any; thumbnail?: boolean }) => Promise<string>;
  generateCanvasesForLayout: (layoutDef: any, files: File[], fitMode: FitMode) => Promise<CanvasItem[]>;
  repositionMode: boolean;
  swapSource: CardTarget | null;
  setSwapSource: Setter<CardTarget | null>;
  deleteConfirm: CardTarget | null;
  setDeleteConfirm: Setter<CardTarget | null>;
  orderQty: number | null;
  setQtyUnder: Setter<{ uploaded: number; needed: number } | null>;
  dragOverIdx: CardTarget | null;
  setDragOverIdx: Setter<CardTarget | null>;
  isProcessing: boolean;
  heicConverting: boolean;
  setHeicConverting: Setter<boolean>;
  expandPdfPages: (files: File[], opts: { maxSelectable: number | null }) => Promise<File[]>;
  serverHeicConvert: Parameters<typeof convertAndPartitionFiles>[1];
  setUnsupportedWarning: Setter<string | null>;
}) {
  // Keyed by `${surfaceKey ?? ''}:${idx}` — a quick-action toggle (Fit/Cover,
  // Blur, Rotate, BG) commits into `canvases`/`surfaceStates` only after its
  // async re-render finishes inside updateCanvasState. openEditor awaits the
  // matching entry so opening the modal mid-toggle can't seed it with the
  // pre-toggle frame (e.g. Fit Mode showing "Cover" right after the card
  // switched to "Contain").
  const pendingCanvasUpdatesRef = useRef<Map<string, Promise<CanvasItem | undefined>>>(new Map());

  const openEditor = async (idx: number, surfaceKey?: string) => {
    let targetCanvases = canvases;
    if (surfaceKey && surfaceKey !== activeSurfaceKey) {
      setActiveSurfaceKey(surfaceKey);
      const surface = surfaceStates.find(s => s.key === surfaceKey);
      if (surface) targetCanvases = surface.canvases;
    }
    const pendingKey = `${surfaceKey ?? ''}:${idx}`;
    const pending = pendingCanvasUpdatesRef.current.get(pendingKey);
    const c = (pending ? await pending : undefined) ?? targetCanvases[idx];
    if (!c) return;
    setActiveCanvasIdx(idx);
    const sp = new URLSearchParams(window.location.search);
    sp.set('canvas', idx.toString());
    window.history.replaceState({}, '', '?' + sp.toString());
    setEditingCanvas({
      ...c,
      frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })),
      overlays: c.overlays.map(o => ({ ...o })),
    });
  };

  const closeEditor = () => {
    setActiveCanvasIdx(null);
    setEditingCanvas(null);
    const sp = new URLSearchParams(window.location.search);
    if (sp.has('canvas')) {
      sp.delete('canvas');
      window.history.replaceState({}, '', sp.toString() ? '?' + sp.toString() : window.location.pathname);
    }
  };

  const updateCanvasState = useCallback((idx: number, surfaceKey: string | null, updateFn: (c: CanvasItem) => CanvasItem | Promise<CanvasItem>) => {
    const pendingKey = `${surfaceKey ?? ''}:${idx}`;
    const run = (async (): Promise<CanvasItem | undefined> => {
      if (surfaceKey) {
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return undefined;
        const targetSurface = surfaceStates[sIdx];
        const targetCanvas = targetSurface.canvases[idx];
        if (!targetCanvas) return undefined;

        const updatedCanvas = await updateFn(targetCanvas);
        // If every frame is missing its original file (restored from saved state,
        // no re-upload yet), skip the re-render to avoid overwriting the stored
        // dataUrl preview with a blank canvas.
        const canRerender = updatedCanvas.frames.some(f => f.originalFile !== null);
        if (canRerender) updatedCanvas.dataUrl = await renderCanvas(updatedCanvas, { thumbnail: true });

        setSurfaceStates(prev => prev.map((s, i) =>
          i === sIdx ? { ...s, canvases: s.canvases.map((c, ci) => ci === idx ? updatedCanvas : c) } : s
        ));
        if (surfaceKey === activeSurfaceKey) {
          setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
        }
        return updatedCanvas;
      } else {
        const targetCanvas = canvases[idx];
        if (!targetCanvas) return undefined;

        const updatedCanvas = await updateFn(targetCanvas);
        const canRerender = updatedCanvas.frames.some(f => f.originalFile !== null);
        if (canRerender) updatedCanvas.dataUrl = await renderCanvas(updatedCanvas, { thumbnail: true });

        setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
        return updatedCanvas;
      }
    })();

    pendingCanvasUpdatesRef.current.set(pendingKey, run);
    run.finally(() => {
      if (pendingCanvasUpdatesRef.current.get(pendingKey) === run) {
        pendingCanvasUpdatesRef.current.delete(pendingKey);
      }
    });
    return run;
  }, [surfaceStates, canvases, activeSurfaceKey, renderCanvas, setSurfaceStates, setCanvases]);

  const handleQuickRotate = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, async (c) => {
      const updatedFrames: FrameState[] = await Promise.all(c.frames.map(async (f, fIdx) => {
        const newRotation = (f.rotation + 90) % 360;
        let newOffset = { ...f.offset };
        
        // If the user hasn't manually adjusted the image, we can re-calculate smartcrop for the new rotation
        if (f.fitMode === 'cover' && f.offset.x === 0 && f.offset.y === 0 && f.scale === 1 && f.originalFile) {
          const { element: imgEl } = await getImageMetadata(f.originalFile);
          const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
          const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
          const frames = getFrames(layoutDef) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = canvasSpec.width;
          const canvasH = canvasSpec.height;
          const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
          const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
          const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

          newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, newRotation);
        }

        return { ...f, rotation: newRotation, offset: newOffset };
      }));
      return { ...c, frames: updatedFrames };
    });
  };

  const handleQuickToggleFit = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, async (c) => {
      const updatedFrames: FrameState[] = await Promise.all(c.frames.map(async (f, fIdx) => {
        const newFitMode: FitMode = f.fitMode === 'contain' ? 'cover' : 'contain';
        let newOffset = { ...f.offset };

        if (newFitMode === 'cover' && f.originalFile) {
          const { element: imgEl } = await getImageMetadata(f.originalFile);
          const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
          const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
          const frames = getFrames(layoutDef) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = canvasSpec.width;
          const canvasH = canvasSpec.height;
          const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
          const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
          const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

          newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, f.rotation);
        } else if (newFitMode === 'contain') {
          newOffset = { x: 0, y: 0 };
        }

        return { ...f, fitMode: newFitMode, offset: newOffset };
      }));
      return { ...c, frames: updatedFrames };
    });
  };

  // Per-card Blur Effect toggle — flips fillStyle on this canvas's frames only.
  // The renderer only shows the fill on contain frames, so it's harmless on cover.
  const handleQuickToggleBlur = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => {
      const nextStyle: 'blur' | undefined = c.frames.some(f => f.fillStyle === 'blur') ? undefined : 'blur';
      return { ...c, frames: c.frames.map(f => ({ ...f, fillStyle: nextStyle })) };
    });
  };

  const { handlePanStart, handlePanMove, handlePanEnd, panSuppressClickRef } = usePanGesture({
    repositionMode, surfaceStates, canvases, layout, updateCanvasState,
  });

  /** Card click guard — a completed pan must not open the editor modal. */
  const handleCardClick = (idx: number, surfaceKey: string | null = null) => {
    if (panSuppressClickRef.current) { panSuppressClickRef.current = false; return; }
    if (swapSource) {
      const src = swapSource;
      setSwapSource(null);
      if (!(src.idx === idx && src.surfaceKey === surfaceKey)) {
        void swapCards(src, { idx, surfaceKey });
      }
      return;
    }
    openEditor(idx, surfaceKey ?? undefined);
  };

  // Kept for the hidden Set-Background-Color button (see the two commented-out
  // JSX blocks below) rather than deleted alongside it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleQuickSetBg = (idx: number, color: string, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => ({
      ...c,
      bgColor: color
    }));
  };

  const handleQuickDelete = (idx: number, surfaceKey: string | null = null) => {
    setDeleteConfirm({ idx, surfaceKey });
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    const { idx, surfaceKey } = deleteConfirm;
    if (surfaceKey) {
      const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
      if (sIdx !== -1) {
        setSurfaceStates(prev => prev.map((s, i) =>
          i === sIdx ? { ...s, files: [], canvases: [] } : s
        ));
        if (surfaceKey === activeSurfaceKey) {
          setFiles([]);
          setCanvases([]);
        }
      }
    } else {
      // Delete removes ONLY this canvas's photo(s) (Phase 3). idx is a
      // CANVAS index — splice the whole frame-count block of files AND the
      // canvas itself, so every later canvas stays aligned with its photos
      // and the identity merge preserves their edits.
      const frameCount = layout?.frames?.length || 1;
      const nextFiles = [
        ...files.slice(0, idx * frameCount),
        ...files.slice((idx + 1) * frameCount),
      ];
      setCanvases(prev => prev.filter((_, i) => i !== idx));
      setFiles(nextFiles);
      // Deleting can drop the placed count back under the order quantity —
      // re-run the same check processSelectedFiles does so the shortfall
      // banner reappears/updates instead of only ever reflecting upload-time.
      const qtyVerdict = checkOrderQty(nextFiles.length, orderQty, surfaceStates.length);
      setQtyUnder(qtyVerdict.status === 'under' ? { uploaded: qtyVerdict.uploaded, needed: qtyVerdict.needed } : null);
    }
    setDeleteConfirm(null);
  };

  // Quick-download — the button that called this is commented out in the
  // JSX (see the two card-grid blocks below) rather than deleted, so this
  // stays too even though nothing currently calls it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleQuickDownload = async (idx: number, surfaceKey: string | null = null) => {
    const targetCanvases = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.canvases : canvases;
    const c = targetCanvases?.[idx];
    if (!c) return;

    // Always re-render with isExport — c.dataUrl is a preview artifact
    // (thumbnail renders carry frame outlines + "Frame N" labels at reduced
    // resolution; the modal's toFullResDataURL dumps the live editor canvas
    // with safe-zone dashes). Downloads must be chrome-free full resolution.
    let dataUrl: string | null = null;
    try {
      const layoutDef = surfaceKey
        ? surfaceStates.find(s => s.key === surfaceKey)?.def
        : layout;
      dataUrl = await renderCanvas(c, { isExport: true, includeMask: false, layoutOverride: layoutDef });
    } catch (err) {
      console.error('[quick-download] render failed:', err);
      return;
    }
    if (!dataUrl) return;

    // Detached on purpose: a link needn't be in the document to download.
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${layout?.id || 'canvas'}-${surfaceKey || 'canvas'}-${idx + 1}.png`;
    a.click();
  };

  useEffect(() => {
    if (canvases.length > 0 && activeCanvasIdx === null) {
      const idx = parseInt(new URLSearchParams(window.location.search).get('canvas') || '');
      if (!isNaN(idx) && idx >= 0 && idx < canvases.length) {
        setActiveCanvasIdx(idx);
        const c = canvases[idx];
        setEditingCanvas({
          ...c,
          frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })),
          overlays: c.overlays.map(o => ({ ...o })),
        });
      }
    }
  }, [canvases, activeCanvasIdx, setActiveCanvasIdx, setEditingCanvas]);

  const handleDrop = async (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.preventDefault();
    setDragOverIdx(null);
    if (isProcessing || heicConverting) return;

    const rawDroppedFiles = Array.from(e.dataTransfer.files);
    // A PDF dropped onto one specific surface card can only contribute as many
    // photos as that surface has print areas, so constrain the page picker to
    // that many rather than letting the customer pick more and having the
    // surfaceKey branch below silently discard the surplus (see the plan's
    // "single-select mode" note).
    const dropSurface = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey) : null;
    const droppedFiles = await expandPdfPages(rawDroppedFiles, {
      maxSelectable: surfaceKey ? surfaceFrameCount(dropSurface?.def) : null,
    });

    if (droppedFiles.length > 0) {
      // ── Handle external files ──────────────────────────────────────────────
      // Validate by extension (matches the backend). A plain
      // `type.startsWith('image/')` check would let .svg through —
      // image/svg+xml is an image MIME the renderer can't accept. HEIC/HEIF
      // are converted to JPEG first — drag-and-drop ignores <input accept>,
      // so an iPhone HEIC can arrive here directly (see heic-convert.ts).
      const heicPresent = droppedFiles.some(isHeicFile);
      if (heicPresent) setHeicConverting(true);
      const { accepted: okFiles, warning } = await convertAndPartitionFiles(droppedFiles, serverHeicConvert);
      if (heicPresent) setHeicConverting(false);
      setUnsupportedWarning(warning);
      if (okFiles.length === 0) return;

      if (surfaceKey) {
        // Multi-surface: update that specific surface's files — as many as the
        // surface has print areas, so a two-page spread takes two of the
        // dropped photos instead of repeating the first one across both.
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return;

        const s = surfaceStates[sIdx];
        const surfaceFiles = okFiles.slice(0, surfaceFrameCount(s.def));
        const surfaceLayout = {
          ...normalizedLayoutState?._raw,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        
        const newCanvases = await generateCanvasesForLayout(surfaceLayout, surfaceFiles, s.globalFitMode);
        setSurfaceStates(prev => prev.map((ps, pi) =>
          pi === sIdx ? { ...ps, files: surfaceFiles, canvases: newCanvases } : ps
        ));

        if (surfaceKey === activeSurfaceKey) {
          setFiles(surfaceFiles);
          setCanvases(newCanvases);
        }
      } else {
        // Single surface: update files array at index idx
        const frameCount = layout?.frames?.length || 1;
        const fileIdx = idx * frameCount; // Start file index for this canvas
        
        const nextFiles = [...files];
        // Replace/Insert files starting at the target index
        nextFiles.splice(fileIdx, okFiles.length, ...okFiles);
        setFiles(nextFiles);
      }
    } else {
      // ── Handle internal image swap ──────────────────────────────────────────
      const sourceIdx = e.dataTransfer.getData('canvasIdx');
      const sourceSurface = e.dataTransfer.getData('surfaceKey') || null;

      if (sourceIdx !== '') {
        await swapCards({ idx: parseInt(sourceIdx), surfaceKey: sourceSurface }, { idx, surfaceKey });
      }
    }
  };

  /**
   * Swap the photos of two cards. Shared by desktop drag-drop and the
   * touch-friendly tap-to-swap flow (Phase 3 — HTML5 drag events never fire
   * on touch, so phones had no way to swap at all).
   */
  const swapCards = async (
    source: { idx: number; surfaceKey: string | null },
    target: { idx: number; surfaceKey: string | null },
  ) => {
    if (source.idx === target.idx && source.surfaceKey === target.surfaceKey) return;

    if (target.surfaceKey || source.surfaceKey) {
      // Multi-surface swap
      const targetSurfaceIdx = surfaceStates.findIndex(s => s.key === target.surfaceKey);
      const sourceSurfaceIdx = surfaceStates.findIndex(s => s.key === source.surfaceKey);

      if (targetSurfaceIdx !== -1 && sourceSurfaceIdx !== -1) {
        // Swap the surfaces' whole photo sets, not just slot 0 — a spread
        // holds one photo per print area, and swapping only the first left
        // the second behind on the original card. Each side is clamped to its
        // OWN capacity: dropping a 2-page spread onto a 1-frame cover must not
        // hand that cover two photos, which would spill it into a second
        // canvas the surface has no page for.
        const targetCap = surfaceFrameCount(surfaceStates[targetSurfaceIdx].def);
        const sourceCap = surfaceFrameCount(surfaceStates[sourceSurfaceIdx].def);
        const targetFiles = surfaceStates[sourceSurfaceIdx].files.slice(0, targetCap);
        const sourceFiles = surfaceStates[targetSurfaceIdx].files.slice(0, sourceCap);

        // Regenerate canvases for both surfaces
        const updatedSurfaces = [...surfaceStates];

        // Update target
        const targetS = updatedSurfaces[targetSurfaceIdx];
        updatedSurfaces[targetSurfaceIdx] = {
          ...targetS,
          files: targetFiles,
          canvases: await generateCanvasesForLayout({ ...normalizedLayoutState?._raw, ...targetS.def }, targetFiles, targetS.globalFitMode)
        };

        // Update source
        const sourceS = updatedSurfaces[sourceSurfaceIdx];
        updatedSurfaces[sourceSurfaceIdx] = {
          ...sourceS,
          files: sourceFiles,
          canvases: await generateCanvasesForLayout({ ...normalizedLayoutState?._raw, ...sourceS.def }, sourceFiles, sourceS.globalFitMode)
        };

        setSurfaceStates(updatedSurfaces);

        // Sync active states
        const active = updatedSurfaces.find(s => s.key === activeSurfaceKey);
        if (active) {
          setFiles(active.files);
          setCanvases(active.canvases);
        }
      }
    } else {
      // Single surface: swap in files array
      const frameCount = layout?.frames?.length || 1;
      const targetFileIdx = target.idx * frameCount;
      const sourceFileIdx = source.idx * frameCount;

      const nextFiles = [...files];
      const temp = nextFiles[targetFileIdx];
      nextFiles[targetFileIdx] = nextFiles[sourceFileIdx];
      nextFiles[sourceFileIdx] = temp;
      setFiles(nextFiles);
    }
  };

  const handleDragOver = (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.preventDefault();
    if (dragOverIdx?.idx !== idx || dragOverIdx?.surfaceKey !== surfaceKey) {
      setDragOverIdx({ idx, surfaceKey });
    }
  };

  const handleDragStart = (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.dataTransfer.setData('canvasIdx', idx.toString());
    if (surfaceKey) e.dataTransfer.setData('surfaceKey', surfaceKey);
    e.dataTransfer.effectAllowed = 'move';
  };

  return {
    openEditor, closeEditor, handleQuickRotate, handleQuickToggleFit, handleQuickToggleBlur,
    handlePanStart, handlePanMove, handlePanEnd, handleCardClick, handleQuickDelete, confirmDelete,
    handleDrop, handleDragOver, handleDragStart,
  };
}
