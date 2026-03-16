'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Header } from '@/components/Header';
import { Upload, ChevronRight, Loader2, CheckCircle2, Search, X, Download, Maximize2, Wand2, Layers, Archive, FileText, Plus, Minus } from 'lucide-react';
import { clsx } from 'clsx';
import { LayoutSVG } from '@/components/LayoutSVG';
import { createZipFromDataUrls, downloadBlob } from '@/lib/zip-utils';

const LayoutPreview = ({ layout }: { layout: any }) => (
  <div className="w-full aspect-square flex items-center justify-center p-4 bg-slate-50 border-b border-slate-100">
    <LayoutSVG layout={layout} />
  </div>
);

interface PlacedItem {
  canvasIdx: number;
  x: number; // inches from sheet origin
  y: number;
  w: number; // inches
  h: number;
  rotated: boolean;
}

interface SheetLayout {
  items: PlacedItem[];
}

const MM_TO_IN = 25.4;

const PRESET_DIMENSIONS: Record<string, { w: number; h: number }> = {
  a4: { w: 8.27, h: 11.69 },
  a3: { w: 11.69, h: 16.54 },
  '12x18': { w: 12, h: 18 },
  '13x19': { w: 13, h: 19 },
};

function resolveSheetSize(settings: ImpositionSettings): { w: number; h: number } {
  const base = settings.preset === 'custom'
    ? { w: settings.widthIn, h: settings.heightIn }
    : PRESET_DIMENSIONS[settings.preset] || PRESET_DIMENSIONS.a4;
  return settings.orientation === 'landscape'
    ? { w: base.h, h: base.w }
    : { w: base.w, h: base.h };
}

function computeImpositionLayout(
  settings: ImpositionSettings,
  itemSizes: { wIn: number; hIn: number }[]
): { sheets: SheetLayout[]; skippedCount: number } {
  const marginIn = settings.marginMm / MM_TO_IN;
  const gutterIn = settings.gutterMm / MM_TO_IN;

  const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(settings);

  const safeW = sheetWIn - marginIn * 2;
  const safeH = sheetHIn - marginIn * 2;

  if (safeW <= 0 || safeH <= 0) return { sheets: [], skippedCount: itemSizes.length };

  const sheets: SheetLayout[] = [{ items: [] }];
  let curX = marginIn;
  let curY = marginIn;
  let rowMaxH = 0;
  let skippedCount = 0;

  for (let i = 0; i < itemSizes.length; i++) {
    let w = itemSizes[i].wIn;
    let h = itemSizes[i].hIn;
    let rotated = false;

    const fitsNormal = w <= safeW && h <= safeH;
    const fitsRotated = h <= safeW && w <= safeH;

    if (!fitsNormal && fitsRotated) {
      [w, h] = [h, w];
      rotated = true;
    } else if (!fitsNormal && !fitsRotated) {
      skippedCount++;
      continue;
    }

    // New row if doesn't fit horizontally
    if (curX + w > marginIn + safeW) {
      curX = marginIn;
      curY += rowMaxH + gutterIn;
      rowMaxH = 0;
    }

    // New sheet if doesn't fit vertically
    if (curY + h > marginIn + safeH) {
      sheets.push({ items: [] });
      curX = marginIn;
      curY = marginIn;
      rowMaxH = 0;
    }

    sheets[sheets.length - 1].items.push({ canvasIdx: i, x: curX, y: curY, w, h, rotated });
    curX += w + gutterIn;
    rowMaxH = Math.max(rowMaxH, h);
  }

  return { sheets, skippedCount };
}

type FitMode = 'contain' | 'cover';

interface FrameState {
  id: number;
  originalFile: File;
  processedUrl: string | null; // This could be the BG removed version
  offset: { x: number; y: number };
  scale: number;
  fitMode: FitMode;
  isRemovingBg: boolean;
  isDetectingProduct: boolean;
}

interface CanvasItem {
  id: number;
  frames: FrameState[];
  dataUrl: string | null; // The flattened result for preview
}

interface ImpositionSettings {
  preset: 'a4' | 'a3' | '12x18' | '13x19' | 'custom';
  widthIn: number;
  heightIn: number;
  marginMm: number;
  gutterMm: number;
  orientation: 'portrait' | 'landscape';
}

export default function Dashboard() {
  const { data: session, status } = useSession();
  const [layouts, setLayouts] = useState<any[]>([]);
  const [selectedLayout, setSelectedLayout] = useState<any | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isFetchingLayouts, setIsFetchingLayouts] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [canvases, setCanvases] = useState<CanvasItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCanvasIdx, setActiveCanvasIdx] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4',
    widthIn: 8.27,
    heightIn: 11.69,
    marginMm: 7, // Printer safety margin (gripper)
    gutterMm: 5, // Space between images
    orientation: 'portrait'
  });

  const [globalFitMode, setGlobalFitMode] = useState<FitMode>('contain');

  const [dragState, setDragState] = useState<{
    canvasIdx: number; 
    frameIdx: number; 
    startX: number; 
    startY: number; 
    initialX: number; 
    initialY: number; 
    containerRatio: number; // Ratio of canvas coordinate to DOM pixels
    frameRect: { fx: number; fy: number; fw: number; fh: number };
    imgRect: { w: number; h: number };
  } | null>(null);
  const tempOffsetRef = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafIdRef = React.useRef<number>(0); 
  const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
  const [activeDragFrameUrl, setActiveDragFrameUrl] = useState<string | null>(null); // Active frame image for drag overlay
  const [viewZoom, setViewZoom] = useState(0.8); // Workspace zoom (will be updated by fitToScreen)
  const previewImgRef = React.useRef<HTMLImageElement>(null);
  const workspaceRef = React.useRef<HTMLDivElement>(null);

  // Image caching: avoid re-creating object URLs and re-loading images on every render
  const fileUrlCache = React.useRef<Map<File, string>>(new Map());
  const imgCache = React.useRef<Map<string, HTMLImageElement>>(new Map());

  // Throttle expensive renderCanvas calls (slider/input)
  const renderTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderGenRef = React.useRef(0);

  // Imposition live preview
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const previewImgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

  const impositionResult = useMemo(() => {
    if (canvases.length === 0 || !selectedLayout) return { sheets: [] as SheetLayout[], skippedCount: 0 };
    const dpi = 300;
    const canvasW = selectedLayout.canvas?.width || 1200;
    const canvasH = selectedLayout.canvas?.height || 1800;
    const itemSizes = canvases.map(() => ({ wIn: canvasW / dpi, hIn: canvasH / dpi }));
    return computeImpositionLayout(impositionSettings, itemSizes);
  }, [impositionSettings, canvases.length, selectedLayout]);

  useEffect(() => {
    const canvas = impositionPreviewRef.current;
    const { sheets: previewSheets } = impositionResult;
    if (!canvas || previewSheets.length === 0 || !showImpositionModal) return;

    const sheetIdx = Math.min(previewSheetIdx, previewSheets.length - 1);
    const sheet = previewSheets[sheetIdx];
    if (!sheet) return;

    const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);

    const maxW = 520;
    const maxH = 340;
    const scale = Math.min(maxW / sheetWIn, maxH / sheetHIn);
    const pw = Math.round(sheetWIn * scale);
    const ph = Math.round(sheetHIn * scale);

    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d')!;

    // Sheet background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pw, ph);

    // Margin area (subtle)
    const marginIn = impositionSettings.marginMm / MM_TO_IN;
    const mPx = marginIn * scale;
    ctx.fillStyle = '#f8fafc'; // slate-50
    ctx.fillRect(0, 0, pw, ph);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mPx, mPx, pw - 2 * mPx, ph - 2 * mPx);

    // Dashed margin boundary
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#e2e8f0'; // slate-200
    ctx.lineWidth = 1;
    ctx.strokeRect(mPx, mPx, pw - 2 * mPx, ph - 2 * mPx);
    ctx.setLineDash([]);

    // Sheet border
    ctx.strokeStyle = '#94a3b8'; // slate-400
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, pw, ph);

    // Draw placed items — load thumbnails async
    let aborted = false;
    const drawItems = async () => {
      for (const item of sheet.items) {
        if (aborted) return;
        const px = item.x * scale;
        const py = item.y * scale;
        const iw = item.w * scale;
        const ih = item.h * scale;

        // Placeholder rect
        ctx.fillStyle = '#eef2ff'; // indigo-50
        ctx.fillRect(px, py, iw, ih);
        ctx.strokeStyle = '#a5b4fc'; // indigo-300
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, iw, ih);

        // Draw thumbnail (cached)
        const c = canvases[item.canvasIdx];
        if (c?.dataUrl) {
          try {
            let img = previewImgCache.current.get(c.dataUrl);
            if (!img || !img.complete) {
              img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = reject;
                image.src = c.dataUrl!;
              });
              previewImgCache.current.set(c.dataUrl, img);
            }
            if (aborted) return;
            if (item.rotated) {
              ctx.save();
              ctx.translate(px + iw / 2, py + ih / 2);
              ctx.rotate(-Math.PI / 2);
              ctx.drawImage(img, -ih / 2, -iw / 2, ih, iw);
              ctx.restore();
            } else {
              ctx.drawImage(img, px, py, iw, ih);
            }
          } catch { /* skip failed thumbnail */ }
        }

        // Crop marks — proportional to export (5mm mark, 2mm offset)
        const markLen = (5 / MM_TO_IN) * scale;
        const offset = (2 / MM_TO_IN) * scale;
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 0.5;
        const corners = [
          [px, py, -1, -1], [px + iw, py, 1, -1],
          [px, py + ih, -1, 1], [px + iw, py + ih, 1, 1]
        ];
        for (const [cx, cy, dx, dy] of corners) {
          ctx.beginPath(); ctx.moveTo(cx, cy + dy * offset); ctx.lineTo(cx, cy + dy * (offset + markLen)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + dx * offset, cy); ctx.lineTo(cx + dx * (offset + markLen), cy); ctx.stroke();
        }
      }
    };
    drawItems();

    return () => { aborted = true; };
  }, [impositionResult, previewSheetIdx, impositionSettings, canvases, showImpositionModal]);

  const getFileUrl = useCallback((file: File): string => {
    let url = fileUrlCache.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      fileUrlCache.current.set(file, url);
    }
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

  // Cleanup object URLs and pending timers on unmount
  useEffect(() => {
    return () => {
      fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
      fileUrlCache.current.clear();
      imgCache.current.clear();
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    };
  }, []);

  // Redirect to login if unauthenticated
  useEffect(() => {
    if (status === 'unauthenticated') {
      import('next/navigation').then(({ redirect }) => redirect('/login'));
    }
  }, [status]);

  // Handle Browser Back/Forward Navigation
  useEffect(() => {
    const handlePopState = () => {
      if (layouts.length === 0) return;
      const searchParams = new URLSearchParams(window.location.search);
      const layoutId = searchParams.get('layout');
      const canvasIdxParam = searchParams.get('canvas');

      // Sync Layout
      if (layoutId) {
        const found = layouts.find(l => l.id === layoutId);
        if (found && found.id !== selectedLayout?.id) setSelectedLayout(found);
      } else if (selectedLayout !== null) {
        setSelectedLayout(null);
        setFiles([]);
        setCanvases([]);
      }

      // Sync Editor
      if (canvasIdxParam === null && activeCanvasIdx !== null) {
        // Closed via back button
        setActiveCanvasIdx(null);
        setEditingCanvas(null);
      }
    };
    
    handlePopState();
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [layouts, selectedLayout, activeCanvasIdx]);

  // Auto-restore editor state from URL if canvases are ready
  useEffect(() => {
    if (canvases.length > 0 && activeCanvasIdx === null) {
      const searchParams = new URLSearchParams(window.location.search);
      const canvasIdxParam = searchParams.get('canvas');
      
      if (canvasIdxParam !== null) {
        const idx = parseInt(canvasIdxParam);
        if (idx >= 0 && idx < canvases.length) {
          // Found it! Restore without pushing to history (since it's already in the URL)
          setActiveCanvasIdx(idx);
          const canvas = canvases[idx];
          setEditingCanvas({
            ...canvas,
            frames: canvas.frames.map(f => ({
              ...f,
              offset: { ...f.offset }
            }))
          });
        }
      }
    }
  }, [canvases, activeCanvasIdx]);

  const fitToScreen = useCallback(() => {
    if (!workspaceRef.current || !selectedLayout?.canvas) return;
    const container = workspaceRef.current;
    const pad = 100; // Padding for safety
    const availW = container.clientWidth - pad;
    const availH = container.clientHeight - pad;
    
    const stageW = 800; // Our fixed reference width
    const canvasRefW = selectedLayout.canvas.width || 1200;
    const canvasRefH = selectedLayout.canvas.height || 1800;
    const stageH = stageW / (canvasRefW / canvasRefH);
    
    const zoomW = availW / stageW;
    const zoomH = availH / stageH;
    
    // Choose the smaller zoom to fit both dimensions
    const newZoom = Math.min(zoomW, zoomH, 1.2); 
    setViewZoom(newZoom);
  }, [selectedLayout]);

  useEffect(() => {
    if (activeCanvasIdx !== null) {
      // Small timeout to ensure container is rendered and has size
      const timer = setTimeout(fitToScreen, 50);
      window.addEventListener('resize', fitToScreen);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('resize', fitToScreen);
      };
    }
  }, [activeCanvasIdx, fitToScreen]);

  const handleSelectLayout = (layout: any | null) => {
    setSelectedLayout(layout);
    if (layout) {
      window.history.pushState({}, '', '?layout=' + layout.id);
    } else {
      // Clear EVERYTHING from the URL and state
      window.history.pushState({}, '', window.location.pathname);
      setFiles([]);
      setCanvases([]);
    }
  };

  const fetchLayouts = useCallback(async () => {
    setIsFetchingLayouts(true);
    try {
      const res = await fetch('/api/layouts', {
        headers: { Authorization: `Bearer ${session?.accessToken}`, 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const layoutDetails = (data.layouts || []).map((item: any) => {
          if (typeof item === 'string') {
            return { id: item, name: item, width: 0, height: 0, frames: [] };
          }
          return {
            id: item.name,
            name: item.name, // Show only name for consistency
            dimensions: item.canvas?.widthMm && item.canvas?.heightMm
              ? `${item.canvas.widthMm.toFixed(2)}x${item.canvas.heightMm.toFixed(2)}mm`
              : null,
            height: item.canvas?.height || 0,
            canvas: item.canvas || {},
            frames: item.frames || [],
            tags: item.tags || [],
            maskUrl: item.maskUrl || null,
            maskOnExport: item.maskOnExport ?? false,
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null,
            createdBy: item.createdBy || 'System',
            updatedBy: item.updatedBy || 'System',
            metadata: item.metadata || [],
          };
        });
        setLayouts(layoutDetails);
      }
    } catch (err) {
      setError('Failed to load layouts');
    } finally {
      setIsFetchingLayouts(false);
    }
  }, [session?.accessToken]);

  // Fetch layouts on mount
  useEffect(() => {
    if (session?.accessToken) {
      fetchLayouts();
    }
  }, [session?.accessToken, fetchLayouts]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      // Revoke old object URLs and clear caches before loading new files
      fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
      fileUrlCache.current.clear();
      imgCache.current.clear();

      setCanvases([]);
      setFiles(Array.from(e.target.files));
    }
  };

  const renderCanvas = useCallback(async (canvasItem: CanvasItem, excludeFrameIdx: number | null = null, isExport = false, includeMask = true) => {
    const canvas = document.createElement('canvas');
    canvas.width = selectedLayout.canvas?.width || 1200;
    canvas.height = selectedLayout.canvas?.height || 1800;
    const ctx = canvas.getContext('2d')!;

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const frames = selectedLayout.frames?.length > 0 
      ? selectedLayout.frames 
      : [{ x: 0, y: 0, width: canvas.width, height: canvas.height }];

    for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
      if (excludeFrameIdx !== null && frameIdx === excludeFrameIdx) continue;
      const frameSpec = frames[frameIdx];
      const frameState = canvasItem.frames[frameIdx];
      if (!frameState) continue;

      // If values are <= 1, assume they are percentages and scale by pixel dimensions
      const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
      const fx = isPercent ? frameSpec.x * canvas.width : frameSpec.x;
      const fy = isPercent ? frameSpec.y * canvas.height : frameSpec.y;
      const fw = isPercent ? frameSpec.width * canvas.width : frameSpec.width;
      const fh = isPercent ? frameSpec.height * canvas.height : frameSpec.height;

      const imgSource = frameState.processedUrl || getFileUrl(frameState.originalFile);
      const img = await loadImage(imgSource);

      // Fit mode: 'contain' shows full image, 'cover' fills frame
      const baseScale = frameState.fitMode === 'cover'
        ? Math.max(fw / img.width, fh / img.height)
        : Math.min(fw / img.width, fh / img.height);
      const finalScale = baseScale * frameState.scale;

      const w = img.width * finalScale;
      const h = img.height * finalScale;
      const x = fx + (fw - w) / 2 + frameState.offset.x;
      const y = fy + (fh - h) / 2 + frameState.offset.y;

      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, fy, fw, fh);
      ctx.clip();
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
    }

    // Mask
    const shouldIncludeMask = includeMask || (isExport && selectedLayout.maskOnExport);
    if (selectedLayout.maskUrl && shouldIncludeMask) {
      try {
        const maskImg = await loadImage(selectedLayout.maskUrl);
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        console.warn("Mask drawing failed", err);
      }
    }

    return canvas.toDataURL('image/png');
  }, [selectedLayout, getFileUrl, loadImage]);

  const generateCanvases = useCallback(async () => {
    if (!selectedLayout || files.length === 0) return;

    setIsProcessing(true);
    setError(null);

    try {
      const frameCount = selectedLayout.frames?.length || 1;
      const canvasCount = Math.ceil(files.length / frameCount);
      const newCanvases: CanvasItem[] = [];

      for (let i = 0; i < canvasCount; i++) {
        const canvasFrames: FrameState[] = [];
        for (let f = 0; f < frameCount; f++) {
          const fileIdx = (i * frameCount + f) % files.length;
          const file = files[fileIdx];
          if (file) {
            canvasFrames.push({
              id: f,
              originalFile: file,
              processedUrl: null,
              offset: { x: 0, y: 0 },
              scale: 1,
              fitMode: globalFitMode,
              isRemovingBg: false,
              isDetectingProduct: false
            });
          }
        }

        const item: CanvasItem = {
          id: i,
          frames: canvasFrames,
          dataUrl: null
        };
        
        item.dataUrl = await renderCanvas(item);
        newCanvases.push(item);
      }

      setCanvases(newCanvases);
    } catch (err) {
      console.error(err);
      setError('Failed to process images');
    } finally {
      setIsProcessing(false);
    }
  }, [selectedLayout, files, renderCanvas, globalFitMode]);

  // Trigger generation automatically when files or layout changes
  useEffect(() => {
    if (selectedLayout && files.length > 0) {
      generateCanvases();
    }
  }, [selectedLayout, files, generateCanvases]);

  // Re-render all canvases when bulk fitMode changes (preserves transforms)
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
    // Only re-render when globalFitMode changes — canvases are already updated with new fitMode by the toggle handler
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFitMode]);

  const openEditor = (idx: number) => {
    const canvas = canvases[idx];
    if (!canvas) return;
    setActiveCanvasIdx(idx);
    
    // Push new history state so Back button closes the editor
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.set('canvas', idx.toString());
    window.history.pushState({}, '', '?' + searchParams.toString());

    // Deepish copy to preserve File objects and other non-JSON data
    setEditingCanvas({
      ...canvas,
      frames: canvas.frames.map(f => ({
        ...f,
        offset: { ...f.offset }
      }))
    });
  };

  const closeEditor = () => {
    setActiveCanvasIdx(null);
    setEditingCanvas(null);
    // If we're still on a canvas-specific URL, go back to the layout-only URL
    const params = new URLSearchParams(window.location.search);
    if (params.has('canvas')) {
      params.delete('canvas');
      const newUrl = params.toString() ? '?' + params.toString() : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  };

  const handleSaveChanges = async () => {
    if (activeCanvasIdx === null || !editingCanvas) return;

    // Flush any pending debounced render so the saved preview is up to date
    if (renderTimeoutRef.current) {
      clearTimeout(renderTimeoutRef.current);
      renderTimeoutRef.current = null;
    }
    const freshDataUrl = await renderCanvas(editingCanvas);
    const finalCanvas = { ...editingCanvas, dataUrl: freshDataUrl };

    const updatedCanvases = [...canvases];
    updatedCanvases[activeCanvasIdx] = finalCanvas;
    setCanvases(updatedCanvases);
    closeEditor();
  };

  const handleRemoveBackground = async (canvasIdx: number, frameIdx: number) => {
    if (!editingCanvas || editingCanvas.frames[frameIdx].isRemovingBg) return;

    // Abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    // Immutable update to show loading state
    setEditingCanvas(prev => {
      if (!prev) return prev;
      return { ...prev, frames: prev.frames.map((f, i) => i === frameIdx ? { ...f, isRemovingBg: true } : f) };
    });

    try {
      const formData = new FormData();
      formData.append('image', editingCanvas.frames[frameIdx].originalFile);

      const res = await fetch('/api/ai/remove-background', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.accessToken}` },
        body: formData,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const imageUrl = `/api/exports/${data.processed_image}`;

        // Use functional updater to merge into LATEST state (not stale closure)
        // This preserves any transform changes the user made while BG removal was in-flight
        let updatedCanvas: CanvasItem | null = null;
        setEditingCanvas(prev => {
          if (!prev) return prev;
          updatedCanvas = {
            ...prev,
            frames: prev.frames.map((f, i) =>
              i === frameIdx ? { ...f, processedUrl: imageUrl, isRemovingBg: false } : f
            )
          };
          return updatedCanvas;
        });

        // Re-render preview with the merged state
        if (updatedCanvas) {
          const dataUrl = await renderCanvas(updatedCanvas);
          setEditingCanvas(p => p ? { ...p, dataUrl } : p);
        }
      } else {
        throw new Error('Server returned an error');
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error('BG Removal failed', err);
      // Use functional updater to reset only the loading flag, preserving latest transforms
      setEditingCanvas(prev => {
        if (!prev) return prev;
        return { ...prev, frames: prev.frames.map((f, i) => i === frameIdx ? { ...f, isRemovingBg: false } : f) };
      });

      if (err.name === 'AbortError') {
        setError('Background removal timed out after 60 seconds. Please try again.');
      } else {
        setError('Failed to remove background. The AI service might be busy.');
      }
    }
  };

  const handleUpdateTransform = (canvasIdx: number, frameIdx: number, updates: Partial<FrameState['offset'] & { scale: number }>) => {
    if (!editingCanvas) return;

    // Immutable update to ensure React detects changes
    const newFrames = editingCanvas.frames.map((f, i) => {
      if (i !== frameIdx) return f;
      const updatedFrame = { ...f, offset: { ...f.offset } };
      if ('scale' in updates) updatedFrame.scale = updates.scale!;
      if ('x' in updates) updatedFrame.offset.x = Math.abs(updates.x!) < 8 ? 0 : updates.x!;
      if ('y' in updates) updatedFrame.offset.y = Math.abs(updates.y!) < 8 ? 0 : updates.y!;
      return updatedFrame;
    });

    const finalized = { ...editingCanvas, frames: newFrames };

    // Update sidebar values immediately (no lag on slider/input)
    setEditingCanvas(finalized);

    // Debounce the expensive canvas render — only fires after 80ms of no changes
    if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    const gen = ++renderGenRef.current;
    renderTimeoutRef.current = setTimeout(async () => {
      const dataUrl = await renderCanvas(finalized);
      // Only apply if no newer render was requested
      if (renderGenRef.current === gen) {
        setEditingCanvas(prev => prev ? { ...prev, dataUrl } : prev);
      }
    }, 80);
  };

  const handleDragStart = (e: React.MouseEvent, canvasIdx: number) => {
    if (activeCanvasIdx === null) return;
    const container = e.currentTarget.getBoundingClientRect();
    const canvasW = selectedLayout.canvas?.width || 1200;
    const canvasH = selectedLayout.canvas?.height || 1800;
    
    // Calculate the ratio between the internal canvas units and DOM pixels
    const containerRatio = canvasW / container.width;

    // Find the closest frame to the click
    const rect = container;
    const x = (e.clientX - rect.left) * containerRatio;
    const y = (e.clientY - rect.top) * containerRatio;

    let closestFrameIdx = 0;
    let minSnapDist = Infinity;

    selectedLayout.frames.forEach((f: any, i: number) => {
      const fx = (f.width <= 1 ? f.x * canvasW : f.x);
      const fy = (f.height <= 1 ? f.y * canvasH : f.y);
      const fw = (f.width <= 1 ? f.width * canvasW : f.width);
      const fh = (f.height <= 1 ? f.height * canvasH : f.height);
      
      const centerX = fx + fw / 2;
      const centerY = fy + fh / 2;
      const dist = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
      if (dist < minSnapDist) {
        minSnapDist = dist;
        closestFrameIdx = i;
      }
    });

    const frameSpec = selectedLayout.frames[closestFrameIdx];
    // Use editingCanvas (live editor state) — not canvases[] which is the last-saved state
    const frameState = (editingCanvas || canvases[canvasIdx]).frames[closestFrameIdx];
    
    const fx = (frameSpec.width <= 1 ? frameSpec.x * canvasW : frameSpec.x);
    const fy = (frameSpec.height <= 1 ? frameSpec.y * canvasH : frameSpec.y);
    const fw = (frameSpec.width <= 1 ? frameSpec.width * canvasW : frameSpec.width);
    const fh = (frameSpec.height <= 1 ? frameSpec.height * canvasH : frameSpec.height);

    // Use the same image source as renderCanvas (processed if available, else original)
    const imgUrl = frameState.processedUrl || getFileUrl(frameState.originalFile);
    const imgSize = imgCache.current.get(imgUrl);

    if (imgSize) {
      // Must match renderCanvas fit mode math
      const baseScale = frameState.fitMode === 'cover'
        ? Math.max(fw / imgSize.width, fh / imgSize.height)
        : Math.min(fw / imgSize.width, fh / imgSize.height);
      const finalScale = baseScale * frameState.scale;

      setDragState({
        canvasIdx,
        frameIdx: closestFrameIdx,
        startX: e.clientX,
        startY: e.clientY,
        initialX: frameState.offset.x,
        initialY: frameState.offset.y,
        containerRatio,
        frameRect: { fx, fy, fw, fh },
        imgRect: { w: imgSize.width * finalScale, h: imgSize.height * finalScale }
      });
      setActiveDragFrameUrl(imgUrl);
    }
  };

  const handleDragMove = (e: React.MouseEvent) => {
    if (!dragState) return;

    // Capture coords BEFORE RAF — React may recycle the synthetic event
    const clientX = e.clientX;
    const clientY = e.clientY;

    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);

    rafIdRef.current = requestAnimationFrame(() => {
      const dx = (clientX - dragState.startX) * dragState.containerRatio;
      const dy = (clientY - dragState.startY) * dragState.containerRatio;
      
      const newX = dragState.initialX + dx;
      const newY = dragState.initialY + dy;
      
      tempOffsetRef.current = { x: newX, y: newY };
      
      const overlay = document.querySelector('.active-drag-overlay img') as HTMLImageElement;
      if (overlay) {
        // Use the same sliding-image logic for live updates
        overlay.style.transform = `translate(${((dragState.frameRect.fw - dragState.imgRect.w) / 2 + newX) / dragState.containerRatio}px, ${((dragState.frameRect.fh - dragState.imgRect.h) / 2 + newY) / dragState.containerRatio}px)`;
      }
    });
  };

  const handleDragEnd = () => {
    // Cancel any pending animation frame to prevent stale reads
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
    // Guard: both onMouseUp and onMouseLeave can fire — only process once
    if (!dragState) return;
    handleUpdateTransform(dragState.canvasIdx, dragState.frameIdx, tempOffsetRef.current);
    setDragState(null);
    setActiveDragFrameUrl(null);
  };

  const executeImposition = async () => {
    setIsImposing(true);
    try {
      const dpi = 300;
      const canvasW = selectedLayout.canvas?.width || 1200;
      const canvasH = selectedLayout.canvas?.height || 1800;
      const itemSizes = canvases.map(() => ({ wIn: canvasW / dpi, hIn: canvasH / dpi }));
      const { sheets: layout, skippedCount } = computeImpositionLayout(impositionSettings, itemSizes);

      if (layout.length === 0) {
        setError('No canvases fit on the selected sheet. Try increasing sheet size or decreasing margins.');
        return;
      }

      if (skippedCount > 0) {
        setError(`${skippedCount} canvas${skippedCount > 1 ? 'es were' : ' was'} too large for the sheet and skipped.`);
      }

      const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
      const sheetW = Math.round(sheetWIn * dpi);
      const sheetH = Math.round(sheetHIn * dpi);

      // Re-render all canvases for export
      const canvasImages = await Promise.all(canvases.map(async (c) => {
        const dataUrl = await renderCanvas(c, null, true);
        const img = await loadImage(dataUrl);
        return img;
      }));

      const drawCropMarks = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
        const markSize = Math.round((5 / MM_TO_IN) * dpi);
        const offset = Math.round((2 / MM_TO_IN) * dpi);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        const corners = [
          [x, y, -1, -1], [x + w, y, 1, -1],
          [x, y + h, -1, 1], [x + w, y + h, 1, 1]
        ];
        for (const [cx, cy, dx, dy] of corners) {
          ctx.beginPath(); ctx.moveTo(cx, cy + dy * offset); ctx.lineTo(cx, cy + dy * (offset + markSize)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + dx * offset, cy); ctx.lineTo(cx + dx * (offset + markSize), cy); ctx.stroke();
        }
      };

      const sheetBlobs: { name: string; blob: Blob }[] = [];

      for (let si = 0; si < layout.length; si++) {
        const sheet = layout[si];
        const canvas = document.createElement('canvas');
        canvas.width = sheetW;
        canvas.height = sheetH;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, sheetW, sheetH);

        for (const item of sheet.items) {
          const img = canvasImages[item.canvasIdx];
          const px = Math.round(item.x * dpi);
          const py = Math.round(item.y * dpi);
          const pw = Math.round(item.w * dpi);
          const ph = Math.round(item.h * dpi);

          if (item.rotated) {
            ctx.save();
            ctx.translate(px + pw / 2, py + ph / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.drawImage(img, -ph / 2, -pw / 2, ph, pw);
            ctx.restore();
          } else {
            ctx.drawImage(img, px, py, pw, ph);
          }
          drawCropMarks(ctx, px, py, pw, ph);
        }

        const blob = await new Promise<Blob>((resolve) => canvas.toBlob(b => resolve(b!), 'image/png'));
        sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob });
        // Release memory
        ctx.clearRect(0, 0, sheetW, sheetH);
        canvas.width = 0;
        canvas.height = 0;
      }

      if (sheetBlobs.length === 1) {
        downloadBlob(sheetBlobs[0].blob, sheetBlobs[0].name);
      } else {
        const zipData = sheetBlobs.map(sb => ({
          name: sb.name,
          url: URL.createObjectURL(sb.blob)
        }));
        const zipBlob = await createZipFromDataUrls(zipData);
        downloadBlob(zipBlob, `imposition-sheets.zip`);
        zipData.forEach(z => URL.revokeObjectURL(z.url));
      }
    } catch (err) {
      console.error("Imposition failed", err);
      setError('Imposition failed. Please try again.');
    } finally {
      setIsImposing(false);
      setShowImpositionModal(false);
    }
  };

  const handleDownloadAll = async () => {
    if (canvases.length === 0) return;
    setShowDownloadModal(true);
  };

  const executeBatchDownload = async () => {
    setIsDownloading(true);
    try {
      if (canvases.length === 1) {
        const link = document.createElement('a');
        link.href = canvases[0].dataUrl!;
        link.download = `${selectedLayout.id}-canvas.png`;
        link.click();
      } else {
        const images = canvases.map((c, i) => ({
          name: `${selectedLayout.id}-canvas-${i + 1}.png`,
          url: c.dataUrl!
        }));
        const blob = await createZipFromDataUrls(images);
        downloadBlob(blob, `${selectedLayout.id}-canvases.zip`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed. Please try again.');
    } finally {
      setIsDownloading(false);
      setShowDownloadModal(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  const hasCanvasParam = new URLSearchParams(window.location.search).has('canvas');

  return (
    <div className="min-h-screen bg-slate-50/50 flex flex-col">
      <Header />

      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-[200000] max-w-sm bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <main className="w-full px-8 py-8 flex-1">
        <div className="max-w-6xl mx-auto space-y-8">
          {!selectedLayout ? (
              <div>
                <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900">Select a Product Template</h1>
                    <p className="text-slate-500 mt-1">Choose a layout to upload images and generate print canvases.</p>
                  </div>
                  <div className="relative w-full md:w-80 group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                    <input 
                      type="text"
                      placeholder="Search layouts or tags..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-sm"
                    />
                  </div>
                </div>
                {isFetchingLayouts ? (
                  <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-indigo-600" /></div>
                ) : layouts.length === 0 ? (
                  <div className="text-center py-20 text-slate-500 bg-white rounded-2xl border shadow-sm">No layouts found. Create one in the Layout Editor.</div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                    {layouts
                      .filter(layout => {
                        const q = searchQuery.toLowerCase();
                        return layout.name.toLowerCase().includes(q) || 
                               (layout.tags && layout.tags.some((t: string) => t.toLowerCase().includes(q)));
                      })
                      .map(layout => (
                      <div 
                        key={layout.id}
                        onClick={() => handleSelectLayout(layout)}
                        className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer overflow-hidden group"
                      >
                        <LayoutPreview layout={layout} />
                        <div className="p-4 flex flex-col items-center">
                          <h3 className="font-bold text-slate-800 text-sm truncate w-full text-center capitalize">{(layout.name || '').replace(/_/g, ' ')}</h3>
                          <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 font-medium">
                            {layout.dimensions && <span className="text-slate-400 font-mono text-[10px]">{layout.dimensions}</span>}
                            {layout.dimensions && <span>&middot;</span>}
                            <span>{layout.frames.length} Frame{layout.frames.length !== 1 && 's'}</span>
                            {layout.createdAt && (
                              <>
                                <span>&middot;</span>
                                <span className="text-[10px] text-slate-400">{new Date(layout.createdAt).toLocaleDateString()}</span>
                              </>
                            )}
                          </div>
                          {layout.tags && layout.tags.length > 0 && (
                            <div className="flex flex-wrap justify-center gap-1 mt-2.5">
                              {layout.tags.slice(0, 3).map((t: string) => (
                                <span key={t} className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[9px] rounded-full font-bold uppercase tracking-wide">{t}</span>
                              ))}
                              {layout.tags.length > 3 && (
                                <span className="px-1.5 py-0.5 text-slate-400 text-[9px] font-bold">+{layout.tags.length - 3}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-col lg:flex-row items-stretch justify-between gap-8 mb-10">
                  {/* Left Side: Metadata & Title */}
                  <div className="flex-1 flex flex-col justify-center">
                    <button onClick={() => { handleSelectLayout(null); setFiles([]); setCanvases([]); }} className="text-xs text-slate-400 font-bold hover:text-indigo-600 flex items-center mb-4 uppercase tracking-widest transition-colors">
                      ← Back to Templates
                    </button>
                    
                    <div className="space-y-4">
                      <div className="flex items-start justify-between sm:justify-start sm:gap-4">
                        <h1 className="text-3xl font-black text-slate-900 tracking-tight leading-none uppercase">
                          {selectedLayout.name}
                        </h1>
                      </div>

                      {selectedLayout.tags && selectedLayout.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {selectedLayout.tags.map((t: string) => (
                            <span key={t} className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-[9px] rounded-md font-black uppercase tracking-widest border border-indigo-100/50">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-bold text-slate-400">
                        <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-lg text-slate-600">
                          <Layers className="w-3 h-3" />
                          <span>{selectedLayout.frames.length} Frame{selectedLayout.frames.length !== 1 && 's'}</span>
                        </div>
                        {selectedLayout.createdAt && (
                          <div className="flex items-center gap-1.5 border border-slate-200 px-2.5 py-1 rounded-lg">
                            <span className="text-slate-300">Created:</span>
                            <span className="text-slate-500">{new Date(selectedLayout.createdAt).toLocaleDateString()}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 border border-slate-200 px-2.5 py-1 rounded-lg">
                          <span className="text-slate-300">Author:</span>
                          <span className="text-slate-500">{selectedLayout.createdBy || 'System'}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Side: Compact Upload Area */}
                  <div className="w-full lg:w-[420px]">
                    <div 
                      className={clsx(
                        "relative h-full flex flex-col items-center justify-center border-2 border-dashed rounded-[2rem] p-6 lg:p-8 transition-all group overflow-hidden",
                        files.length > 0 ? "border-emerald-100 bg-emerald-50/20" : 
                        (hasCanvasParam ? "border-amber-200 bg-amber-50/50" : "border-slate-200 hover:border-indigo-400 hover:bg-slate-50 cursor-pointer")
                      )}
                    >
                      <input
                        type="file"
                        multiple
                        onChange={handleFileChange}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                        accept="image/*"
                      />
                      
                      <div className="flex items-center gap-5">
                        <div className={clsx(
                          "w-14 h-14 rounded-2xl shadow-sm flex items-center justify-center transition-transform group-hover:scale-110",
                          files.length > 0 ? "bg-emerald-500 text-white" : 
                          (hasCanvasParam ? "bg-amber-500 text-white" : "bg-white text-indigo-600")
                        )}>
                          <Upload className="w-6 h-6" />
                        </div>
                        <div className="text-left">
                          {files.length > 0 ? (
                            <>
                              <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">Images Loaded</h2>
                              <div className="flex items-center gap-1.5 text-emerald-600 text-xs font-bold mt-0.5">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {files.length} photos selected
                              </div>
                            </>
                          ) : (
                            <>
                              <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">
                                {hasCanvasParam ? "Restore Session" : "Upload Photos"}
                              </h2>
                              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1 group-hover:text-indigo-500 transition-colors">
                                {hasCanvasParam ? "Re-upload photos to continue editing" : "Click or drag here"}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Results Section */}
                {canvases.length > 0 && (
                  <section className="space-y-6 pt-8 border-t">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <h2 className="text-xl font-bold text-slate-900">Generated Canvases</h2>
                        <span className="px-2.5 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded-full">{canvases.length}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {isProcessing && <div className="flex items-center gap-2 text-xs text-slate-500 font-medium animate-pulse"><Loader2 className="w-3 h-3 animate-spin"/> Updating...</div>}
                        <div className="flex items-center bg-slate-100 rounded-xl p-0.5">
                          <button
                            onClick={() => {
                              setGlobalFitMode('contain');
                              setCanvases(prev => prev.map(c => ({
                                ...c,
                                frames: c.frames.map(f => ({ ...f, fitMode: 'contain' as FitMode }))
                              })));
                            }}
                            className={clsx(
                              "px-3 py-1.5 text-xs font-bold rounded-lg transition-all",
                              globalFitMode === 'contain' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                            )}
                            title="Show full image (may have empty space)"
                          >
                            Fit
                          </button>
                          <button
                            onClick={() => {
                              setGlobalFitMode('cover');
                              setCanvases(prev => prev.map(c => ({
                                ...c,
                                frames: c.frames.map(f => ({ ...f, fitMode: 'cover' as FitMode }))
                              })));
                            }}
                            className={clsx(
                              "px-3 py-1.5 text-xs font-bold rounded-lg transition-all",
                              globalFitMode === 'cover' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                            )}
                            title="Fill frame (may crop edges)"
                          >
                            Cover
                          </button>
                        </div>
                        <button
                          onClick={handleDownloadAll}
                          className="flex items-center gap-2 text-sm font-bold text-white bg-slate-900 px-5 py-2.5 rounded-xl hover:bg-slate-800 transition-all shadow-lg shadow-slate-200"
                        >
                          <Archive className="w-4 h-4" />
                          Download Results
                        </button>
                      </div>
                    </div>
   
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                      {canvases.map((canvas, idx) => (
                        <div 
                          key={idx} 
                          className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-indigo-200 transition-all group cursor-zoom-in"
                          onClick={() => openEditor(idx)}
                        >
                          <div 
                            className="relative rounded-t-2xl overflow-hidden bg-slate-50 border-b"
                            style={{ 
                              aspectRatio: `${selectedLayout.canvas?.width || 1200} / ${selectedLayout.canvas?.height || 1800}`
                            }}
                          >
                            {canvas.dataUrl && (
                              <img 
                                src={canvas.dataUrl} 
                                loading="lazy" 
                                decoding="async" 
                                className="absolute inset-0 w-full h-full object-fill" 
                                alt={`Result ${idx + 1}`} 
                              />
                            )}
                            {selectedLayout.maskUrl && (
                              <img
                                src={selectedLayout.maskUrl}
                                className="absolute inset-0 w-full h-full object-fill pointer-events-none z-10"
                                alt="Mask Overlay"
                              />
                            )}
                            <div className="absolute inset-0 z-20 bg-slate-900/0 group-hover:bg-slate-900/40 transition-all flex items-center justify-center">
                              <Maximize2 className="w-8 h-8 text-white scale-50 opacity-0 group-hover:scale-100 group-hover:opacity-100 transition-all duration-300" />
                            </div>
                          </div>
                          <div className="p-3 flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-500 uppercase tracking-tight">Canvas {idx + 1}</span>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const currentMode = canvas.frames[0]?.fitMode || 'contain';
                                  const newMode: FitMode = currentMode === 'contain' ? 'cover' : 'contain';
                                  const updatedCanvas = {
                                    ...canvas,
                                    frames: canvas.frames.map(f => ({ ...f, fitMode: newMode }))
                                  };
                                  const dataUrl = await renderCanvas(updatedCanvas);
                                  const updated = [...canvases];
                                  updated[idx] = { ...updatedCanvas, dataUrl };
                                  setCanvases(updated);
                                }}
                                className={clsx(
                                  "px-2 py-1 text-[10px] font-bold rounded-md transition-all border",
                                  (canvas.frames[0]?.fitMode || 'contain') === 'contain'
                                    ? "bg-indigo-50 text-indigo-600 border-indigo-200"
                                    : "bg-amber-50 text-amber-600 border-amber-200"
                                )}
                                title={(canvas.frames[0]?.fitMode || 'contain') === 'contain' ? "Currently: Fit (click for Cover)" : "Currently: Cover (click for Fit)"}
                              >
                                {(canvas.frames[0]?.fitMode || 'contain') === 'contain' ? 'Fit' : 'Cover'}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const link = document.createElement('a');
                                  link.href = canvas.dataUrl!;
                                  link.download = `${selectedLayout.id}-canvas-${idx + 1}.png`;
                                  link.click();
                                }}
                                className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                                title="Download"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
   

                {/* Download Choice Modal */}
                {showDownloadModal && (
                  <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setShowDownloadModal(false)} />
                    <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl p-8 animate-in zoom-in-95">
                      <div className="text-center mb-8">
                        <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                          <Archive className="w-8 h-8" />
                        </div>
                        <h3 className="text-2xl font-bold text-slate-900">Prepare Your Download</h3>
                        <p className="text-slate-500 mt-2">How would you like to process your {canvases.length} canvases?</p>
                      </div>

                      <div className="grid gap-4">
                        <button 
                          onClick={executeBatchDownload}
                          disabled={isDownloading}
                          className="flex items-center gap-4 p-5 rounded-2xl border-2 border-slate-100 hover:border-indigo-500 hover:bg-indigo-50/50 transition-all text-left group"
                        >
                          <div className="w-12 h-12 bg-white rounded-xl shadow-sm border flex items-center justify-center group-hover:bg-indigo-500 group-hover:text-white transition-colors">
                            <Archive className="w-6 h-6" />
                          </div>
                          <div className="flex-1">
                            <p className="font-bold text-slate-900">Download HQ PNGs</p>
                            <p className="text-xs text-slate-500">Fast zipping of individual canvases ({canvases.length} files)</p>
                          </div>
                        </button>

                        <button 
                          onClick={() => {
                            setShowDownloadModal(false);
                            setPreviewSheetIdx(0);
                            setShowImpositionModal(true);
                          }}
                          className="flex items-center gap-4 p-5 rounded-2xl border-2 border-slate-100 hover:border-emerald-500 hover:bg-emerald-50/50 transition-all text-left group"
                        >
                          <div className="w-12 h-12 bg-white rounded-xl shadow-sm border flex items-center justify-center group-hover:bg-emerald-500 group-hover:text-white transition-colors">
                            <FileText className="w-6 h-6" />
                          </div>
                          <div className="flex-1">
                            <p className="font-bold text-slate-900">Prepare Imposition</p>
                            <p className="text-xs text-slate-500">Generate a single large print-ready sheet with margins</p>
                          </div>
                        </button>
                      </div>

                      <button 
                        onClick={() => setShowDownloadModal(false)}
                        className="w-full mt-6 py-3 text-sm font-bold text-slate-400 hover:text-slate-600 transition-all text-center"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
        {/* Imposition Modal */}
        {showImpositionModal && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => !isImposing && setShowImpositionModal(false)} />
            <div className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl p-8 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h3 className="text-2xl font-bold text-slate-900">Imposition Settings</h3>
                  <p className="text-slate-500 text-sm mt-1">Configure your print-ready sheet layout</p>
                </div>
                <button onClick={() => setShowImpositionModal(false)} className="p-2 hover:bg-slate-100 rounded-full transition-all">
                  <X className="w-6 h-6 text-slate-400" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-8">
                <div className="space-y-6">
                  {/* Sheet Size */}
                  <div className="space-y-3">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Sheet Size</label>
                    <select 
                      value={impositionSettings.preset}
                      onChange={(e) => {
                        const val = e.target.value as ImpositionSettings['preset'];
                        const dims = PRESET_DIMENSIONS[val] || { w: impositionSettings.widthIn, h: impositionSettings.heightIn };
                        setImpositionSettings(prev => ({
                          ...prev,
                          preset: val,
                          widthIn: dims.w,
                          heightIn: dims.h
                        }));
                      }}
                      className="w-full p-3 bg-slate-50 border rounded-2xl text-sm font-semibold focus:ring-2 focus:ring-indigo-500/20"
                    >
                      <option value="a4">A4 (8.27" x 11.69")</option>
                      <option value="a3">A3 (11.69" x 16.54")</option>
                      <option value="12x18">12" x 18" (Standard Print)</option>
                      <option value="13x19">13" x 19" (Super B)</option>
                      <option value="custom">Custom Size (Inches)</option>
                    </select>
                  </div>

                  {impositionSettings.preset === 'custom' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <span className="text-[10px] text-slate-400 font-bold uppercase">Width (in)</span>
                        <input 
                          type="number" value={impositionSettings.widthIn} step="0.1"
                          onChange={(e) => setImpositionSettings(p => ({ ...p, widthIn: parseFloat(e.target.value) || 0 }))}
                          className="w-full p-2.5 border rounded-xl text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <span className="text-[10px] text-slate-400 font-bold uppercase">Height (in)</span>
                        <input 
                          type="number" value={impositionSettings.heightIn} step="0.1"
                          onChange={(e) => setImpositionSettings(p => ({ ...p, heightIn: parseFloat(e.target.value) || 0 }))}
                          className="w-full p-2.5 border rounded-xl text-sm"
                        />
                      </div>
                    </div>
                  )}

                  {/* Orientation */}
                  <div className="space-y-3">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Orientation</label>
                    <div className="flex p-1 bg-slate-100 rounded-xl">
                      <button 
                        onClick={() => setImpositionSettings(p => ({ ...p, orientation: 'portrait' }))}
                        className={clsx("flex-1 py-2 text-xs font-bold rounded-lg transition-all", impositionSettings.orientation === 'portrait' ? "bg-white shadow-sm text-indigo-600" : "text-slate-500 hover:text-slate-700")}
                      >
                        Portrait
                      </button>
                      <button 
                        onClick={() => setImpositionSettings(p => ({ ...p, orientation: 'landscape' }))}
                        className={clsx("flex-1 py-2 text-xs font-bold rounded-lg transition-all", impositionSettings.orientation === 'landscape' ? "bg-white shadow-sm text-indigo-600" : "text-slate-500 hover:text-slate-700")}
                      >
                        Landscape
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  {/* Margins */}
                  <div className="space-y-3">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Safety Margins (mm)</label>
                    <div className="flex items-center gap-4">
                      <input 
                        type="range" min="0" max="25" step="1"
                        value={impositionSettings.marginMm}
                        onChange={(e) => setImpositionSettings(p => ({ ...p, marginMm: parseInt(e.target.value) }))}
                        className="flex-1 accent-emerald-500"
                      />
                      <span className="text-sm font-bold text-slate-700 min-w-[40px]">{impositionSettings.marginMm}mm</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">Minimum 7mm recommended for printer grippers.</p>
                  </div>

                  {/* Gutter */}
                  <div className="space-y-3">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Image Gutter (mm)</label>
                    <div className="flex items-center gap-4">
                      <input 
                        type="range" min="0" max="20" step="1"
                        value={impositionSettings.gutterMm}
                        onChange={(e) => setImpositionSettings(p => ({ ...p, gutterMm: parseInt(e.target.value) }))}
                        className="flex-1 accent-emerald-500"
                      />
                      <span className="text-sm font-bold text-slate-700 min-w-[40px]">{impositionSettings.gutterMm}mm</span>
                    </div>
                  </div>

                  <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                    <p className="text-[10px] text-emerald-700 leading-relaxed font-medium">
                      Crop marks and registration black will be added automatically at every corner for precise trimming.
                    </p>
                  </div>
                </div>
              </div>

              {/* Live Preview */}
              {canvases.length > 0 && impositionResult.sheets.length > 0 && (
                <div className="mt-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">
                      Preview
                    </label>
                    {impositionResult.sheets.length > 1 && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setPreviewSheetIdx(i => Math.max(0, i - 1))}
                          disabled={previewSheetIdx === 0}
                          className="p-1 hover:bg-slate-100 rounded disabled:opacity-30 transition-all"
                        >
                          <ChevronRight className="w-4 h-4 rotate-180" />
                        </button>
                        <span className="text-xs font-bold text-slate-500">
                          Sheet {Math.min(previewSheetIdx, impositionResult.sheets.length - 1) + 1} of {impositionResult.sheets.length}
                        </span>
                        <button
                          onClick={() => setPreviewSheetIdx(i => Math.min(impositionResult.sheets.length - 1, i + 1))}
                          disabled={previewSheetIdx >= impositionResult.sheets.length - 1}
                          className="p-1 hover:bg-slate-100 rounded disabled:opacity-30 transition-all"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-center p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <canvas
                      ref={impositionPreviewRef}
                      className="border border-slate-200 shadow-sm rounded"
                      style={{ maxWidth: '100%', height: 'auto' }}
                    />
                  </div>
                  <p className="text-[10px] text-slate-400 text-center">
                    {impositionResult.sheets.reduce((sum, s) => sum + s.items.length, 0)} of {canvases.length} canvases placed across {impositionResult.sheets.length} sheet{impositionResult.sheets.length > 1 ? 's' : ''}
                    {impositionResult.skippedCount > 0 && (
                      <span className="text-amber-500 font-bold ml-1">
                        ({impositionResult.skippedCount} skipped — too large)
                      </span>
                    )}
                  </p>
                </div>
              )}

              <div className="mt-10 flex gap-4">
                <button
                  onClick={() => setShowImpositionModal(false)}
                  disabled={isImposing}
                  className="flex-1 py-4 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-2xl transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={executeImposition}
                  disabled={isImposing}
                  className="flex-[2] py-4 bg-emerald-600 text-white rounded-2xl font-bold hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-100 flex items-center justify-center gap-2"
                >
                  {isImposing ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Imposing Batch...
                    </>
                  ) : (
                    <>
                      <FileText className="w-5 h-5" />
                      Generate Print Sheet
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    )}
          </div>
        </main>

        {/* Editor Modal */}
        {activeCanvasIdx !== null && editingCanvas && (
          <div className="fixed inset-0 z-[100000] bg-white flex overflow-hidden animate-in fade-in duration-300">
            {/* Editor Sidebar */}
            <div className="w-80 border-r bg-slate-50 flex flex-col overflow-hidden">
              {/* Sidebar Top: Branding & Actions */}
              <div className="p-6 border-b bg-white">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-slate-900">Canvas Editor</h3>
                  <button onClick={closeEditor} className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-full transition-all">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="flex items-center justify-between bg-slate-50 p-2 rounded-xl border border-slate-100">
                  <button 
                    disabled={activeCanvasIdx === 0}
                    onClick={() => openEditor(activeCanvasIdx! - 1)}
                    className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all hover:bg-white rounded-lg"
                  >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                  </button>
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">Canvas</span>
                    <span className="text-xs font-bold text-indigo-600">{activeCanvasIdx + 1} / {canvases.length}</span>
                  </div>
                  <button 
                    disabled={activeCanvasIdx === canvases.length - 1}
                    onClick={() => openEditor(activeCanvasIdx! + 1)}
                    className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all hover:bg-white rounded-lg"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Sidebar Middle: Adjustment Controls */}
              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                {editingCanvas.frames.map((frame, fIdx) => (
                  <div key={fIdx} className="space-y-4">
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                      <Layers className="w-3 h-3" /> Frame {fIdx + 1}
                    </h4>
                    
                    <div className="space-y-3">
                      <p className="text-xs font-bold text-slate-700">AI Processing</p>
                      <button 
                        onClick={() => handleRemoveBackground(activeCanvasIdx!, fIdx)}
                        disabled={frame.isRemovingBg || !!frame.processedUrl}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 hover:border-indigo-400 hover:text-indigo-600 transition-all disabled:opacity-50"
                      >
                        {frame.isRemovingBg ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span className="animate-pulse">Processing AI...</span>
                          </>
                        ) : (
                          <>
                            <Wand2 className="w-3 h-3" />
                            {frame.processedUrl ? 'Background Removed' : 'Remove Background'}
                          </>
                        )}
                      </button>
                    </div>

                    <div className="space-y-3">
                      <p className="text-xs font-bold text-slate-700">Image Fit</p>
                      <div className="flex items-center bg-slate-100 rounded-xl p-0.5">
                        <button
                          onClick={() => {
                            const newFrames = editingCanvas.frames.map((f, i) =>
                              i === fIdx ? { ...f, fitMode: 'contain' as FitMode } : f
                            );
                            const updated = { ...editingCanvas, frames: newFrames };
                            setEditingCanvas(updated);
                            if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
                            const gen = ++renderGenRef.current;
                            renderTimeoutRef.current = setTimeout(async () => {
                              const dataUrl = await renderCanvas(updated);
                              if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
                            }, 80);
                          }}
                          className={clsx(
                            "flex-1 px-3 py-1.5 text-xs font-bold rounded-lg transition-all text-center",
                            frame.fitMode === 'contain' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                          )}
                        >
                          Fit
                        </button>
                        <button
                          onClick={() => {
                            const newFrames = editingCanvas.frames.map((f, i) =>
                              i === fIdx ? { ...f, fitMode: 'cover' as FitMode } : f
                            );
                            const updated = { ...editingCanvas, frames: newFrames };
                            setEditingCanvas(updated);
                            if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
                            const gen = ++renderGenRef.current;
                            renderTimeoutRef.current = setTimeout(async () => {
                              const dataUrl = await renderCanvas(updated);
                              if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
                            }, 80);
                          }}
                          className={clsx(
                            "flex-1 px-3 py-1.5 text-xs font-bold rounded-lg transition-all text-center",
                            frame.fitMode === 'cover' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                          )}
                        >
                          Cover
                        </button>
                      </div>
                    </div>

                    <div className="space-y-4 pt-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold text-slate-700">Zoom</p>
                        <span className="text-[10px] font-mono text-slate-400">{(frame.scale * 100).toFixed(0)}%</span>
                      </div>
                      <input 
                        type="range" min="0.1" max="3" step="0.1"
                        value={frame.scale}
                        onChange={(e) => handleUpdateTransform(activeCanvasIdx!, fIdx, { scale: parseFloat(e.target.value) })}
                        className="w-full accent-indigo-600"
                      />
                    </div>

                    <div className="space-y-3">
                      <p className="text-xs font-bold text-slate-700">Position</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[9px] text-slate-400 uppercase">X Offset</span>
                          <input 
                            type="number" value={frame.offset.x}
                            onChange={(e) => handleUpdateTransform(activeCanvasIdx!, fIdx, { x: parseInt(e.target.value) || 0 })}
                            className="w-full px-2 py-1.5 border rounded-lg text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[9px] text-slate-400 uppercase">Y Offset</span>
                          <input 
                            type="number" value={frame.offset.y}
                            onChange={(e) => handleUpdateTransform(activeCanvasIdx!, fIdx, { y: parseInt(e.target.value) || 0 })}
                            className="w-full px-2 py-1.5 border rounded-lg text-xs"
                          />
                        </div>
                      </div>
                    </div>
                    <div className="border-b border-slate-200 pt-4" />
                  </div>
                ))}
              </div>

              {/* Sidebar Bottom: Final Actions */}
              <div className="p-6 border-t bg-white space-y-4">
                <div className="flex items-start gap-2 text-[10px] text-slate-400 leading-relaxed bg-slate-50 p-3 rounded-xl">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1 shrink-0" />
                  <p>Changes are applied during editing. Click Save to finalize and update your dashboard.</p>
                </div>
                <button 
                  onClick={handleSaveChanges}
                  className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 flex items-center justify-center gap-2 active:scale-[0.98]"
                >
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  Save Changes
                </button>
              </div>
            </div>

            {/* Preview Area */}
            <div 
              ref={workspaceRef}
              className="flex-1 bg-slate-50 flex flex-col items-center justify-center overflow-auto pattern-grid cursor-move select-none p-12 relative"
              onMouseMove={handleDragMove}
              onMouseUp={handleDragEnd}
              onMouseLeave={handleDragEnd}
            >
              {/* Floating Zoom Controls */}
              <div className="absolute bottom-8 right-8 z-20 flex items-center gap-1 bg-white/90 backdrop-blur-md border border-slate-200 p-1.5 rounded-2xl shadow-xl hover:bg-white transition-all">
                <button 
                  onClick={() => setViewZoom(prev => Math.max(0.1, prev - 0.1))}
                  className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                  title="Zoom Out"
                >
                  <Minus className="w-5 h-5" />
                </button>
                <div className="min-w-[64px] text-center">
                  <button 
                    onClick={() => setViewZoom(0.85)}
                    className="text-[10px] font-black text-slate-400 uppercase tracking-tighter hover:text-indigo-600 transition-colors"
                    title="Reset Zoom"
                  >
                    {(viewZoom * 100).toFixed(0)}%
                  </button>
                </div>
                <button 
                  onClick={() => setViewZoom(prev => Math.min(2, prev + 0.1))}
                  className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                  title="Zoom In"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              <div 
                className="relative shadow-2xl bg-white animate-in zoom-in-95 duration-500"
                style={{ 
                  width: '800px',
                  height: `${800 / ((selectedLayout.canvas?.width || 1200) / (selectedLayout.canvas?.height || 1800))}px`,
                  transform: `scale(${viewZoom})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                  flexShrink: 0
                }}
                onMouseDown={(e) => handleDragStart(e, activeCanvasIdx!)}
              >
                {editingCanvas.dataUrl && (
                  <div className="relative w-full h-full overflow-hidden">
                    {/* Base layer: Background + other frames */}
                    <img
                      ref={previewImgRef}
                      src={editingCanvas.dataUrl!}
                      className="w-full h-full object-fill pointer-events-none transition-none shadow-sm"
                      alt={`Editor Preview`}
                    />

                    {/* Mask Layer - Always on top of everything */}
                    {selectedLayout.maskUrl && (
                      <img
                        src={selectedLayout.maskUrl}
                        className="absolute inset-0 w-full h-full object-fill pointer-events-none z-[100]"
                        alt="Mask Overlay"
                      />
                    )}

                    {/* Active Frame Layer (Only during drag) — pre-rendered canvas for pixel-perfect match */}
                    {dragState && activeDragFrameUrl && (() => {
                      const { frameRect, imgRect, containerRatio } = dragState;

                      return (
                        <div
                          className="active-drag-overlay"
                          style={{
                            position: 'absolute',
                            left: frameRect.fx / containerRatio,
                            top: frameRect.fy / containerRatio,
                            width: frameRect.fw / containerRatio,
                            height: frameRect.fh / containerRatio,
                            overflow: 'hidden',
                            pointerEvents: 'none',
                            zIndex: 50, // Below mask (100) but above base
                            willChange: 'transform',
                          }}
                        >
                          <img
                            src={activeDragFrameUrl}
                            className="transition-none shadow-2xl"
                            style={{ 
                              position: 'absolute',
                              width: imgRect.w / containerRatio, 
                              height: imgRect.h / containerRatio, 
                              pointerEvents: 'none',
                              // Initial transform based on current offset
                              transform: `translate(${((frameRect.fw - imgRect.w) / 2 + tempOffsetRef.current.x) / containerRatio}px, ${((frameRect.fh - imgRect.h) / 2 + tempOffsetRef.current.y) / containerRatio}px)`
                            }}
                            alt=""
                          />
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
