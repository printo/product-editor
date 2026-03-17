'use client';

/**
 * /layout/[name]  —  Canvas editor page
 *
 * Works in two modes depending on what is present in the URL:
 *
 *  Internal (PIA session)
 *    URL : /layout/retro_polaroid_4.2x3.5
 *    Auth: useSession() → Bearer PIA token on every API call
 *    UI  : Header visible, full Download modal for admins, per-card download for everyone
 *
 *  External embed (short-lived API-key token)
 *    URL : /layout/retro_polaroid_4.2x3.5?token=<uuid>
 *    Auth: X-Embed-Token header → Next.js server-side proxy resolves real API key
 *    UI  : No header, "Submit Design" button → postMessage to parent window
 */

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Header } from '@/components/Header';
import {
  Upload, ChevronRight, Loader2, CheckCircle2, X,
  Download, Maximize2, Wand2, Layers, Archive, FileText,
  Plus, Minus, SendHorizonal, RotateCw, Undo2, Redo2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { createZipFromDataUrls, createMultiSurfaceZip, downloadBlob } from '@/lib/zip-utils';
import { normalizeLayout, filterSurfaces, isMultiSurface, getSurface, type NormalizedLayout, type SurfaceDefinition } from '@/lib/layout-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

type FitMode = 'contain' | 'cover';

interface FrameState {
  id: number;
  originalFile: File;
  processedUrl: string | null;
  offset: { x: number; y: number };
  scale: number;
  rotation: number; // 0, 90, 180, 270
  fitMode: FitMode;
  isRemovingBg: boolean;
  isDetectingProduct: boolean;
}

interface CanvasItem {
  id: number;
  frames: FrameState[];
  dataUrl: string | null;
}

interface ImpositionSettings {
  preset: 'a4' | 'a3' | '12x18' | '13x19' | 'custom';
  widthIn: number;
  heightIn: number;
  marginMm: number;
  gutterMm: number;
  orientation: 'portrait' | 'landscape';
}

interface PlacedItem {
  canvasIdx: number;
  x: number; y: number; w: number; h: number; rotated: boolean;
}

interface SheetLayout { items: PlacedItem[] }

interface SurfaceState {
  key: string;
  label: string;
  def: SurfaceDefinition;
  files: File[];
  canvases: CanvasItem[];
  globalFitMode: FitMode;
}

// ─── Imposition helpers ───────────────────────────────────────────────────────

const MM_TO_IN = 25.4;

const PRESET_DIMENSIONS: Record<string, { w: number; h: number }> = {
  a4: { w: 8.27, h: 11.69 },
  a3: { w: 11.69, h: 16.54 },
  '12x18': { w: 12, h: 18 },
  '13x19': { w: 13, h: 19 },
};

function resolveSheetSize(s: ImpositionSettings) {
  const base = s.preset === 'custom'
    ? { w: s.widthIn, h: s.heightIn }
    : PRESET_DIMENSIONS[s.preset] || PRESET_DIMENSIONS.a4;
  return s.orientation === 'landscape' ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
}

function computeImpositionLayout(
  settings: ImpositionSettings,
  itemSizes: { wIn: number; hIn: number }[],
): { sheets: SheetLayout[]; skippedCount: number } {
  const marginIn = settings.marginMm / MM_TO_IN;
  const gutterIn = settings.gutterMm / MM_TO_IN;
  const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(settings);
  const safeW = sheetWIn - marginIn * 2;
  const safeH = sheetHIn - marginIn * 2;
  if (safeW <= 0 || safeH <= 0) return { sheets: [], skippedCount: itemSizes.length };

  const sheets: SheetLayout[] = [{ items: [] }];
  let curX = marginIn, curY = marginIn, rowMaxH = 0, skippedCount = 0;

  for (let i = 0; i < itemSizes.length; i++) {
    let w = itemSizes[i].wIn, h = itemSizes[i].hIn, rotated = false;
    const fitsNormal = w <= safeW && h <= safeH;
    const fitsRotated = h <= safeW && w <= safeH;
    if (!fitsNormal && fitsRotated) { [w, h] = [h, w]; rotated = true; }
    else if (!fitsNormal && !fitsRotated) { skippedCount++; continue; }

    if (curX + w > marginIn + safeW) { curX = marginIn; curY += rowMaxH + gutterIn; rowMaxH = 0; }
    if (curY + h > marginIn + safeH) { sheets.push({ items: [] }); curX = marginIn; curY = marginIn; rowMaxH = 0; }

    sheets[sheets.length - 1].items.push({ canvasIdx: i, x: curX, y: curY, w, h, rotated });
    curX += w + gutterIn;
    rowMaxH = Math.max(rowMaxH, h);
  }
  return { sheets, skippedCount };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LayoutEditorPage() {
  const params = useParams();
  const layoutName = Array.isArray(params.name) ? params.name[0] : (params.name as string);
  const router = useRouter();
  const { data: session, status } = useSession();

  // ── Embed mode ──────────────────────────────────────────────────────────────
  // Present when the page is loaded inside an iframe with ?token=<uuid>.
  // The token is short-lived and exchanged server-side — the real API key never
  // reaches the browser.
  const embedToken = useMemo<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  }, []);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (embedToken) return { 'X-Embed-Token': embedToken };
    return { Authorization: `Bearer ${session?.accessToken ?? ''}` };
  }, [embedToken, session?.accessToken]);

  const apiBase = embedToken ? '/api/embed/proxy' : '/api';

  // Admin users see the full Download modal (HQ PNGs + Imposition).
  // Non-admin internal users see only the per-card download buttons.
  const isAdmin = !embedToken &&
    (session?.user?.role === 'admin' || (session as any)?.is_ops_team === true);

  // ── Core state ───────────────────────────────────────────────────────────────
  const [layout, setLayout] = useState<any | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [canvases, setCanvases] = useState<CanvasItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [globalFitMode, setGlobalFitMode] = useState<FitMode>('contain');
  const [activeCanvasIdx, setActiveCanvasIdx] = useState<number | null>(null);
  const [activeFrameIdx, setActiveFrameIdx] = useState(0);
  const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
  const [viewZoom, setViewZoom] = useState(0.8);
  const [isDownloading, setIsDownloading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [submitted, setSubmitted] = useState(false); // embed: after postMessage
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 7, gutterMm: 5, orientation: 'portrait',
  });

  const [dragState, setDragState] = useState<{
    canvasIdx: number; frameIdx: number;
    startX: number; startY: number; initialX: number; initialY: number;
    containerRatio: number;
    frameRect: { fx: number; fy: number; fw: number; fh: number };
    imgRect: { w: number; h: number };
    rotation: number;
    origImgRect: { w: number; h: number };
  } | null>(null);

  // ── Undo / Redo history for editor ──────────────────────────────────────────
  const undoStack = useRef<CanvasItem[]>([]);
  const redoStack = useRef<CanvasItem[]>([]);
  const [undoCount, setUndoCount] = useState(0); // triggers re-render for button state
  const [redoCount, setRedoCount] = useState(0);

  const cloneCanvas = useCallback((c: CanvasItem): CanvasItem => ({
    ...c,
    frames: c.frames.map(f => ({ ...f, offset: { ...f.offset }, originalFile: f.originalFile })),
  }), []);

  const lastPushTime = useRef(0);
  const pushUndo = useCallback((snapshot: CanvasItem, force = false) => {
    const now = Date.now();
    // Debounce rapid slider changes — only push if >300ms since last push or forced
    if (!force && now - lastPushTime.current < 300 && undoStack.current.length > 0) return;
    lastPushTime.current = now;
    undoStack.current.push(cloneCanvas(snapshot));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
    setRedoCount(0);
  }, [cloneCanvas]);

  const [activeDragFrameUrl, setActiveDragFrameUrl] = useState<string | null>(null);
  const tempOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafIdRef = useRef<number>(0);
  const previewImgRef = useRef<HTMLImageElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const fileUrlCache = useRef<Map<File, string>>(new Map());
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderGenRef = useRef(0);
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const previewImgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

  // ── Multi-surface state ──────────────────────────────────────────────────────
  const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>([]);
  const [activeSurfaceKey, setActiveSurfaceKey] = useState<string>('default');
  const [normalizedLayoutState, setNormalizedLayoutState] = useState<NormalizedLayout | null>(null);

  // ── Auth guard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === 'unauthenticated' && !embedToken) {
      router.push('/login');
    }
  }, [status, embedToken, router]);

  // ── Fetch layout by name ─────────────────────────────────────────────────────
  useEffect(() => {
    const canFetch = embedToken || session?.accessToken;
    if (!canFetch || !layoutName) return;

    const fetchLayout = async () => {
      setLayoutLoading(true);
      try {
        const res = await fetch(`${apiBase}/layouts/${layoutName}`, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        if (!res.ok) {
          setError(res.status === 404 ? 'Layout not found.' : 'Failed to load layout.');
          return;
        }
        const item = await res.json();

        // Normalize into multi-surface format
        let normalized = normalizeLayout(item);

        // Apply ?surfaces= filter if present
        const surfacesParam = new URLSearchParams(window.location.search).get('surfaces');
        if (surfacesParam) {
          normalized = filterSurfaces(normalized, surfacesParam.split(',').map(s => s.trim()));
        }

        setNormalizedLayoutState(normalized);

        // Initialize surface states
        const initSurfaces: SurfaceState[] = normalized.surfaces.map(s => ({
          key: s.key,
          label: s.label,
          def: s,
          files: [],
          canvases: [],
          globalFitMode: 'contain' as FitMode,
        }));
        setSurfaceStates(initSurfaces);

        // Set active surface to first
        const firstKey = normalized.surfaces[0]?.key || 'default';
        setActiveSurfaceKey(firstKey);

        // Backward-compatible layout state from the first surface
        const firstSurface = normalized.surfaces[0];
        setLayout({
          id: item.name,
          name: item.name,
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
        });
      } catch {
        setError('Failed to load layout.');
      } finally {
        setLayoutLoading(false);
      }
    };

    fetchLayout();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutName, embedToken, session?.accessToken]);

  // ── Image helpers ─────────────────────────────────────────────────────────────
  const getFileUrl = useCallback((file: File): string => {
    let url = fileUrlCache.current.get(file);
    if (!url) { url = URL.createObjectURL(file); fileUrlCache.current.set(file, url); }
    return url;
  }, []);

  const loadImage = useCallback(async (src: string): Promise<HTMLImageElement> => {
    const cached = imgCache.current.get(src);
    if (cached?.complete) return cached;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image load failed'));
      image.src = src;
    });
    imgCache.current.set(src, img);
    return img;
  }, []);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    };
  }, []);

  // ── Active surface helpers ──────────────────────────────────────────────────
  const activeSurface = surfaceStates.find(s => s.key === activeSurfaceKey) || surfaceStates[0];
  const activeLayout = activeSurface?.def ? {
    ...normalizedLayoutState?._raw,
    id: normalizedLayoutState?._raw?.name || layout?.id,
    name: normalizedLayoutState?.name || layout?.name,
    canvas: activeSurface.def.canvas,
    frames: activeSurface.def.frames,
    maskUrl: activeSurface.def.maskUrl,
    maskOnExport: activeSurface.def.maskOnExport,
    tags: normalizedLayoutState?.tags || layout?.tags || [],
  } : layout;

  // Sync active surface state → local state when switching surfaces
  useEffect(() => {
    if (!activeSurface) return;
    setFiles(activeSurface.files);
    setCanvases(activeSurface.canvases);
    setGlobalFitMode(activeSurface.globalFitMode);
  }, [activeSurfaceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save back to surfaceStates when files/canvases change
  useEffect(() => {
    if (!activeSurface || surfaceStates.length === 0) return;
    setSurfaceStates(prev => prev.map(s =>
      s.key === activeSurfaceKey ? { ...s, files, canvases, globalFitMode } : s
    ));
  }, [files, canvases, globalFitMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update backward-compatible layout state when switching surfaces
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
  }, [activeSurfaceKey, activeSurface?.def, normalizedLayoutState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canvas rendering ──────────────────────────────────────────────────────────
  const renderCanvas = useCallback(async (
    canvasItem: CanvasItem,
    excludeFrameIdx: number | null = null,
    isExport = false,
    includeMask = true,
  ) => {
    if (!layout) return '';
    const canvas = document.createElement('canvas');
    canvas.width = layout.canvas?.width || 1200;
    canvas.height = layout.canvas?.height || 1800;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const frames = layout.frames?.length > 0
      ? layout.frames
      : [{ x: 0, y: 0, width: canvas.width, height: canvas.height }];

    for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
      if (excludeFrameIdx !== null && frameIdx === excludeFrameIdx) continue;
      const frameSpec = frames[frameIdx];
      const frameState = canvasItem.frames[frameIdx];
      if (!frameState) continue;

      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvas.width : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvas.height : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvas.width : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvas.height : frameSpec.height;

      const imgSource = frameState.processedUrl || getFileUrl(frameState.originalFile);
      const img = await loadImage(imgSource);

      const rot = frameState.rotation || 0;
      // Compute effective bounding box of rotated image
      const rad = (rot * Math.PI) / 180;
      const sinA = Math.abs(Math.sin(rad));
      const cosA = Math.abs(Math.cos(rad));
      const effW = img.width * cosA + img.height * sinA;
      const effH = img.width * sinA + img.height * cosA;

      const baseScale = frameState.fitMode === 'cover'
        ? Math.max(fw / effW, fh / effH)
        : Math.min(fw / effW, fh / effH);
      const finalScale = baseScale * frameState.scale;
      const w = effW * finalScale;
      const h = effH * finalScale;
      const x = fx + (fw - w) / 2 + frameState.offset.x;
      const y = fy + (fh - h) / 2 + frameState.offset.y;

      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, fy, fw, fh);
      ctx.clip();
      if (rot !== 0) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.translate(cx, cy);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img, -img.width * finalScale / 2, -img.height * finalScale / 2, img.width * finalScale, img.height * finalScale);
      } else {
        ctx.drawImage(img, x, y, w, h);
      }
      ctx.restore();
    }

    const shouldIncludeMask = includeMask || (isExport && layout.maskOnExport);
    if (layout.maskUrl && shouldIncludeMask) {
      try {
        const maskImg = await loadImage(layout.maskUrl);
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
      } catch { /* ignore failed mask */ }
    }
    return canvas.toDataURL('image/png');
  }, [layout, getFileUrl, loadImage]);

  // ── Undo / Redo handlers (must be after renderCanvas) ─────────────────────────
  const handleUndo = useCallback(async () => {
    if (undoStack.current.length === 0 || !editingCanvas) return;
    redoStack.current.push(cloneCanvas(editingCanvas));
    const prev = undoStack.current.pop()!;
    const dataUrl = await renderCanvas(prev);
    setEditingCanvas({ ...prev, dataUrl });
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  }, [editingCanvas, renderCanvas, cloneCanvas]);

  const handleRedo = useCallback(async () => {
    if (redoStack.current.length === 0 || !editingCanvas) return;
    undoStack.current.push(cloneCanvas(editingCanvas));
    const next = redoStack.current.pop()!;
    const dataUrl = await renderCanvas(next);
    setEditingCanvas({ ...next, dataUrl });
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  }, [editingCanvas, renderCanvas, cloneCanvas]);

  // ── Generate canvases from files ──────────────────────────────────────────────
  const generateCanvases = useCallback(async () => {
    if (!layout || files.length === 0) return;
    setIsProcessing(true);
    setError(null);
    try {
      const frameCount = layout.frames?.length || 1;
      const canvasCount = Math.ceil(files.length / frameCount);
      const newCanvases: CanvasItem[] = [];

      for (let i = 0; i < canvasCount; i++) {
        const canvasFrames: FrameState[] = [];
        for (let f = 0; f < frameCount; f++) {
          const file = files[(i * frameCount + f) % files.length];
          if (file) canvasFrames.push({
            id: f, originalFile: file, processedUrl: null,
            offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: globalFitMode,
            isRemovingBg: false, isDetectingProduct: false,
          });
        }
        const item: CanvasItem = { id: i, frames: canvasFrames, dataUrl: null };
        item.dataUrl = await renderCanvas(item);
        newCanvases.push(item);
      }
      setCanvases(newCanvases);
    } catch { setError('Failed to process images'); }
    finally { setIsProcessing(false); }
  }, [layout, files, renderCanvas, globalFitMode]);

  useEffect(() => { if (layout && files.length > 0) generateCanvases(); }, [layout, files, generateCanvases]);

  // Re-render when global fit mode changes
  useEffect(() => {
    if (canvases.length === 0) return;
    let cancelled = false;
    (async () => {
      const updated = [];
      for (const c of canvases) {
        const dataUrl = await renderCanvas(c);
        if (cancelled) return;
        updated.push({ ...c, dataUrl });
      }
      setCanvases(updated);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFitMode]);

  // ── Editor open / close ───────────────────────────────────────────────────────
  const openEditor = (idx: number) => {
    const c = canvases[idx];
    if (!c) return;
    setActiveCanvasIdx(idx);
    const sp = new URLSearchParams(window.location.search);
    sp.set('canvas', idx.toString());
    window.history.pushState({}, '', '?' + sp.toString());
    undoStack.current = [];
    redoStack.current = [];
    setUndoCount(0);
    setRedoCount(0);
    setActiveFrameIdx(0);
    setEditingCanvas({ ...c, frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })) });
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

  // Fit canvas to workspace on open
  const fitToScreen = useCallback(() => {
    if (!workspaceRef.current || !layout?.canvas) return;
    const { clientWidth: cw, clientHeight: ch } = workspaceRef.current;
    const pad = 100;
    const stageW = 800;
    const stageH = stageW / ((layout.canvas.width || 1200) / (layout.canvas.height || 1800));
    setViewZoom(Math.min((cw - pad) / stageW, (ch - pad) / stageH, 1.2));
  }, [layout]);

  useEffect(() => {
    if (activeCanvasIdx === null) return;
    const t = setTimeout(fitToScreen, 50);
    window.addEventListener('resize', fitToScreen);
    return () => { clearTimeout(t); window.removeEventListener('resize', fitToScreen); };
  }, [activeCanvasIdx, fitToScreen]);

  // Auto-restore editor from URL on canvas ready
  useEffect(() => {
    if (canvases.length > 0 && activeCanvasIdx === null) {
      const idx = parseInt(new URLSearchParams(window.location.search).get('canvas') || '');
      if (!isNaN(idx) && idx >= 0 && idx < canvases.length) {
        setActiveCanvasIdx(idx);
        const c = canvases[idx];
        setEditingCanvas({ ...c, frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })) });
      }
    }
  }, [canvases, activeCanvasIdx]);

  // ── Keyboard shortcuts for undo/redo ─────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeCanvasIdx === null) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if (mod && e.key === 'z' && e.shiftKey) { e.preventDefault(); handleRedo(); }
      if (mod && e.key === 'y') { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeCanvasIdx, handleUndo, handleRedo]);

  // ── Editor save ───────────────────────────────────────────────────────────────
  const handleSaveChanges = async () => {
    if (activeCanvasIdx === null || !editingCanvas) return;
    if (renderTimeoutRef.current) { clearTimeout(renderTimeoutRef.current); renderTimeoutRef.current = null; }
    const freshDataUrl = await renderCanvas(editingCanvas);
    const updated = [...canvases];
    updated[activeCanvasIdx] = { ...editingCanvas, dataUrl: freshDataUrl };
    setCanvases(updated);
    closeEditor();
  };

  // ── AI background removal ─────────────────────────────────────────────────────
  const handleRemoveBackground = async (canvasIdx: number, frameIdx: number) => {
    if (!editingCanvas || editingCanvas.frames[frameIdx].isRemovingBg) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min for first model load

    setEditingCanvas(prev => prev ? {
      ...prev, frames: prev.frames.map((f, i) => i === frameIdx ? { ...f, isRemovingBg: true } : f),
    } : prev);

    try {
      const formData = new FormData();
      formData.append('image', editingCanvas.frames[frameIdx].originalFile);

      const res = await fetch(`${apiBase}/ai/remove-background`, {
        method: 'POST', headers: getAuthHeaders(), body: formData, signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const imageUrl = `${apiBase}/exports/${data.processed_image}`;
        let updatedCanvas: CanvasItem | null = null;
        setEditingCanvas(prev => {
          if (!prev) return prev;
          pushUndo(prev, true);
          updatedCanvas = {
            ...prev,
            frames: prev.frames.map((f, i) => i === frameIdx ? { ...f, processedUrl: imageUrl, isRemovingBg: false } : f),
          };
          return updatedCanvas;
        });
        if (updatedCanvas) {
          const dataUrl = await renderCanvas(updatedCanvas!);
          setEditingCanvas(p => p ? { ...p, dataUrl } : p);
        }
      } else { throw new Error('Server error'); }
    } catch (err: any) {
      clearTimeout(timeoutId);
      setEditingCanvas(prev => prev ? {
        ...prev, frames: prev.frames.map((f, i) => i === frameIdx ? { ...f, isRemovingBg: false } : f),
      } : prev);
      setError(err.name === 'AbortError' ? 'Background removal timed out. The AI model may still be loading — try again.' : 'Failed to remove background. Check if the backend is running.');
    }
  };

  // ── Transform update ──────────────────────────────────────────────────────────
  const handleUpdateTransform = (
    _canvasIdx: number, frameIdx: number,
    updates: Partial<{ scale: number; x: number; y: number; rotation: number }>,
  ) => {
    if (!editingCanvas) return;
    pushUndo(editingCanvas);
    const newFrames = editingCanvas.frames.map((f, i) => {
      if (i !== frameIdx) return f;
      const u = { ...f, offset: { ...f.offset } };
      if ('scale' in updates) u.scale = updates.scale!;
      if ('x' in updates) u.offset.x = Math.abs(updates.x!) < 8 ? 0 : updates.x!;
      if ('y' in updates) u.offset.y = Math.abs(updates.y!) < 8 ? 0 : updates.y!;
      if ('rotation' in updates) u.rotation = updates.rotation!;
      return u;
    });
    const finalized = { ...editingCanvas, frames: newFrames };
    setEditingCanvas(finalized);
    if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    const gen = ++renderGenRef.current;
    renderTimeoutRef.current = setTimeout(async () => {
      const dataUrl = await renderCanvas(finalized);
      if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
    }, 80);
  };

  // ── Drag ──────────────────────────────────────────────────────────────────────
  const handleDragStart = (e: React.MouseEvent, canvasIdx: number) => {
    if (activeCanvasIdx === null || !layout) return;
    const container = e.currentTarget.getBoundingClientRect();
    const canvasW = layout.canvas?.width || 1200;
    const canvasH = layout.canvas?.height || 1800;
    const containerRatio = canvasW / (container.width / viewZoom);
    const x = (e.clientX - container.left) / viewZoom * containerRatio;
    const y = (e.clientY - container.top) / viewZoom * containerRatio;

    let closestFrameIdx = 0, minDist = Infinity;
    layout.frames.forEach((f: any, i: number) => {
      const fw = f.width <= 1 ? f.width * canvasW : f.width;
      const fh = f.height <= 1 ? f.height * canvasH : f.height;
      const fx = f.width <= 1 ? f.x * canvasW : f.x;
      const fy = f.height <= 1 ? f.y * canvasH : f.y;
      const dist = Math.hypot(x - (fx + fw / 2), y - (fy + fh / 2));
      if (dist < minDist) { minDist = dist; closestFrameIdx = i; }
    });

    setActiveFrameIdx(closestFrameIdx);
    const frameSpec = layout.frames[closestFrameIdx];
    const frameState = (editingCanvas || canvases[canvasIdx]).frames[closestFrameIdx];
    const fx = frameSpec.width <= 1 ? frameSpec.x * canvasW : frameSpec.x;
    const fy = frameSpec.height <= 1 ? frameSpec.y * canvasH : frameSpec.y;
    const fw = frameSpec.width <= 1 ? frameSpec.width * canvasW : frameSpec.width;
    const fh = frameSpec.height <= 1 ? frameSpec.height * canvasH : frameSpec.height;

    const imgUrl = frameState.processedUrl || getFileUrl(frameState.originalFile);
    const imgSize = imgCache.current.get(imgUrl);
    if (imgSize) {
      const rot = frameState.rotation || 0;
      const rad = (rot * Math.PI) / 180;
      const sinA = Math.abs(Math.sin(rad));
      const cosA = Math.abs(Math.cos(rad));
      const eW = imgSize.width * cosA + imgSize.height * sinA;
      const eH = imgSize.width * sinA + imgSize.height * cosA;
      const baseScale = frameState.fitMode === 'cover'
        ? Math.max(fw / eW, fh / eH)
        : Math.min(fw / eW, fh / eH);
      setDragState({
        canvasIdx, frameIdx: closestFrameIdx,
        startX: e.clientX, startY: e.clientY,
        initialX: frameState.offset.x, initialY: frameState.offset.y,
        containerRatio, frameRect: { fx, fy, fw, fh },
        imgRect: { w: eW * baseScale * frameState.scale, h: eH * baseScale * frameState.scale },
        rotation: rot,
        origImgRect: { w: imgSize.width * baseScale * frameState.scale, h: imgSize.height * baseScale * frameState.scale },
      });
      setActiveDragFrameUrl(imgUrl);
    }
  };

  const handleDragMove = (e: React.MouseEvent) => {
    if (!dragState) return;
    const { clientX, clientY } = e;
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      const dx = (clientX - dragState.startX) / viewZoom * dragState.containerRatio;
      const dy = (clientY - dragState.startY) / viewZoom * dragState.containerRatio;
      tempOffsetRef.current = { x: dragState.initialX + dx, y: dragState.initialY + dy };
      const overlay = document.querySelector('.active-drag-overlay img') as HTMLImageElement;
      if (overlay) {
        const { frameRect: fr, imgRect: ir, containerRatio: cr } = dragState;
        const nx = tempOffsetRef.current.x, ny = tempOffsetRef.current.y;
        overlay.style.transform = `translate(${((fr.fw - ir.w) / 2 + nx) / cr}px, ${((fr.fh - ir.h) / 2 + ny) / cr}px)`;
      }
    });
  };

  const handleDragEnd = async () => {
    if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = 0; }
    if (!dragState || !editingCanvas) return;
    pushUndo(editingCanvas, true);
    const { frameIdx } = dragState;
    const newOffset = { ...tempOffsetRef.current };
    const newFrames = editingCanvas.frames.map((f, i) => {
      if (i !== frameIdx) return f;
      const u = { ...f, offset: { ...f.offset } };
      u.offset.x = Math.abs(newOffset.x) < 8 ? 0 : newOffset.x;
      u.offset.y = Math.abs(newOffset.y) < 8 ? 0 : newOffset.y;
      return u;
    });
    const finalized = { ...editingCanvas, frames: newFrames };
    if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    const dataUrl = await renderCanvas(finalized);
    finalized.dataUrl = dataUrl;
    setEditingCanvas(finalized);
    setDragState(null);
    setActiveDragFrameUrl(null);
  };

  // ── File change ───────────────────────────────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
    fileUrlCache.current.clear();
    imgCache.current.clear();
    setCanvases([]);
    setFiles(Array.from(e.target.files));
  };

  // ── Imposition preview ────────────────────────────────────────────────────────
  const impositionResult = useMemo(() => {
    if (canvases.length === 0 || !layout) return { sheets: [] as SheetLayout[], skippedCount: 0 };
    const dpi = 300;
    const itemSizes = canvases.map(() => ({
      wIn: (layout.canvas?.width || 1200) / dpi,
      hIn: (layout.canvas?.height || 1800) / dpi,
    }));
    return computeImpositionLayout(impositionSettings, itemSizes);
  }, [impositionSettings, canvases.length, layout]);

  useEffect(() => {
    const canvas = impositionPreviewRef.current;
    const { sheets } = impositionResult;
    if (!canvas || sheets.length === 0 || !showImpositionModal) return;
    const sheetIdx = Math.min(previewSheetIdx, sheets.length - 1);
    const sheet = sheets[sheetIdx];
    if (!sheet) return;
    const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
    const scale = Math.min(520 / sheetWIn, 340 / sheetHIn);
    const pw = Math.round(sheetWIn * scale), ph = Math.round(sheetHIn * scale);
    canvas.width = pw; canvas.height = ph;
    const ctx = canvas.getContext('2d')!;
    const mPx = (impositionSettings.marginMm / MM_TO_IN) * scale;
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, pw, ph);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(mPx, mPx, pw - 2 * mPx, ph - 2 * mPx);
    ctx.setLineDash([4, 3]); ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
    ctx.strokeRect(mPx, mPx, pw - 2 * mPx, ph - 2 * mPx);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5; ctx.strokeRect(0, 0, pw, ph);
    let aborted = false;
    const markLen = (5 / MM_TO_IN) * scale, offset = (2 / MM_TO_IN) * scale;
    const draw = async () => {
      for (const item of sheet.items) {
        if (aborted) return;
        const [px, py, iw, ih] = [item.x * scale, item.y * scale, item.w * scale, item.h * scale];
        ctx.fillStyle = '#eef2ff'; ctx.fillRect(px, py, iw, ih);
        ctx.strokeStyle = '#a5b4fc'; ctx.lineWidth = 1; ctx.strokeRect(px, py, iw, ih);
        const c = canvases[item.canvasIdx];
        if (c?.dataUrl) {
          try {
            let img = previewImgCache.current.get(c.dataUrl);
            if (!img || !img.complete) {
              img = await new Promise<HTMLImageElement>((res, rej) => {
                const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = c.dataUrl!;
              });
              previewImgCache.current.set(c.dataUrl, img);
            }
            if (aborted) return;
            if (item.rotated) {
              ctx.save(); ctx.translate(px + iw / 2, py + ih / 2); ctx.rotate(-Math.PI / 2);
              ctx.drawImage(img, -ih / 2, -iw / 2, ih, iw); ctx.restore();
            } else { ctx.drawImage(img, px, py, iw, ih); }
          } catch { /* skip */ }
        }
        ctx.strokeStyle = '#64748b'; ctx.lineWidth = 0.5;
        for (const [cx, cy, dx, dy] of [
          [px, py, -1, -1], [px + iw, py, 1, -1],
          [px, py + ih, -1, 1], [px + iw, py + ih, 1, 1],
        ] as [number, number, number, number][]) {
          ctx.beginPath(); ctx.moveTo(cx, cy + dy * offset); ctx.lineTo(cx, cy + dy * (offset + markLen)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + dx * offset, cy); ctx.lineTo(cx + dx * (offset + markLen), cy); ctx.stroke();
        }
      }
    };
    draw();
    return () => { aborted = true; };
  }, [impositionResult, previewSheetIdx, impositionSettings, canvases, showImpositionModal]);

  // ── Downloads ─────────────────────────────────────────────────────────────────
  const executeBatchDownload = async () => {
    setIsDownloading(true);
    try {
      if (surfaceStates.length > 1) {
        // Multi-surface: create zip with folder structure per surface
        const surfaceDataUrls: Record<string, string[]> = {};
        for (const s of surfaceStates) {
          surfaceDataUrls[s.key] = s.canvases
            .filter(c => c.dataUrl)
            .map(c => c.dataUrl!);
        }
        downloadBlob(await createMultiSurfaceZip(surfaceDataUrls, layout.id), `${layout.id}-surfaces.zip`);
      } else if (canvases.length === 1) {
        const a = document.createElement('a');
        a.href = canvases[0].dataUrl!;
        a.download = `${layout.id}-canvas.png`;
        a.click();
      } else {
        const images = canvases.map((c, i) => ({ name: `${layout.id}-canvas-${i + 1}.png`, url: c.dataUrl! }));
        downloadBlob(await createZipFromDataUrls(images), `${layout.id}-canvases.zip`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setIsDownloading(false);
      setShowDownloadModal(false);
    }
  };

  const executeImposition = async () => {
    setIsImposing(true);
    try {
      const dpi = 300;
      const canvasW = layout.canvas?.width || 1200;
      const canvasH = layout.canvas?.height || 1800;
      const { sheets: impositionSheets, skippedCount } = computeImpositionLayout(
        impositionSettings,
        canvases.map(() => ({ wIn: canvasW / dpi, hIn: canvasH / dpi })),
      );
      if (impositionSheets.length === 0) { setError('No canvases fit on sheet.'); return; }
      if (skippedCount > 0) setError(`${skippedCount} canvas(es) skipped — too large for sheet.`);

      const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
      const sheetW = Math.round(sheetWIn * dpi), sheetH = Math.round(sheetHIn * dpi);
      const canvasImages = await Promise.all(canvases.map(async c => loadImage(await renderCanvas(c, null, true))));

      const drawCropMarks = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
        const ms = Math.round((5 / MM_TO_IN) * dpi), off = Math.round((2 / MM_TO_IN) * dpi);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]] as [number,number,number,number][]) {
          ctx.beginPath(); ctx.moveTo(cx, cy + dy * off); ctx.lineTo(cx, cy + dy * (off + ms)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + dx * off, cy); ctx.lineTo(cx + dx * (off + ms), cy); ctx.stroke();
        }
      };

      const sheetBlobs: { name: string; blob: Blob }[] = [];
      for (let si = 0; si < impositionSheets.length; si++) {
        const sheetCanvas = document.createElement('canvas');
        sheetCanvas.width = sheetW; sheetCanvas.height = sheetH;
        const ctx = sheetCanvas.getContext('2d')!;
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, sheetW, sheetH);
        for (const item of impositionSheets[si].items) {
          const [px, py, pw, ph] = [
            Math.round(item.x * dpi), Math.round(item.y * dpi),
            Math.round(item.w * dpi), Math.round(item.h * dpi),
          ];
          const img = canvasImages[item.canvasIdx];
          if (item.rotated) {
            ctx.save(); ctx.translate(px + pw / 2, py + ph / 2); ctx.rotate(-Math.PI / 2);
            ctx.drawImage(img, -ph / 2, -pw / 2, ph, pw); ctx.restore();
          } else { ctx.drawImage(img, px, py, pw, ph); }
          drawCropMarks(ctx, px, py, pw, ph);
        }
        sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob: await new Promise<Blob>(res => sheetCanvas.toBlob(b => res(b!), 'image/png')) });
        sheetCanvas.width = 0; sheetCanvas.height = 0;
      }

      if (sheetBlobs.length === 1) {
        downloadBlob(sheetBlobs[0].blob, sheetBlobs[0].name);
      } else {
        const zip = sheetBlobs.map(sb => ({ name: sb.name, url: URL.createObjectURL(sb.blob) }));
        downloadBlob(await createZipFromDataUrls(zip), 'imposition-sheets.zip');
        zip.forEach(z => URL.revokeObjectURL(z.url));
      }
    } catch { setError('Imposition failed. Please try again.'); }
    finally { setIsImposing(false); setShowImpositionModal(false); }
  };

  // ── Embed: submit design via postMessage ──────────────────────────────────────
  const handleSubmitDesign = async () => {
    if (canvases.length === 0) return;
    setIsDownloading(true);
    try {
      // Re-render at full quality before sending
      const rendered = await Promise.all(canvases.map(c => renderCanvas(c, null, true)));

      // Build multi-surface payload if applicable
      const surfacesPayload: Record<string, { index: number; dataUrl: string }[]> = {};
      if (surfaceStates.length > 1) {
        for (const s of surfaceStates) {
          surfacesPayload[s.key] = s.canvases.map((c, i) => ({ index: i, dataUrl: c.dataUrl || '' }));
        }
      }

      window.parent.postMessage({
        type: 'PRODUCT_EDITOR_COMPLETE',
        layoutName: layout?.id,
        // Multi-surface data
        ...(surfaceStates.length > 1 ? { surfaces: surfacesPayload } : {}),
        // Backward-compatible: active surface canvases
        canvases: rendered.map((dataUrl, i) => ({ index: i, dataUrl })),
      }, '*');
      setSubmitted(true);
    } catch { setError('Failed to prepare design. Please try again.'); }
    finally { setIsDownloading(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  if (status === 'loading' && !embedToken) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-8 h-8 text-indigo-600 animate-spin" /></div>;
  }

  if (layoutLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-8 h-8 text-indigo-600 animate-spin" /></div>;
  }

  if (!layout) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <p className="text-slate-600 font-medium">Layout not found.</p>
          {!embedToken && <button onClick={() => router.push('/dashboard')} className="mt-4 text-sm text-indigo-600 underline">Back to templates</button>}
        </div>
      </div>
    );
  }

  const hasCanvasParam = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('canvas');

  return (
    <div className="min-h-screen bg-slate-50/50 flex flex-col">
      {!embedToken && <Header />}

      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-[200000] max-w-sm bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Embed: post-submit confirmation */}
      {submitted && (
        <div className="fixed inset-0 z-[300000] flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="text-center p-10">
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900">Design Submitted</h2>
            <p className="text-slate-500 mt-1 text-sm">Your design has been sent for processing.</p>
          </div>
        </div>
      )}

      <main className="w-full px-8 py-8 flex-1">
        <div className="max-w-6xl mx-auto space-y-8">

          {/* Header row */}
          <div className="flex flex-col lg:flex-row items-stretch justify-between gap-8 mb-10">
            <div className="flex-1 flex flex-col justify-center">
              {!embedToken && (
                <button onClick={() => router.push('/dashboard')} className="text-xs text-slate-400 font-bold hover:text-indigo-600 flex items-center mb-4 uppercase tracking-widest transition-colors">
                  ← Back to Templates
                </button>
              )}
              <div className="space-y-4">
                <h1 className="text-3xl font-black text-slate-900 tracking-tight leading-none uppercase">{layout.name}</h1>
                {layout.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {layout.tags.map((t: string) => (
                      <span key={t} className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-[9px] rounded-md font-black uppercase tracking-widest border border-indigo-100/50">{t}</span>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-bold text-slate-400">
                  <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-lg text-slate-600">
                    <Layers className="w-3 h-3" />
                    <span>{layout.frames.length} Frame{layout.frames.length !== 1 && 's'}</span>
                  </div>
                  {layout.dimensions && <span className="font-mono text-[10px] text-slate-400">{layout.dimensions}</span>}
                </div>
              </div>
            </div>

            {/* Upload zone */}
            <div className="w-full lg:w-[420px]">
              <div className={clsx(
                'relative h-full flex flex-col items-center justify-center border-2 border-dashed rounded-[2rem] p-6 lg:p-8 transition-all group overflow-hidden',
                files.length > 0 ? 'border-emerald-100 bg-emerald-50/20' :
                  hasCanvasParam ? 'border-amber-200 bg-amber-50/50' :
                    'border-slate-200 hover:border-indigo-400 hover:bg-slate-50 cursor-pointer',
              )}>
                <input type="file" multiple onChange={handleFileChange} accept="image/*"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="flex items-center gap-5">
                  <div className={clsx('w-14 h-14 rounded-2xl shadow-sm flex items-center justify-center transition-transform group-hover:scale-110',
                    files.length > 0 ? 'bg-emerald-500 text-white' :
                      hasCanvasParam ? 'bg-amber-500 text-white' : 'bg-white text-indigo-600')}>
                    <Upload className="w-6 h-6" />
                  </div>
                  <div className="text-left">
                    {files.length > 0 ? (
                      <>
                        <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">Images Loaded</h2>
                        <div className="flex items-center gap-1.5 text-emerald-600 text-xs font-bold mt-0.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />{files.length} photos selected
                        </div>
                      </>
                    ) : (
                      <>
                        <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">
                          {hasCanvasParam ? 'Restore Session' : 'Upload Photos'}
                        </h2>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1 group-hover:text-indigo-500 transition-colors">
                          {hasCanvasParam ? 'Re-upload to continue editing' : 'Click or drag here'}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Surface tab bar — only for multi-surface layouts */}
          {surfaceStates.length > 1 && (
            <div className="flex items-center gap-2 mb-6">
              {surfaceStates.map(s => (
                <button
                  key={s.key}
                  onClick={() => setActiveSurfaceKey(s.key)}
                  className={`px-4 py-2 text-sm font-bold rounded-xl transition-all ${
                    activeSurfaceKey === s.key
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* Canvas grid */}
          {canvases.length > 0 && (
            <section className="space-y-6 pt-8 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-bold text-slate-900">Generated Canvases</h2>
                  <span className="px-2.5 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded-full">{canvases.length}</span>
                </div>
                <div className="flex items-center gap-3">
                  {isProcessing && <div className="flex items-center gap-2 text-xs text-slate-500 animate-pulse"><Loader2 className="w-3 h-3 animate-spin" /> Updating...</div>}

                  {/* Fit / Cover toggle */}
                  <div className="flex items-center bg-slate-100 rounded-xl p-0.5">
                    {(['contain', 'cover'] as FitMode[]).map(mode => (
                      <button key={mode}
                        onClick={() => {
                          setGlobalFitMode(mode);
                          setCanvases(prev => prev.map(c => ({ ...c, frames: c.frames.map(f => ({ ...f, fitMode: mode })) })));
                        }}
                        className={clsx('px-3 py-1.5 text-xs font-bold rounded-lg transition-all capitalize',
                          globalFitMode === mode ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700')}
                      >{mode === 'contain' ? 'Fit' : 'Cover'}</button>
                    ))}
                  </div>

                  {/* Action button — differs by mode and role */}
                  {embedToken ? (
                    <button onClick={handleSubmitDesign} disabled={isDownloading}
                      className="flex items-center gap-2 text-sm font-bold text-white bg-indigo-600 px-5 py-2.5 rounded-xl hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200 disabled:opacity-60">
                      {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <SendHorizonal className="w-4 h-4" />}
                      Submit Design
                    </button>
                  ) : isAdmin ? (
                    <button onClick={() => setShowDownloadModal(true)}
                      className="flex items-center gap-2 text-sm font-bold text-white bg-slate-900 px-5 py-2.5 rounded-xl hover:bg-slate-800 transition-all shadow-lg shadow-slate-200">
                      <Archive className="w-4 h-4" /> Download Results
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {canvases.map((canvas, idx) => (
                  <div key={idx} className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-indigo-200 transition-all group cursor-zoom-in"
                    onClick={() => openEditor(idx)}>
                    <div className="relative rounded-t-2xl overflow-hidden bg-slate-50 border-b"
                      style={{ aspectRatio: `${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}` }}>
                      {canvas.dataUrl && <img src={canvas.dataUrl} loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-fill" alt={`Canvas ${idx + 1}`} />}
                      {layout.maskUrl && <img src={layout.maskUrl} className="absolute inset-0 w-full h-full object-fill pointer-events-none z-10" alt="Mask" />}
                      <div className="absolute inset-0 z-20 bg-slate-900/0 group-hover:bg-slate-900/40 transition-all flex items-center justify-center">
                        <Maximize2 className="w-8 h-8 text-white scale-50 opacity-0 group-hover:scale-100 group-hover:opacity-100 transition-all duration-300" />
                      </div>
                    </div>
                    <div className="p-3 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-500 uppercase tracking-tight">Canvas {idx + 1}</span>
                      <div className="flex items-center gap-2">
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          const updated = { ...canvas, frames: canvas.frames.map(f => ({ ...f, rotation: ((f.rotation || 0) + 90) % 360 })) };
                          const dataUrl = await renderCanvas(updated);
                          const arr = [...canvases]; arr[idx] = { ...updated, dataUrl }; setCanvases(arr);
                        }} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all" title="Rotate 90°">
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          const newMode: FitMode = (canvas.frames[0]?.fitMode || 'contain') === 'contain' ? 'cover' : 'contain';
                          const updated = { ...canvas, frames: canvas.frames.map(f => ({ ...f, fitMode: newMode })) };
                          const dataUrl = await renderCanvas(updated);
                          const arr = [...canvases]; arr[idx] = { ...updated, dataUrl }; setCanvases(arr);
                        }} className={clsx('px-2 py-1 text-[10px] font-bold rounded-md transition-all border',
                          (canvas.frames[0]?.fitMode || 'contain') === 'contain'
                            ? 'bg-indigo-50 text-indigo-600 border-indigo-200'
                            : 'bg-amber-50 text-amber-600 border-amber-200')}>
                          {(canvas.frames[0]?.fitMode || 'contain') === 'contain' ? 'Fit' : 'Cover'}
                        </button>
                        {/* Individual download — visible to all non-embed users */}
                        {!embedToken && (
                          <button onClick={(e) => {
                            e.stopPropagation();
                            const a = document.createElement('a');
                            a.href = canvas.dataUrl!; a.download = `${layout.id}-canvas-${idx + 1}.png`; a.click();
                          }} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all">
                            <Download className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Download modal — admin only */}
          {showDownloadModal && isAdmin && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
              <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setShowDownloadModal(false)} />
              <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl p-8 animate-in zoom-in-95">
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Archive className="w-8 h-8" />
                  </div>
                  <h3 className="text-2xl font-bold text-slate-900">Prepare Your Download</h3>
                  <p className="text-slate-500 mt-2">How would you like to process your {canvases.length} canvas{canvases.length !== 1 ? 'es' : ''}?</p>
                </div>
                <div className="grid gap-4">
                  <button onClick={executeBatchDownload} disabled={isDownloading}
                    className="flex items-center gap-4 p-5 rounded-2xl border-2 border-slate-100 hover:border-indigo-500 hover:bg-indigo-50/50 transition-all text-left group disabled:opacity-60">
                    <div className="w-12 h-12 bg-white rounded-xl shadow-sm border flex items-center justify-center group-hover:bg-indigo-500 group-hover:text-white transition-colors">
                      {isDownloading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Archive className="w-6 h-6" />}
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">Download HQ PNGs</p>
                      <p className="text-xs text-slate-500 mt-0.5">Export all canvases as high-quality PNG files in a ZIP archive.</p>
                    </div>
                  </button>
                  <button onClick={() => { setShowDownloadModal(false); setShowImpositionModal(true); }}
                    className="flex items-center gap-4 p-5 rounded-2xl border-2 border-slate-100 hover:border-emerald-500 hover:bg-emerald-50/50 transition-all text-left group">
                    <div className="w-12 h-12 bg-white rounded-xl shadow-sm border flex items-center justify-center group-hover:bg-emerald-500 group-hover:text-white transition-colors">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">Prepare Imposition</p>
                      <p className="text-xs text-slate-500 mt-0.5">Arrange canvases on print sheets with crop marks and margins.</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Imposition modal — admin only */}
          {showImpositionModal && isAdmin && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
              <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setShowImpositionModal(false)} />
              <div className="relative w-full max-w-xl bg-white rounded-3xl shadow-2xl p-8 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-slate-900">Print Imposition</h3>
                  <button onClick={() => setShowImpositionModal(false)} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full"><X className="w-5 h-5" /></button>
                </div>

                {/* Sheet presets */}
                <div className="space-y-4">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">Sheet Size</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['a4', 'a3', '12x18', '13x19', 'custom'] as const).map(p => (
                      <button key={p} onClick={() => setImpositionSettings(s => ({ ...s, preset: p }))}
                        className={clsx('py-2 text-xs font-bold rounded-xl border transition-all uppercase',
                          impositionSettings.preset === p ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:border-indigo-300')}>
                        {p}
                      </button>
                    ))}
                  </div>

                  {impositionSettings.preset === 'custom' && (
                    <div className="grid grid-cols-2 gap-3">
                      {(['widthIn', 'heightIn'] as const).map(k => (
                        <div key={k}>
                          <label className="text-[10px] text-slate-400 uppercase font-bold">{k === 'widthIn' ? 'Width (in)' : 'Height (in)'}</label>
                          <input type="number" step="0.1" min="1" value={impositionSettings[k]}
                            onChange={e => setImpositionSettings(s => ({ ...s, [k]: parseFloat(e.target.value) || 1 }))}
                            className="w-full mt-1 px-3 py-2 border rounded-xl text-sm" />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase font-bold">Orientation</label>
                      <div className="flex mt-1 bg-slate-100 rounded-xl p-0.5">
                        {(['portrait', 'landscape'] as const).map(o => (
                          <button key={o} onClick={() => setImpositionSettings(s => ({ ...s, orientation: o }))}
                            className={clsx('flex-1 py-1.5 text-xs font-bold rounded-lg transition-all capitalize',
                              impositionSettings.orientation === o ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500')}>
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase font-bold">Margin (mm)</label>
                      <input type="number" min="0" max="30" value={impositionSettings.marginMm}
                        onChange={e => setImpositionSettings(s => ({ ...s, marginMm: parseFloat(e.target.value) || 0 }))}
                        className="w-full mt-1 px-3 py-2 border rounded-xl text-sm" />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase font-bold">Gutter (mm)</label>
                      <input type="number" min="0" max="30" value={impositionSettings.gutterMm}
                        onChange={e => setImpositionSettings(s => ({ ...s, gutterMm: parseFloat(e.target.value) || 0 }))}
                        className="w-full mt-1 px-3 py-2 border rounded-xl text-sm" />
                    </div>
                  </div>

                  {/* Preview */}
                  {canvases.length > 0 && impositionResult.sheets.length > 0 && (
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-black uppercase tracking-widest text-slate-400">Preview</label>
                        {impositionResult.sheets.length > 1 && (
                          <div className="flex items-center gap-2">
                            <button onClick={() => setPreviewSheetIdx(i => Math.max(0, i - 1))} disabled={previewSheetIdx === 0} className="p-1 hover:bg-slate-100 rounded disabled:opacity-30">
                              <ChevronRight className="w-4 h-4 rotate-180" />
                            </button>
                            <span className="text-xs font-bold text-slate-500">Sheet {Math.min(previewSheetIdx, impositionResult.sheets.length - 1) + 1} of {impositionResult.sheets.length}</span>
                            <button onClick={() => setPreviewSheetIdx(i => Math.min(impositionResult.sheets.length - 1, i + 1))} disabled={previewSheetIdx >= impositionResult.sheets.length - 1} className="p-1 hover:bg-slate-100 rounded disabled:opacity-30">
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="flex justify-center p-4 bg-slate-50 rounded-2xl border">
                        <canvas ref={impositionPreviewRef} className="border border-slate-200 shadow-sm rounded" style={{ maxWidth: '100%', height: 'auto' }} />
                      </div>
                    </div>
                  )}

                  <div className="mt-6 flex gap-4">
                    <button onClick={() => setShowImpositionModal(false)} disabled={isImposing} className="flex-1 py-4 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-2xl transition-all">Cancel</button>
                    <button onClick={executeImposition} disabled={isImposing}
                      className="flex-[2] py-4 bg-emerald-600 text-white rounded-2xl font-bold hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-100 flex items-center justify-center gap-2">
                      {isImposing ? <><Loader2 className="w-5 h-5 animate-spin" />Imposing Batch...</> : <><FileText className="w-5 h-5" />Generate Print Sheet</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Canvas Editor Modal */}
      {activeCanvasIdx !== null && editingCanvas && (
        <div className="fixed inset-0 z-[100000] bg-white flex overflow-hidden animate-in fade-in duration-300">
          {/* Workspace */}
          <div ref={workspaceRef}
            className="flex-1 bg-slate-50 flex flex-col items-center justify-center overflow-auto cursor-move select-none p-12 relative"
            onMouseMove={handleDragMove} onMouseUp={handleDragEnd} onMouseLeave={handleDragEnd}>

            {/* Floating close — top right of workspace */}
            <button onClick={closeEditor}
              className="absolute top-4 right-4 z-30 p-2.5 bg-white/90 backdrop-blur-md border border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-white rounded-full shadow-lg transition-all">
              <X className="w-5 h-5" />
            </button>

            {/* Floating undo/redo + zoom — bottom right, stacked */}
            <div className="absolute bottom-8 right-8 z-20 flex flex-col items-end gap-2">
              <div className="flex items-center gap-1 bg-white/90 backdrop-blur-md border border-slate-200 p-1 rounded-xl shadow-lg">
                <button onClick={handleUndo} disabled={undoCount === 0}
                  className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all disabled:opacity-20" title="Undo (Ctrl+Z)">
                  <Undo2 className="w-4 h-4" />
                </button>
                <button onClick={handleRedo} disabled={redoCount === 0}
                  className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all disabled:opacity-20" title="Redo (Ctrl+Shift+Z)">
                  <Redo2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-1 bg-white/90 backdrop-blur-md border border-slate-200 p-1.5 rounded-2xl shadow-xl hover:bg-white transition-all">
                <button onClick={() => setViewZoom(p => Math.max(0.1, p - 0.1))} className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"><Minus className="w-5 h-5" /></button>
                <button onClick={() => setViewZoom(0.85)} className="min-w-[64px] text-[10px] font-black text-slate-400 uppercase tracking-tighter hover:text-indigo-600 transition-colors">
                  {(viewZoom * 100).toFixed(0)}%
                </button>
                <button onClick={() => setViewZoom(p => Math.min(2, p + 0.1))} className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"><Plus className="w-5 h-5" /></button>
              </div>
            </div>

            <div className="relative shadow-2xl bg-white animate-in zoom-in-95 duration-500"
              style={{
                width: '800px',
                height: `${800 / ((layout.canvas?.width || 1200) / (layout.canvas?.height || 1800))}px`,
                transform: `scale(${viewZoom})`,
                transformOrigin: 'center center',
                transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                flexShrink: 0,
              }}
              onMouseDown={e => handleDragStart(e, activeCanvasIdx!)}>
              {editingCanvas.dataUrl && (
                <div className="relative w-full h-full overflow-hidden">
                  <img ref={previewImgRef} src={editingCanvas.dataUrl} className="w-full h-full object-fill pointer-events-none transition-none shadow-sm" alt="Editor Preview" />
                  {layout.maskUrl && <img src={layout.maskUrl} className="absolute inset-0 w-full h-full object-fill pointer-events-none z-[100]" alt="Mask" />}
                  {dragState && (
                    <div style={{
                      position: 'absolute',
                      left: dragState.frameRect.fx / dragState.containerRatio, top: dragState.frameRect.fy / dragState.containerRatio,
                      width: dragState.frameRect.fw / dragState.containerRatio, height: dragState.frameRect.fh / dragState.containerRatio,
                      backgroundColor: 'white', zIndex: 40, pointerEvents: 'none',
                    }} />
                  )}
                  {dragState && activeDragFrameUrl && (() => {
                    const { frameRect: fr, imgRect: ir, containerRatio: cr, rotation: rot, origImgRect: oir } = dragState;
                    return (
                      <div className="active-drag-overlay" style={{
                        position: 'absolute', left: fr.fx / cr, top: fr.fy / cr,
                        width: fr.fw / cr, height: fr.fh / cr, overflow: 'hidden',
                        pointerEvents: 'none', zIndex: 50, willChange: 'transform',
                      }}>
                        <img src={activeDragFrameUrl} className="transition-none" style={{
                          position: 'absolute', width: oir.w / cr, height: oir.h / cr, pointerEvents: 'none',
                          left: ((fr.fw - ir.w) / 2 + tempOffsetRef.current.x) / cr + (ir.w - oir.w) / 2 / cr,
                          top: ((fr.fh - ir.h) / 2 + tempOffsetRef.current.y) / cr + (ir.h - oir.h) / 2 / cr,
                          transform: rot ? `rotate(${rot}deg)` : undefined,
                        }} alt="" />
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* Right Sidebar */}
          <div className="w-80 border-l bg-slate-50 flex flex-col overflow-hidden">
            <div className="px-3 py-2.5 border-b bg-white flex items-center gap-2">
              <h3 className="text-xs font-bold text-slate-900 mr-auto">Canvas Editor</h3>
              <button disabled={activeCanvasIdx === 0} onClick={() => openEditor(activeCanvasIdx! - 1)}
                className="p-1 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all rounded">
                <ChevronRight className="w-3.5 h-3.5 rotate-180" />
              </button>
              <span className="text-[10px] font-bold text-slate-400 tabular-nums">{activeCanvasIdx + 1}/{canvases.length}</span>
              <button disabled={activeCanvasIdx === canvases.length - 1} onClick={() => openEditor(activeCanvasIdx! + 1)}
                className="p-1 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all rounded">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Frame selector tabs */}
            {editingCanvas.frames.length > 1 && (
              <div className="px-3 py-2 border-b bg-white flex items-center gap-1.5 overflow-x-auto">
                {editingCanvas.frames.map((_, fIdx) => (
                  <button key={fIdx} onClick={() => setActiveFrameIdx(fIdx)}
                    className={clsx('px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all whitespace-nowrap flex items-center gap-1.5',
                      activeFrameIdx === fIdx
                        ? 'bg-slate-900 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200')}>
                    <Layers className="w-3 h-3" /> Frame {fIdx + 1}
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {(() => {
                const fIdx = editingCanvas.frames.length === 1 ? 0 : activeFrameIdx;
                const frame = editingCanvas.frames[fIdx];
                if (!frame) return null;
                return (
                  <>
                    {editingCanvas.frames.length === 1 && (
                      <h4 className="text-xs font-bold text-slate-900 flex items-center gap-2">
                        <Layers className="w-3.5 h-3.5" /> Frame 1
                      </h4>
                    )}
                    <div className="space-y-3">
                      <p className="text-xs font-bold text-slate-700">AI Processing</p>
                      <button onClick={() => handleRemoveBackground(activeCanvasIdx!, fIdx)}
                        disabled={frame.isRemovingBg || !!frame.processedUrl}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 hover:border-indigo-400 hover:text-indigo-600 transition-all disabled:opacity-50">
                        {frame.isRemovingBg ? <><Loader2 className="w-3 h-3 animate-spin" /><span className="animate-pulse">Processing AI...</span></> : <><Wand2 className="w-3 h-3" />{frame.processedUrl ? 'Background Removed' : 'Remove Background'}</>}
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold text-slate-700">Image Fit</p>
                      <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
                        {(['contain', 'cover'] as FitMode[]).map(mode => (
                          <button key={mode}
                            onClick={() => {
                              pushUndo(editingCanvas, true);
                              const newFrames = editingCanvas.frames.map((f, i) => i === fIdx ? { ...f, fitMode: mode } : f);
                              const updated = { ...editingCanvas, frames: newFrames };
                              setEditingCanvas(updated);
                              if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
                              const gen = ++renderGenRef.current;
                              renderTimeoutRef.current = setTimeout(async () => {
                                const dataUrl = await renderCanvas(updated);
                                if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
                              }, 80);
                            }}
                            className={clsx('px-3 py-1 text-[10px] font-bold rounded-md transition-all text-center',
                              frame.fitMode === mode ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
                            {mode === 'contain' ? 'Fit' : 'Cover'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-3 pt-2">
                      <p className="text-xs font-bold text-slate-700">Rotation</p>
                      <div className="flex items-center gap-1.5">
                        {[0, 90, 180, 270].map(deg => (
                          <button key={deg}
                            onClick={() => handleUpdateTransform(activeCanvasIdx!, fIdx, { rotation: deg })}
                            className={clsx('flex-1 px-1.5 py-1 text-[10px] font-bold rounded-md transition-all text-center',
                              (frame.rotation || 0) === deg ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:text-slate-700')}>
                            {deg}°
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="range" min="0" max="359" step="1" value={frame.rotation || 0}
                          onChange={e => handleUpdateTransform(activeCanvasIdx!, fIdx, { rotation: parseInt(e.target.value) })}
                          className="flex-1 accent-indigo-600" />
                        <input type="number" min="0" max="359" value={frame.rotation || 0}
                          onChange={e => {
                            let v = parseInt(e.target.value) || 0;
                            v = ((v % 360) + 360) % 360;
                            handleUpdateTransform(activeCanvasIdx!, fIdx, { rotation: v });
                          }}
                          className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-slate-200 rounded-lg" />
                      </div>
                    </div>
                    <div className="space-y-2 pt-2">
                      <p className="text-xs font-bold text-slate-700">Zoom</p>
                      <div className="flex items-center gap-2">
                        <input type="range" min="10" max="300" step="10" value={Math.round(frame.scale * 100)}
                          onChange={e => handleUpdateTransform(activeCanvasIdx!, fIdx, { scale: parseInt(e.target.value) / 100 })}
                          className="flex-1 accent-indigo-600" />
                        <input type="number" min="10" max="300" value={Math.round(frame.scale * 100)}
                          onChange={e => {
                            const v = Math.max(10, Math.min(300, parseInt(e.target.value) || 100));
                            handleUpdateTransform(activeCanvasIdx!, fIdx, { scale: v / 100 });
                          }}
                          className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-slate-200 rounded-lg" />
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="p-4 border-t bg-white">
              <button onClick={handleSaveChanges}
                className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-all shadow-lg flex items-center justify-center gap-2 active:scale-[0.98]">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
