'use client';

/**
 * /layout/[name]  —  Canvas editor page
 */

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useHeader } from '@/context/HeaderContext';
import {
  Upload, Loader2, CheckCircle2, X,
  Archive, FileText, Layout,
  SendHorizonal, RotateCw, Maximize, Palette, Download, ChevronRight, Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { createZipFromDataUrls, createMultiSurfaceZip, downloadBlob } from '@/lib/zip-utils';
import { normalizeLayout, filterSurfaces, type NormalizedLayout } from '@/lib/layout-utils';
import type { FitMode, FrameState, CanvasItem, ImpositionSettings, SheetLayout, SurfaceState } from './types';
import { renderCanvas as renderCanvasCore } from './fabric-renderer';
import { Canvas as FabricCanvas, StaticCanvas, Rect as FabricRect, FabricImage, Line } from 'fabric';
import { MM_TO_IN, computeImpositionLayout, resolveSheetSize } from './imposition';
import { CanvasEditorModal } from './CanvasEditorModal';

export default function LayoutEditorPage() {
  const params = useParams();
  const layoutName = Array.isArray(params.name) ? params.name[0] : (params.name as string);
  const router = useRouter();
  const { data: session, status } = useSession();

  const embedToken = useMemo<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  }, []);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (embedToken) return { 'X-Embed-Token': embedToken };
    return { Authorization: `Bearer ${session?.accessToken ?? ''}` };
  }, [embedToken, session?.accessToken]);

  const apiBase = embedToken ? '/api/embed/proxy' : '/api';

  const isAdmin = !embedToken &&
    (session?.user?.role === 'admin' || (session as any)?.is_ops_team === true);

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
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadTab, setDownloadTab] = useState<'output' | 'original'>('output');
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 7, gutterMm: 5, orientation: 'portrait',
  });

  const fileUrlCache = useRef<Map<File, string>>(new Map());
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const impositionFabricRef = useRef<StaticCanvas | null>(null);
  const skipNextGenerateRef = useRef(false);
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

  const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>([]);
  const [activeSurfaceKey, setActiveSurfaceKey] = useState<string>('default');
  const [normalizedLayoutState, setNormalizedLayoutState] = useState<NormalizedLayout | null>(null);

  const [selectedFonts, setSelectedFonts] = useState<string[]>(['sans-serif', 'serif', 'monospace']);
  const [fontsLoaded, setFontsLoaded] = useState<Set<string>>(new Set());
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  useEffect(() => {
    if (embedToken) return;
    setTitle('');
    setDescription('');
    setCenterActions(null);
    setRightActions(
      <button 
        onClick={() => router.push('/dashboard')}
        className="text-[11px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-700 px-4 py-2 rounded-2xl border-2 border-indigo-100/50 bg-indigo-50/30 hover:bg-indigo-50/60 transition-all flex items-center gap-2 group shadow-sm shadow-indigo-100/50"
      >
        <span className="group-hover:-translate-x-1 transition-transform">←</span> Back to Templates
      </button>
    );
  }, [embedToken, router, setTitle, setDescription, setCenterActions, setRightActions]);

  useEffect(() => {
    if (status === 'unauthenticated' && !embedToken) {
      router.push('/login');
    }
  }, [status, embedToken, router]);

  useEffect(() => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (embedToken) {
      headers['X-Embed-Token'] = embedToken;
    } else if (session?.accessToken) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    } else {
      return;
    }
    const fontsUrl = embedToken ? '/api/embed/proxy/fonts' : '/api/fonts';
    fetch(fontsUrl, { headers })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.fonts) setSelectedFonts(data.fonts); })
      .catch(() => {});
  }, [session?.accessToken, embedToken]);

  const loadGoogleFont = useCallback((fontName: string) => {
    if (fontsLoaded.has(fontName) || ['sans-serif', 'serif', 'monospace', 'cursive'].includes(fontName)) return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    setFontsLoaded(prev => new Set(prev).add(fontName));
  }, [fontsLoaded]);

  useEffect(() => {
    selectedFonts.forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

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
        let normalized = normalizeLayout(item);
        const surfacesParam = new URLSearchParams(window.location.search).get('surfaces');
        if (surfacesParam) {
          normalized = filterSurfaces(normalized, surfacesParam.split(',').map(s => s.trim()));
        }
        setNormalizedLayoutState(normalized);
        const initSurfaces: SurfaceState[] = normalized.surfaces.map(s => ({
          key: s.key,
          label: s.label,
          def: s,
          files: [],
          canvases: [],
          globalFitMode: 'contain' as FitMode,
        }));
        setSurfaceStates(initSurfaces);
        const firstKey = normalized.surfaces[0]?.key || 'default';
        setActiveSurfaceKey(firstKey);
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
  }, [layoutName, embedToken, session?.accessToken, apiBase, getAuthHeaders]);

  const getFileUrl = useCallback((file: File): string => {
    let url = fileUrlCache.current.get(file);
    if (!url) { url = URL.createObjectURL(file); fileUrlCache.current.set(file, url); }
    return url;
  }, []);

  useEffect(() => {
    const cache = fileUrlCache.current;
    const timeout = renderTimeoutRef.current;
    return () => {
      cache.forEach(url => URL.revokeObjectURL(url));
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  const activeSurface = surfaceStates.find(s => s.key === activeSurfaceKey) || surfaceStates[0];

  useEffect(() => {
    if (!activeSurface) return;
    setFiles(activeSurface.files);
    setCanvases(activeSurface.canvases);
    setGlobalFitMode(activeSurface.globalFitMode);
  }, [activeSurfaceKey]);

  useEffect(() => {
    if (!activeSurface || surfaceStates.length === 0) return;
    
    // Check if we actually need to update surfaceStates to prevent unnecessary re-renders
     const currentSurface = surfaceStates.find(s => s.key === activeSurfaceKey);
     if (currentSurface && (
       currentSurface.files !== files || 
       currentSurface.canvases !== canvases
     )) {
       setSurfaceStates(prev => prev.map(s =>
         s.key === activeSurfaceKey ? { ...s, files, canvases } : s
       ));
     }
   }, [files, canvases, activeSurfaceKey, surfaceStates]);

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
  }, [activeSurfaceKey, activeSurface?.def, normalizedLayoutState]);

  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const renderCanvas = useCallback(async (
    canvasItem: CanvasItem,
    excludeFrameIdx: number | null = null,
    isExport = false,
    includeMask = true,
    layoutOverride?: any,
  ) => {
    return renderCanvasCore(canvasItem, layoutOverride || layoutRef.current, getFileUrl, {
      excludeFrameIdx, isExport, includeMask,
    });
  }, [getFileUrl]);

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
          id: f, originalFile: file,
          offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode,
        });
      }
      const item: CanvasItem = {
        id: i,
        frames: canvasFrames,
        overlays: [],
        bgColor: '#ffffff',
        paperColor: '#ffffff',
        dataUrl: null
      };
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

  useEffect(() => {
    if (surfaceStates.length === 0) return;
    let cancelled = false;
    (async () => {
      setIsProcessing(true);
      
      // Update ALL surfaces and ALL their canvases with the new fit mode
      const updatedSurfaces = await Promise.all(surfaceStates.map(async (s) => {
        const updatedCanvases = await Promise.all(s.canvases.map(async (c) => {
          const patchedCanvas = {
            ...c,
            frames: c.frames.map(f => ({ ...f, fitMode: globalFitMode }))
          };
          // Re-render each canvas to update the preview dataUrl
          const dataUrl = await renderCanvas(patchedCanvas, null, false, true, s.def);
          return { ...patchedCanvas, dataUrl };
        }));
        return { ...s, globalFitMode, canvases: updatedCanvases };
      }));

      if (cancelled) return;

      setSurfaceStates(updatedSurfaces);
      
      // Synchronize the active canvases state
      const active = updatedSurfaces.find(s => s.key === activeSurfaceKey);
      if (active) {
        setCanvases(active.canvases);
      }
      
      setIsProcessing(false);
    })();
    return () => { cancelled = true; };
  }, [globalFitMode, renderCanvas]); // removed surfaceStates from deps to avoid loop, using internal surfaceStates

  const openEditor = (idx: number, surfaceKey?: string) => {
    let targetCanvases = canvases;
    if (surfaceKey && surfaceKey !== activeSurfaceKey) {
      setActiveSurfaceKey(surfaceKey);
      const surface = surfaceStates.find(s => s.key === surfaceKey);
      if (surface) targetCanvases = surface.canvases;
    }
    const c = targetCanvases[idx];
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

  const updateCanvasState = useCallback(async (idx: number, surfaceKey: string | null, updateFn: (c: CanvasItem) => CanvasItem) => {
    if (surfaceKey) {
      const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
      if (sIdx === -1) return;
      const targetSurface = surfaceStates[sIdx];
      const targetCanvas = targetSurface.canvases[idx];
      if (!targetCanvas) return;
      
      const updatedCanvas = updateFn(targetCanvas);
      updatedCanvas.dataUrl = await renderCanvas(updatedCanvas);
      
      setSurfaceStates(prev => prev.map((s, i) => 
        i === sIdx ? { ...s, canvases: s.canvases.map((c, ci) => ci === idx ? updatedCanvas : c) } : s
      ));
      if (surfaceKey === activeSurfaceKey) {
        setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
      }
    } else {
      const targetCanvas = canvases[idx];
      if (!targetCanvas) return;
      
      const updatedCanvas = updateFn(targetCanvas);
      updatedCanvas.dataUrl = await renderCanvas(updatedCanvas);
      
      setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
    }
  }, [surfaceStates, canvases, activeSurfaceKey, renderCanvas]);

  const handleQuickRotate = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => ({
      ...c,
      frames: c.frames.map(f => ({ ...f, rotation: (f.rotation + 90) % 360 }))
    }));
  };

  const handleQuickToggleFit = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => ({
      ...c,
      frames: c.frames.map(f => ({ ...f, fitMode: f.fitMode === 'contain' ? 'cover' : 'contain' }))
    }));
  };

  const handleQuickCycleBg = (idx: number, surfaceKey: string | null = null) => {
     updateCanvasState(idx, surfaceKey, (c) => ({
       ...c,
       bgColor: c.bgColor === '#ffffff' ? '#000000' : c.bgColor === '#000000' ? '#f8fafc' : '#ffffff'
     }));
   };
 
   const handleQuickSetBg = (idx: number, color: string, surfaceKey: string | null = null) => {
     updateCanvasState(idx, surfaceKey, (c) => ({
      ...c,
      bgColor: color
    }));
  };

  const handleQuickDelete = (idx: number, surfaceKey: string | null = null) => {
    if (window.confirm('Are you sure you want to remove this image?')) {
      if (surfaceKey) {
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return;
        setSurfaceStates(prev => prev.map((s, i) =>
          i === sIdx ? { ...s, files: [], canvases: [] } : s
        ));
        if (surfaceKey === activeSurfaceKey) {
          setFiles([]);
          setCanvases([]);
        }
      } else {
        setFiles(prev => prev.filter((_, i) => i !== idx));
      }
    }
  };

  const handleQuickDownload = (idx: number, surfaceKey: string | null = null) => {
    const targetCanvases = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.canvases : canvases;
    const c = targetCanvases?.[idx];
    if (c?.dataUrl) {
      const a = document.createElement('a');
      a.href = c.dataUrl;
      a.download = `${layout.id}-${surfaceKey || 'canvas'}-${idx + 1}.png`;
      a.click();
    }
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
  }, [canvases, activeCanvasIdx]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
    fileUrlCache.current.clear();
    const allFiles = Array.from(e.target.files);
    if (surfaceStates.length > 1 && normalizedLayoutState) {
      setIsProcessing(true);
      setError(null);
      const maxFiles = surfaceStates.length;
      if (allFiles.length > maxFiles) {
        setUploadWarning(`Only ${maxFiles} image${maxFiles !== 1 ? 's' : ''} were selected.`);
        setTimeout(() => setUploadWarning(null), 5000);
      }
      const cappedFiles = allFiles.slice(0, maxFiles);
      const updatedSurfaces: SurfaceState[] = [];
      for (let idx = 0; idx < surfaceStates.length; idx++) {
        const s = surfaceStates[idx];
        const surfaceFiles = idx < cappedFiles.length ? [cappedFiles[idx]] : [];
        const surfaceLayout = {
          ...normalizedLayoutState._raw,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        let canvases: CanvasItem[] = [];
        if (surfaceFiles.length > 0) {
          canvases = await generateCanvasesForLayout(surfaceLayout, surfaceFiles, s.globalFitMode);
        }
        updatedSurfaces.push({ ...s, files: surfaceFiles, canvases });
      }
      setSurfaceStates(updatedSurfaces);
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

  const impositionResult = useMemo(() => {
    const allCanvases = surfaceStates.length > 1 
      ? surfaceStates.flatMap(s => s.canvases)
      : canvases;
    
    if (allCanvases.length === 0 || !layout) return { sheets: [] as SheetLayout[], skippedCount: 0 };
    const dpi = 300;
    const itemSizes = allCanvases.map(() => ({
      wIn: (layout.canvas?.width || 1200) / dpi,
      hIn: (layout.canvas?.height || 1800) / dpi,
    }));
    return computeImpositionLayout(impositionSettings, itemSizes);
  }, [impositionSettings, canvases, surfaceStates, layout]);

  useEffect(() => {
    const canvasEl = impositionPreviewRef.current;
    const { sheets } = impositionResult;
    if (!canvasEl || sheets.length === 0 || !showImpositionModal) return;
    const sheetIdx = Math.min(previewSheetIdx, sheets.length - 1);
    const sheet = sheets[sheetIdx];
    if (!sheet) return;
    const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
    const scale = Math.min(520 / sheetWIn, 340 / sheetHIn);
    const pw = Math.round(sheetWIn * scale), ph = Math.round(sheetHIn * scale);
    const mPx = (impositionSettings.marginMm / MM_TO_IN) * scale;
    const markLen = (5 / MM_TO_IN) * scale, markOffset = (2 / MM_TO_IN) * scale;
    if (impositionFabricRef.current) {
      impositionFabricRef.current.dispose();
      impositionFabricRef.current = null;
    }
    const fc = new StaticCanvas(canvasEl, {
      width: pw, height: ph, backgroundColor: '#f8fafc', renderOnAddRemove: false,
    });
    impositionFabricRef.current = fc;
    fc.add(new FabricRect({
      left: mPx, top: mPx, width: pw - 2 * mPx, height: ph - 2 * mPx,
      fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 1,
      strokeDashArray: [4, 3], selectable: false, evented: false,
    }));
    fc.add(new FabricRect({
      left: 0, top: 0, width: pw, height: ph,
      fill: 'transparent', stroke: '#94a3b8', strokeWidth: 1.5,
      selectable: false, evented: false,
    }));
    let aborted = false;
    const drawItems = async () => {
      const allCanvases = surfaceStates.length > 1 
        ? surfaceStates.flatMap(s => s.canvases)
        : canvases;

      for (const item of sheet.items) {
        if (aborted) return;
        const [px, py, iw, ih] = [item.x * scale, item.y * scale, item.w * scale, item.h * scale];
        const c = allCanvases[item.canvasIdx];
        if (c?.dataUrl) {
          try {
            const img = await FabricImage.fromURL(c.dataUrl, { crossOrigin: 'anonymous' });
            if (aborted) return;
            if (item.rotated) {
              img.set({
                left: px + iw / 2, top: py + ih / 2,
                originX: 'center', originY: 'center',
                scaleX: ih / (img.width || 1), scaleY: iw / (img.height || 1),
                angle: -90, selectable: false, evented: false,
              });
            } else {
              img.set({
                left: px, top: py, originX: 'left', originY: 'top',
                scaleX: iw / (img.width || 1), scaleY: ih / (img.height || 1),
                selectable: false, evented: false,
              });
            }
            fc.add(img);
          } catch { }
        }
        for (const [cx, cy, dx, dy] of [
          [px, py, -1, -1], [px + iw, py, 1, -1],
          [px, py + ih, -1, 1], [px + iw, py + ih, 1, 1],
        ] as [number, number, number, number][]) {
          fc.add(new Line([cx, cy + dy * markOffset, cx, cy + dy * (markOffset + markLen)], { stroke: '#64748b', strokeWidth: 0.5, selectable: false, evented: false }));
          fc.add(new Line([cx + dx * markOffset, cy, cx + dx * (markOffset + markLen), cy], { stroke: '#64748b', strokeWidth: 0.5, selectable: false, evented: false }));
        }
      }
      if (!aborted) fc.requestRenderAll();
    };
    drawItems();
    return () => {
      aborted = true;
      if (impositionFabricRef.current) {
        impositionFabricRef.current.dispose();
        impositionFabricRef.current = null;
      }
    };
  }, [impositionResult, previewSheetIdx, impositionSettings, canvases, showImpositionModal]);

  const executeBatchDownload = async () => {
    setIsDownloading(true);
    try {
            const zipName = layout.name || layout.id || `job-${Date.now().toString().slice(-6)}`;
      
      // Structure: 
      // zip/cx_file/ -> Original uploaded files
      // zip/mockup_file/ -> Low-quality reference PNGs
      // zip/print_file/ -> High-quality, print-ready PNGs (no shadow)
      
      const filesToZip: { name: string; url?: string; blob?: Blob }[] = [];
      
      // 1. High-quality Print Files (no shadow)
      if (surfaceStates.length > 1) {
        for (const s of surfaceStates) {
          const printCanvases = await Promise.all(s.canvases.map(c => renderCanvas(c, null, true, false, s.def)));
          printCanvases.forEach((dataUrl, ci) => {
            if (dataUrl) {
              filesToZip.push({ 
                name: `print_file/${s.key}-${ci + 1}.png`, 
                url: dataUrl 
              });
            }
          });
        }
      } else {
        const printCanvases = await Promise.all(canvases.map(c => renderCanvas(c, null, true, false)));
        printCanvases.forEach((dataUrl, i) => {
          if (dataUrl) {
            filesToZip.push({ 
              name: `print_file/canvas-${i + 1}.png`, 
              url: dataUrl 
            });
          }
        });
      }

      // 2. Low-quality Mockup Files (with shadow)
      if (surfaceStates.length > 1) {
        for (const s of surfaceStates) {
          s.canvases.forEach((c, ci) => {
            if (c.dataUrl) { // Use existing low-res data URL with shadow
              filesToZip.push({ 
                name: `mockup_file/${s.key}-${ci + 1}.png`, 
                url: c.dataUrl 
              });
            }
          });
        }
      } else {
        canvases.forEach((c, i) => {
          if (c.dataUrl) {
            filesToZip.push({ 
              name: `mockup_file/canvas-${i + 1}.png`, 
              url: c.dataUrl 
            });
          }
        });
      }

      // 3. Original Files (CX Files)
      const allOriginalFiles = surfaceStates.length > 1 
        ? surfaceStates.flatMap(s => s.files)
        : files;
      
      allOriginalFiles.forEach((file, i) => {
        const url = getFileUrl(file);
        if (url) {
          filesToZip.push({ 
            name: `cx_file/${file.name}`, 
            url: url
          });
        }
      });

      downloadBlob(await createZipFromDataUrls(filesToZip as { name: string; url: string }[]), `${zipName}.zip`);
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
      
      const allCanvases = surfaceStates.length > 1 
        ? surfaceStates.flatMap(s => s.canvases)
        : canvases;

      const { sheets: impositionSheets } = computeImpositionLayout(
        impositionSettings,
        allCanvases.map(() => ({ wIn: canvasW / dpi, hIn: canvasH / dpi })),
      );
      const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
      const sheetW = Math.round(sheetWIn * dpi), sheetH = Math.round(sheetHIn * dpi);
      
      // Use TRUE for includeMask so we get the frames in the print sheets
      const canvasDataUrls = await Promise.all(allCanvases.map(c => renderCanvas(c, null, true, true)));
      
      const cropMarkLen = Math.round((5 / MM_TO_IN) * dpi);
      const cropMarkOff = Math.round((2 / MM_TO_IN) * dpi);
      const sheetBlobs: { name: string; blob: Blob }[] = [];
      for (let si = 0; si < impositionSheets.length; si++) {
        const sheetEl = document.createElement('canvas');
        sheetEl.width = sheetW; sheetEl.height = sheetH;
        const fabricSheet = new FabricCanvas(sheetEl, { width: sheetW, height: sheetH, backgroundColor: 'white', renderOnAddRemove: false });
        for (const item of impositionSheets[si].items) {
          const [px, py, pw, ph] = [Math.round(item.x * dpi), Math.round(item.y * dpi), Math.round(item.w * dpi), Math.round(item.h * dpi)];
          try {
            const img = await FabricImage.fromURL(canvasDataUrls[item.canvasIdx], { crossOrigin: 'anonymous' });
            if (item.rotated) {
              img.set({ left: px + pw / 2, top: py + ph / 2, originX: 'center', originY: 'center', scaleX: ph / img.width!, scaleY: pw / img.height!, angle: -90, selectable: false, evented: false });
            } else {
              img.set({ left: px, top: py, originX: 'left', originY: 'top', scaleX: pw / img.width!, scaleY: ph / img.height!, selectable: false, evented: false });
            }
            fabricSheet.add(img);
          } catch { }
          for (const [cx, cy, dx, dy] of [[px, py, -1, -1], [px + pw, py, 1, -1], [px, py + ph, -1, 1], [px + pw, py + ph, 1, 1]] as [number, number, number, number][]) {
            fabricSheet.add(new Line([cx, cy + dy * cropMarkOff, cx, cy + dy * (cropMarkOff + cropMarkLen)], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
            fabricSheet.add(new Line([cx + dx * cropMarkOff, cy, cx + dx * (cropMarkOff + cropMarkLen), cy], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
          }
        }
        fabricSheet.renderAll();
        const blob = await new Promise<Blob>(res => sheetEl.toBlob(b => res(b!), 'image/png'));
        sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob });
        fabricSheet.dispose();
      }
      if (sheetBlobs.length === 1) downloadBlob(sheetBlobs[0].blob, sheetBlobs[0].name);
      else {
        const zip = sheetBlobs.map(sb => ({ name: sb.name, url: URL.createObjectURL(sb.blob) }));
        downloadBlob(await createZipFromDataUrls(zip), 'imposition-sheets.zip');
        zip.forEach(z => URL.revokeObjectURL(z.url));
      }
    } catch { setError('Imposition failed.'); }
    finally { setIsImposing(false); setShowImpositionModal(false); }
  };

  const handleSubmitDesign = async () => {
    if (canvases.length === 0) return;
    setIsDownloading(true);
    try {
            const rendered = await Promise.all(canvases.map(c => renderCanvas(c, null, true, false)));
      const surfacesPayload: Record<string, { index: number; dataUrl: string }[]> = {};
      if (surfaceStates.length > 1) {
        for (const s of surfaceStates) {
          surfacesPayload[s.key] = s.canvases.map((c, i) => ({ index: i, dataUrl: c.dataUrl || '' }));
        }
      }
      window.parent.postMessage({
        type: 'PRODUCT_EDITOR_COMPLETE',
        layoutName: layout?.id,
        ...(surfaceStates.length > 1 ? { surfaces: surfacesPayload } : {}),
        canvases: rendered.map((dataUrl, i) => ({ index: i, dataUrl })),
      }, '*');
      setSubmitted(true);
    } catch { setError('Failed to prepare design.'); }
    finally { setIsDownloading(false); }
  };

  if (status === 'loading' && !embedToken) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-8 h-8 text-indigo-600 animate-spin" /></div>;
  if (layoutLoading) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-8 h-8 text-indigo-600 animate-spin" /></div>;
  if (!layout) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="text-center"><p className="text-slate-600 font-medium">Layout not found.</p></div></div>;

  const totalUploadedCount = files.length > 0 ? files.length : surfaceStates.reduce((acc, s) => acc + s.files.length, 0);

  return (
    <div className="min-h-screen bg-slate-50/50 flex flex-col">
      {uploadWarning && (
        <div className="fixed top-24 right-8 z-[200000] max-w-xs bg-white/80 backdrop-blur-2xl border border-amber-200/50 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-amber-900/5 flex items-center gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group">
          <div className="w-7 h-7 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0">
            <span className="text-[14px] font-black">!</span>
          </div>
          <span className="flex-1 text-[10px] font-bold text-amber-900/80 uppercase tracking-tight leading-none">{uploadWarning}</span>
          <button onClick={() => setUploadWarning(null)} className="p-2 hover:bg-amber-50 rounded-xl transition-all group-hover:rotate-90">
            <X className="w-3.5 h-3.5 text-amber-400" />
          </button>
        </div>
      )}
      {error && (
        <div className="fixed top-4 right-4 z-[200000] max-w-sm bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl shadow-lg flex items-center gap-3">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      {submitted && (
        <div className="fixed inset-0 z-[300000] flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="text-center p-10">
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900">Design Submitted</h2>
          </div>
        </div>
      )}

      <main className="w-full px-8 py-8 flex-1">
        <div className="max-w-[1440px] mx-auto space-y-8">
          <div className="sticky top-[64px] z-40 -mx-8 px-8 py-3 bg-white/60 backdrop-blur-3xl border-b border-slate-200/50 flex items-center justify-between gap-4 shadow-sm">
            <div className="flex flex-col min-w-0">
              <h1 className="text-base font-black text-slate-900 uppercase tracking-tighter truncate">
                {layout?.name || layoutName}
              </h1>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-tight truncate">
                {layout?.dimensions ? `${layout.dimensions} | ` : ''}
                { (files.length > 0 || surfaceStates.some(s => s.files.length > 0)) ? 'Generated Canvases' : 'Upload File' }
              </p>
            </div>
            <div className="flex-1 max-w-md relative group">
              <div className={clsx("relative flex items-center gap-3 px-4 py-2 rounded-2xl border-2 border-dashed transition-all", (files.length > 0 || surfaceStates.some(s => s.files.length > 0)) ? 'border-emerald-200 bg-emerald-50/30' : 'border-indigo-200 bg-indigo-50/30 hover:border-indigo-400')}>
                <input type="file" multiple onChange={handleFileChange} accept="image/*" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className={clsx("w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm", totalUploadedCount > 0 ? 'bg-emerald-500 text-white' : 'bg-indigo-600 text-white')}>
                  <Upload className="w-4 h-4" />
                </div>
                <p className="text-[11px] font-black text-slate-800 uppercase tracking-tight">
                  {totalUploadedCount > 0 
                    ? `Upload Photos | Currently uploaded (${totalUploadedCount})` 
                    : surfaceStates.length > 1 
                      ? `Select Files | Multi-Surface: Select ${surfaceStates.length} photos`
                      : 'Select Files'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden md:flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/50">
                {(['contain', 'cover'] as FitMode[]).map(mode => (
                  <button key={mode} onClick={() => setGlobalFitMode(mode)} className={clsx('px-3 py-1.5 text-[10px] font-black rounded-lg transition-all uppercase', globalFitMode === mode ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500')}>{mode === 'contain' ? 'Fit' : 'Cover'}</button>
                ))}
              </div>
              {embedToken ? (
                <button onClick={handleSubmitDesign} disabled={isDownloading || (files.length === 0 && !surfaceStates.some(s => s.files.length > 0))} className="flex items-center gap-2 text-[11px] font-black text-white bg-indigo-600 px-5 py-2.5 rounded-xl hover:bg-indigo-700 transition-all uppercase tracking-widest">
                  {isDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SendHorizonal className="w-3.5 h-3.5" />} Submit
                </button>
              ) : isAdmin ? (
                <button onClick={() => setShowDownloadModal(true)} disabled={files.length === 0 && !surfaceStates.some(s => s.files.length > 0)} className="flex items-center gap-2 text-[11px] font-black text-white bg-slate-900 px-5 py-2.5 rounded-xl hover:bg-slate-800 transition-all uppercase tracking-widest">
                  <Archive className="w-3.5 h-3.5" /> Download
                </button>
              ) : null}
            </div>
          </div>

          {canvases.length > 0 && (
            <section className="space-y-6 pt-0">
              {surfaceStates.length > 1 ? (
                <div className="flex gap-6 items-start justify-center overflow-x-auto pb-4 px-4 w-full custom-scrollbar">
                  {surfaceStates.map((surface, sIdx) => {
                    const cw = surface.def.canvas?.width || 1200;
                    const ch = surface.def.canvas?.height || 1800;
                    const surfaceCanvas = surface.canvases[0] || null;
                    return (
                      <div key={surface.key} className="shrink-0 flex flex-col gap-3" style={{ width: cw > ch ? '400px' : '280px' }}>
                        <div className="flex items-center justify-between px-1">
                          <h3 className="text-xs font-black text-slate-900 uppercase tracking-tight truncate">{surface.label}</h3>
                          <button onClick={() => openEditor(0, surface.key)} className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100 uppercase tracking-wide">Edit</button>
                        </div>
                        <div className="bg-white rounded-2xl border-2 border-slate-100 hover:border-indigo-400 transition-all overflow-hidden cursor-pointer group/card relative" onClick={() => openEditor(0, surface.key)}>
                          <div className="relative overflow-hidden bg-slate-50" style={{ aspectRatio: `${cw} / ${ch}` }}>
                            {surfaceCanvas?.dataUrl ? <img src={surfaceCanvas.dataUrl} className="absolute inset-0 w-full h-full object-fill" alt={surface.label} /> : <div className="absolute inset-0 flex items-center justify-center text-slate-300"><Layout className="w-10 h-10 opacity-20" /></div>}
                            
                            <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 p-1.5 bg-white/40 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm">
                               <button onClick={(e) => { e.stopPropagation(); handleQuickRotate(0, surface.key); }} className="p-2 bg-indigo-50/80 text-indigo-600 rounded-xl hover:bg-indigo-100 hover:scale-105 transition-all" title="Rotate 90°">
                                 <RotateCw className="w-3.5 h-3.5" />
                               </button>
                               <button onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(0, surface.key); }} className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all" title="Toggle Fit/Cover">
                                 <Maximize className="w-3.5 h-3.5" />
                               </button>
                               <div className="relative">
                                 <button onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.nextElementSibling as HTMLInputElement; if (el) el.click(); }} className="p-2 bg-amber-50/80 text-amber-600 rounded-xl hover:bg-amber-100 hover:scale-105 transition-all" title="Set Background Color">
                                   <Palette className="w-3.5 h-3.5" />
                                 </button>
                                 <input 
                                   type="color" 
                                   className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none" 
                                   value={surfaceCanvas?.bgColor || '#ffffff'}
                                   onChange={(e) => handleQuickSetBg(0, e.target.value, surface.key)}
                                   onClick={(e) => e.stopPropagation()}
                                 />
                               </div>
                               <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(0, surface.key); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                                 <Download className="w-3.5 h-3.5" />
                               </button>
                               <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(0, surface.key); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Delete">
                                 <Trash2 className="w-3.5 h-3.5" />
                               </button>
                             </div>
                          </div>
                          <div className="px-3 py-2 flex items-center justify-between bg-white border-t border-slate-50">
                            <span className="text-[10px] font-bold text-slate-400">{surface.def.canvas?.widthMm}×{surface.def.canvas?.heightMm}mm</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 justify-center">
                  {canvases.map((canvas, idx) => (
                    <div key={idx} className="bg-white rounded-2xl border border-slate-200 transition-all cursor-pointer group/card relative" onClick={() => openEditor(idx)}>
                      <div className="relative rounded-t-2xl overflow-hidden bg-slate-50" style={{ aspectRatio: `${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}` }}>
                        {canvas.dataUrl && <img src={canvas.dataUrl} className="absolute inset-0 w-full h-full object-fill" alt={`Canvas ${idx + 1}`} />}
                        
                        <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 p-1.5 bg-white/40 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm">
                          <button onClick={(e) => { e.stopPropagation(); handleQuickRotate(idx); }} className="p-2 bg-indigo-50/80 text-indigo-600 rounded-xl hover:bg-indigo-100 hover:scale-105 transition-all" title="Rotate 90°">
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(idx); }} className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all" title="Toggle Fit/Cover">
                            <Maximize className="w-3.5 h-3.5" />
                          </button>
                          <div className="relative">
                            <button onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.nextElementSibling as HTMLInputElement; if (el) el.click(); }} className="p-2 bg-amber-50/80 text-amber-600 rounded-xl hover:bg-amber-100 hover:scale-105 transition-all" title="Set Background Color">
                              <Palette className="w-3.5 h-3.5" />
                            </button>
                            <input 
                              type="color" 
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none" 
                              value={canvas.bgColor || '#ffffff'}
                              onChange={(e) => handleQuickSetBg(idx, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(idx); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(idx); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="p-3">
                        <h3 className="font-black text-slate-900 uppercase tracking-tight truncate group-hover:text-indigo-600 transition-colors">
                          Canvas {idx + 1}
                        </h3>
                        {layout.dimensions && (
                          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 flex items-center gap-2">
                            <span>{layout.dimensions}</span>
                            <span>•</span>
                            <span>{layout.frames?.length || 0} Frames</span>
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {showDownloadModal && isAdmin && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowDownloadModal(false)} />
              <div className="relative w-full max-w-sm bg-white rounded-[32px] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
                <div className="p-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">Download Results</h3>
                    <button onClick={() => setShowDownloadModal(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="flex p-1 bg-slate-100 rounded-2xl border border-slate-200/50">
                      <button 
                        onClick={() => setDownloadTab('output')}
                        className={clsx(
                          "flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all",
                          downloadTab === 'output' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400 hover:text-slate-600"
                        )}
                      >
                        Output Files
                      </button>
                      <button 
                        onClick={() => setDownloadTab('original')}
                        className={clsx(
                          "flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all",
                          downloadTab === 'original' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400 hover:text-slate-600"
                        )}
                      >
                        CX Files
                      </button>
                    </div>

                    {downloadTab === 'original' && (
                      <div className="py-2 px-1">
                        <div className="flex flex-col gap-1 max-h-[160px] overflow-y-auto custom-scrollbar pr-2">
                          {(surfaceStates.length > 1 ? surfaceStates.flatMap(s => s.files) : files).map((f, i) => (
                            <div key={i} className="flex items-center gap-3 p-2 bg-slate-50 rounded-xl border border-slate-100">
                              <div className="w-8 h-8 rounded-lg bg-white border flex items-center justify-center overflow-hidden shrink-0">
                                <img src={getFileUrl(f)} className="w-full h-full object-cover" />
                              </div>
                              <span className="text-[9px] font-black text-slate-500 truncate flex-1 uppercase tracking-tight">{f.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 flex flex-col gap-3">
                      <button onClick={executeBatchDownload} className="w-full group flex items-center gap-4 p-4 rounded-2xl border border-slate-100 hover:border-indigo-500 hover:bg-indigo-50/30 transition-all text-left bg-slate-50/50">
                        <div className="w-10 h-10 bg-white rounded-xl border flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform"><Archive className="w-5 h-5 text-indigo-600" /></div>
                        <div>
                          <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">Download ZIP</p>
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">CX + Output Folders</p>
                        </div>
                      </button>
                      <button onClick={() => { setShowDownloadModal(false); setShowImpositionModal(true); }} className="w-full group flex items-center gap-4 p-4 rounded-2xl border border-slate-100 hover:border-emerald-500 hover:bg-emerald-50/30 transition-all text-left bg-slate-50/50">
                        <div className="w-10 h-10 bg-white rounded-xl border flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform"><FileText className="w-5 h-5 text-emerald-600" /></div>
                        <div>
                          <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">Print Imposition</p>
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">Auto-repeat & Sheets</p>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showImpositionModal && isAdmin && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowImpositionModal(false)} />
              <div className="relative w-full max-w-4xl bg-white rounded-[40px] shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[90vh]">
                {/* Left: Preview */}
                <div className="flex-[1.2] bg-slate-50 p-8 flex flex-col items-center justify-center relative border-r border-slate-100">
                  <div className="absolute top-6 left-8">
                    <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">Sheet Preview</h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                      Sheet {previewSheetIdx + 1} of {impositionResult.sheets.length}
                    </p>
                  </div>
                  
                  <div className="relative bg-white p-1 rounded-sm">
                    <canvas ref={impositionPreviewRef} className="max-w-full h-auto rounded-sm border border-slate-200" />
                  </div>

                  <div className="mt-8 flex items-center gap-4 bg-white/80 backdrop-blur-md p-1.5 rounded-2xl border border-slate-200 shadow-sm">
                    <button 
                      disabled={previewSheetIdx === 0}
                      onClick={() => setPreviewSheetIdx(p => p - 1)}
                      className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all rounded-xl hover:bg-slate-50"
                    >
                      <ChevronRight className="w-4 h-4 rotate-180" />
                    </button>
                    <span className="text-[10px] font-black text-slate-700 uppercase tracking-tighter min-w-[60px] text-center">
                      Page {previewSheetIdx + 1}
                    </span>
                    <button 
                      disabled={previewSheetIdx === impositionResult.sheets.length - 1}
                      onClick={() => setPreviewSheetIdx(p => p + 1)}
                      className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all rounded-xl hover:bg-slate-50"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Right: Controls */}
                <div className="flex-1 p-8 flex flex-col gap-8 bg-white overflow-y-auto custom-scrollbar">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center shadow-sm shadow-emerald-100">
                        <FileText className="w-5 h-5" />
                      </div>
                      <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">Print Settings</h3>
                    </div>
                    <button onClick={() => setShowImpositionModal(false)} className="p-2 hover:bg-slate-50 rounded-full transition-colors">
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>

                  <div className="space-y-8">
                    {/* Presets */}
                    <div className="space-y-3">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Sheet Size</label>
                      <div className="grid grid-cols-3 gap-2">
                        {(['a4', 'a3', '12x18', '13x19', 'custom'] as const).map(p => (
                          <button key={p} onClick={() => setImpositionSettings(s => ({ ...s, preset: p }))} className={clsx('py-2.5 text-[10px] font-black rounded-xl border transition-all uppercase tracking-tighter', impositionSettings.preset === p ? 'bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-100' : 'border-slate-100 text-slate-400 hover:border-slate-300')}>
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Precise Gutter & Margin */}
                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-3">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Gutter (Gap)</label>
                        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100 focus-within:border-indigo-300 transition-colors">
                          <input 
                            type="number" 
                            value={impositionSettings.gutterMm}
                            onChange={e => setImpositionSettings(s => ({ ...s, gutterMm: Number(e.target.value) }))}
                            className="bg-transparent text-[11px] font-black text-slate-800 outline-none w-full"
                          />
                          <span className="text-[9px] font-black text-slate-300 uppercase">mm</span>
                        </div>
                      </div>
                      <div className="space-y-3">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Margin</label>
                        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100 focus-within:border-indigo-300 transition-colors">
                          <input 
                            type="number" 
                            value={impositionSettings.marginMm}
                            onChange={e => setImpositionSettings(s => ({ ...s, marginMm: Number(e.target.value) }))}
                            className="bg-transparent text-[11px] font-black text-slate-800 outline-none w-full"
                          />
                          <span className="text-[9px] font-black text-slate-300 uppercase">mm</span>
                        </div>
                      </div>
                    </div>

                    {/* Auto Repeat Logic */}
                    <div className="p-5 bg-indigo-50/50 rounded-3xl border border-indigo-100/50 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] font-black text-indigo-900 uppercase tracking-tight">Smart Auto-Repeat</p>
                        <div className="w-5 h-5 bg-indigo-500 text-white rounded-full flex items-center justify-center text-[10px] font-black">✓</div>
                      </div>
                      <p className="text-[10px] font-bold text-indigo-700/60 leading-relaxed">
                        The imposition engine will automatically repeat your canvases to fill the empty space on the {impositionSettings.preset.toUpperCase()} sheet efficiently.
                      </p>
                    </div>
                  </div>

                  <div className="mt-auto pt-6 border-t border-slate-100 flex gap-4">
                    <button onClick={executeImposition} disabled={isImposing} className="w-full py-4 bg-slate-900 text-white rounded-[24px] text-[11px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all flex items-center justify-center gap-3 shadow-xl shadow-slate-200">
                      {isImposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} 
                      Download Print Sheets
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {activeCanvasIdx !== null && editingCanvas && (
        <CanvasEditorModal
          key={`modal-${activeSurfaceKey}-${activeCanvasIdx}`}
          activeCanvasIdx={activeCanvasIdx}
          editingCanvas={editingCanvas}
          canvases={canvases}
          surfaceStates={surfaceStates}
          activeSurfaceKey={activeSurfaceKey}
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
