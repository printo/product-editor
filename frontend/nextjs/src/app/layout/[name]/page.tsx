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
  Download, Maximize2, Layers, Archive, FileText,
  SendHorizonal, RotateCw, Palette,
} from 'lucide-react';
import { clsx } from 'clsx';
import { createZipFromDataUrls, createMultiSurfaceZip, downloadBlob } from '@/lib/zip-utils';
import { normalizeLayout, filterSurfaces, type NormalizedLayout } from '@/lib/layout-utils';
import type { FitMode, FrameState, CanvasItem, ImpositionSettings, SheetLayout, SurfaceState } from './types';
import { renderCanvas as renderCanvasCore } from './fabric-renderer';
import { Canvas as FabricCanvas, FabricImage, Line } from 'fabric';
import { MM_TO_IN, computeImpositionLayout, resolveSheetSize } from './imposition';
import { CanvasEditorModal } from './CanvasEditorModal';



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
  const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [submitted, setSubmitted] = useState(false); // embed: after postMessage
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 7, gutterMm: 5, orientation: 'portrait',
  });

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const fileUrlCache = useRef<Map<File, string>>(new Map());
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const skipNextGenerateRef = useRef(false);
  const previewImgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

  // ── Multi-surface state ──────────────────────────────────────────────────────
  const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>([]);
  const [activeSurfaceKey, setActiveSurfaceKey] = useState<string>('default');
  const [normalizedLayoutState, setNormalizedLayoutState] = useState<NormalizedLayout | null>(null);

  // ── Google Fonts (loaded from backend /api/fonts) ──────────────────────────
  const [selectedFonts, setSelectedFonts] = useState<string[]>(['sans-serif', 'serif', 'monospace']);
  const [fontsLoaded, setFontsLoaded] = useState<Set<string>>(new Set());


  // ── Auth guard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === 'unauthenticated' && !embedToken) {
      router.push('/login');
    }
  }, [status, embedToken, router]);

  // ── Fetch enabled fonts from backend ────────────────────────────────────────
  useEffect(() => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (embedToken) {
      headers['X-Embed-Token'] = embedToken;
    } else if (session?.accessToken) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    } else {
      return; // wait for auth
    }
    const fontsUrl = embedToken ? '/api/embed/proxy/fonts' : '/api/fonts';
    fetch(fontsUrl, { headers })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.fonts) setSelectedFonts(data.fonts); })
      .catch(() => {});
  }, [session?.accessToken, embedToken]);

  // Load a Google Font into the document
  const loadGoogleFont = useCallback((fontName: string) => {
    if (fontsLoaded.has(fontName) || ['sans-serif', 'serif', 'monospace', 'cursive'].includes(fontName)) return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    setFontsLoaded(prev => new Set(prev).add(fontName));
  }, [fontsLoaded]);

  // Pre-load all selected fonts
  useEffect(() => {
    selectedFonts.forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

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

  // Cleanup object URLs on unmount
  useEffect(() => {
    const cache = fileUrlCache.current;
    const timeout = renderTimeoutRef.current;
    return () => {
      cache.forEach(url => URL.revokeObjectURL(url));
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  // ── Active surface helpers ──────────────────────────────────────────────────
  const activeSurface = surfaceStates.find(s => s.key === activeSurfaceKey) || surfaceStates[0];

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
    layoutOverride?: any,
  ) => {
    return renderCanvasCore(canvasItem, layoutOverride || layout, getFileUrl, {
      excludeFrameIdx, isExport, includeMask,
    });
  }, [layout, getFileUrl]);


  // ── Generate canvases from files ──────────────────────────────────────────────
  // Generate canvases for a specific layout definition and file set
  const generateCanvasesForLayout = useCallback(async (
    layoutDef: any, surfaceFiles: File[], fitMode: FitMode,
  ): Promise<CanvasItem[]> => {
    if (!layoutDef || surfaceFiles.length === 0) return [];
    const frameCount = layoutDef.frames?.length || 1;
    const canvasCount = Math.ceil(surfaceFiles.length / frameCount);
    const newCanvases: CanvasItem[] = [];
    for (let i = 0; i < canvasCount; i++) {
      const canvasFrames: FrameState[] = [];
      for (let f = 0; f < frameCount; f++) {
        const file = surfaceFiles[(i * frameCount + f) % surfaceFiles.length];
        if (file) canvasFrames.push({
          id: f, originalFile: file, processedUrl: null,
          offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode,
          isRemovingBg: false, isDetectingProduct: false,
        });
      }
      const item: CanvasItem = { id: i, frames: canvasFrames, textOverlays: [], shapeOverlays: [], imageOverlays: [], bgColor: '#ffffff', dataUrl: null };
      item.dataUrl = await renderCanvas(item, null, false, true, layoutDef);
      newCanvases.push(item);
    }
    return newCanvases;
  }, [renderCanvas]);

  const generateCanvases = useCallback(async () => {
    if (!layout || files.length === 0) return;
    setIsProcessing(true);
    setError(null);
    try {
      const newCanvases = await generateCanvasesForLayout(layout, files, globalFitMode);
      setCanvases(newCanvases);
    } catch { setError('Failed to process images'); }
    finally { setIsProcessing(false); }
  }, [layout, files, generateCanvasesForLayout, globalFitMode]);

  useEffect(() => {
    if (skipNextGenerateRef.current) { skipNextGenerateRef.current = false; return; }
    if (layout && files.length > 0) generateCanvases();
  }, [layout, files, generateCanvases]);

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
    setEditingCanvas({ ...c, frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })), textOverlays: c.textOverlays.map(t => ({ ...t })), shapeOverlays: c.shapeOverlays.map(s => ({ ...s })), imageOverlays: (c.imageOverlays || []).map(img => ({ ...img })) });
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


  // Auto-restore editor from URL on canvas ready
  useEffect(() => {
    if (canvases.length > 0 && activeCanvasIdx === null) {
      const idx = parseInt(new URLSearchParams(window.location.search).get('canvas') || '');
      if (!isNaN(idx) && idx >= 0 && idx < canvases.length) {
        setActiveCanvasIdx(idx);
        const c = canvases[idx];
        setEditingCanvas({ ...c, frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })), textOverlays: c.textOverlays.map(t => ({ ...t })), shapeOverlays: c.shapeOverlays.map(s => ({ ...s })), imageOverlays: (c.imageOverlays || []).map(img => ({ ...img })) });
      }
    }
  }, [canvases, activeCanvasIdx]);


  // ── File change ───────────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
    fileUrlCache.current.clear();

    const allFiles = Array.from(e.target.files);

    // Multi-surface: distribute one file per surface, cap at surface count
    if (surfaceStates.length > 1 && normalizedLayoutState) {
      setIsProcessing(true);
      setError(null);
      const maxFiles = surfaceStates.length;
      const cappedFiles = allFiles.slice(0, maxFiles);

      // Generate canvases for each surface with its own layout definition
      const updatedSurfaces: SurfaceState[] = [];
      for (let idx = 0; idx < surfaceStates.length; idx++) {
        const s = surfaceStates[idx];
        const surfaceFiles = idx < cappedFiles.length ? [cappedFiles[idx]] : [];
        const surfaceLayout = {
          ...normalizedLayoutState._raw,
          id: normalizedLayoutState._raw?.name || normalizedLayoutState.name,
          name: normalizedLayoutState.name,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        let canvases: CanvasItem[] = [];
        if (surfaceFiles.length > 0) {
          try {
            canvases = await generateCanvasesForLayout(surfaceLayout, surfaceFiles, s.globalFitMode);
          } catch { /* ignore per-surface errors */ }
        }
        updatedSurfaces.push({ ...s, files: surfaceFiles, canvases });
      }
      setSurfaceStates(updatedSurfaces);

      // Set local state for the active surface
      const activeIdx = updatedSurfaces.findIndex(s => s.key === activeSurfaceKey);
      const activeSurfaceState = updatedSurfaces[activeIdx >= 0 ? activeIdx : 0];
      setFiles(activeSurfaceState?.files || []);
      setCanvases(activeSurfaceState?.canvases || []);
      setIsProcessing(false);
      return;
    }

    setCanvases([]);
    setFiles(allFiles);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Render each canvas to a data URL for placement on sheets
      const canvasDataUrls = await Promise.all(canvases.map(c => renderCanvas(c, null, true, false)));

      const cropMarkLen = Math.round((5 / MM_TO_IN) * dpi);
      const cropMarkOff = Math.round((2 / MM_TO_IN) * dpi);

      const sheetBlobs: { name: string; blob: Blob }[] = [];
      for (let si = 0; si < impositionSheets.length; si++) {
        const sheetEl = document.createElement('canvas');
        sheetEl.width = sheetW; sheetEl.height = sheetH;
        const fabricSheet = new FabricCanvas(sheetEl, {
          width: sheetW, height: sheetH, backgroundColor: 'white', renderOnAddRemove: false,
        });

        for (const item of impositionSheets[si].items) {
          const [px, py, pw, ph] = [
            Math.round(item.x * dpi), Math.round(item.y * dpi),
            Math.round(item.w * dpi), Math.round(item.h * dpi),
          ];

          try {
            const img = await FabricImage.fromURL(canvasDataUrls[item.canvasIdx], { crossOrigin: 'anonymous' });
            if (item.rotated) {
              img.set({
                left: px + pw / 2, top: py + ph / 2,
                originX: 'center', originY: 'center',
                scaleX: ph / img.width!, scaleY: pw / img.height!,
                angle: -90, selectable: false, evented: false,
              });
            } else {
              img.set({
                left: px, top: py, originX: 'left', originY: 'top',
                scaleX: pw / img.width!, scaleY: ph / img.height!,
                selectable: false, evented: false,
              });
            }
            fabricSheet.add(img);
          } catch { /* skip failed images */ }

          // Crop marks at each corner
          for (const [cx, cy, dx, dy] of [
            [px, py, -1, -1], [px + pw, py, 1, -1],
            [px, py + ph, -1, 1], [px + pw, py + ph, 1, 1],
          ] as [number, number, number, number][]) {
            fabricSheet.add(new Line(
              [cx, cy + dy * cropMarkOff, cx, cy + dy * (cropMarkOff + cropMarkLen)],
              { stroke: '#000', strokeWidth: 1, originX: 'left', originY: 'top', selectable: false, evented: false },
            ));
            fabricSheet.add(new Line(
              [cx + dx * cropMarkOff, cy, cx + dx * (cropMarkOff + cropMarkLen), cy],
              { stroke: '#000', strokeWidth: 1, originX: 'left', originY: 'top', selectable: false, evented: false },
            ));
          }
        }

        try {
          fabricSheet.renderAll();
          const blob = await new Promise<Blob>(res => sheetEl.toBlob(b => res(b!), 'image/png'));
          sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob });
        } finally {
          fabricSheet.dispose();
        }
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
      const rendered = await Promise.all(canvases.map(c => renderCanvas(c, null, true, false)));

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
                (files.length > 0 || (surfaceStates.length > 1 && surfaceStates.some(s => s.files.length > 0)))
                  ? 'border-emerald-100 bg-emerald-50/20'
                  : hasCanvasParam ? 'border-amber-200 bg-amber-50/50'
                    : 'border-slate-200 hover:border-indigo-400 hover:bg-slate-50 cursor-pointer',
              )}>
                <input type="file" multiple onChange={handleFileChange} accept="image/*"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className="flex items-center gap-5">
                  <div className={clsx('w-14 h-14 rounded-2xl shadow-sm flex items-center justify-center transition-transform group-hover:scale-110',
                    (files.length > 0 || (surfaceStates.length > 1 && surfaceStates.some(s => s.files.length > 0)))
                      ? 'bg-emerald-500 text-white'
                      : hasCanvasParam ? 'bg-amber-500 text-white' : 'bg-white text-indigo-600')}>
                    <Upload className="w-6 h-6" />
                  </div>
                  <div className="text-left">
                    {surfaceStates.length > 1 && surfaceStates.some(s => s.files.length > 0) ? (
                      <>
                        <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">Images Loaded</h2>
                        <div className="flex items-center gap-1.5 text-emerald-600 text-xs font-bold mt-0.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {surfaceStates.filter(s => s.files.length > 0).length}/{surfaceStates.length} surfaces filled
                        </div>
                      </>
                    ) : files.length > 0 ? (
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
                          {hasCanvasParam ? 'Re-upload to continue editing'
                            : surfaceStates.length > 1
                              ? `Select ${surfaceStates.length} images (1 per surface)`
                              : 'Click or drag here'}
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
                      <div className="flex items-center gap-1.5">
                        {/* Background color */}
                        <label className="relative p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all cursor-pointer" title="Background color" onClick={e => e.stopPropagation()}>
                          <Palette className="w-3.5 h-3.5" />
                          <input type="color" value={canvas.bgColor || '#ffffff'}
                            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                            onChange={async (e) => {
                              const updated = { ...canvas, bgColor: e.target.value };
                              const dataUrl = await renderCanvas(updated);
                              const arr = [...canvases]; arr[idx] = { ...updated, dataUrl }; setCanvases(arr);
                            }} />
                        </label>
                        {/* Rotate 90° */}
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          const updated = { ...canvas, frames: canvas.frames.map(f => ({ ...f, rotation: ((f.rotation || 0) + 90) % 360 })) };
                          const dataUrl = await renderCanvas(updated);
                          const arr = [...canvases]; arr[idx] = { ...updated, dataUrl }; setCanvases(arr);
                        }} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all" title="Rotate 90°">
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                        {/* Fit / Cover toggle */}
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
        <CanvasEditorModal
          activeCanvasIdx={activeCanvasIdx}
          editingCanvas={editingCanvas}
          canvases={canvases}
          layout={layout}
          globalFitMode={globalFitMode}
          selectedFonts={selectedFonts}
          apiBase={apiBase}
          getAuthHeaders={getAuthHeaders}
          setEditingCanvas={setEditingCanvas}
          setCanvases={setCanvases}
          setFiles={setFiles}
          setError={setError}
          onClose={closeEditor}
          onOpenCanvas={openEditor}
          getFileUrl={getFileUrl}
          loadGoogleFont={loadGoogleFont}
          skipNextGenerateRef={skipNextGenerateRef}
        />
      )}

    </div>
  );
}
