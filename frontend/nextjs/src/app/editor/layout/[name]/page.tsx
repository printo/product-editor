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
import { uploadFiles } from '@/lib/upload-utils';
import { saveFile, getFilesForOrder } from '@/lib/file-store';
import { normalizeLayout, filterSurfaces, type NormalizedLayout } from '@/lib/layout-utils';
import { getImageMetadata, detectJpegColorSpace } from '@/lib/image-utils';
import type { FitMode, FrameState, CanvasItem, ImpositionSettings, SheetLayout, SurfaceState } from './types';
import { renderCanvas as renderCanvasCore, calculateSmartCropOffsets } from './fabric-renderer';
// Type-only import — erased at compile time, zero bundle impact.
// The actual Fabric.js runtime is loaded lazily inside executeImposition / the
// imposition preview useEffect so it does NOT inflate the initial page bundle.
import type { StaticCanvas as FabricStaticCanvas } from 'fabric';
import { MM_TO_IN, computeImpositionLayout, resolveSheetSize } from './imposition';
import { CanvasEditorModal } from './CanvasEditorModal';

// ─── Fabric-based imposition / export ─────────────────────────────────────

export default function LayoutEditorPage() {
  const params = useParams();
  const layoutName = Array.isArray(params.name) ? params.name[0] : (params.name as string);
  const router = useRouter();
  const { data: session, status } = useSession();

  const embedToken = useMemo<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  }, []);

  // Resolve the parent window's origin for postMessage. Strict targetOrigin
  // prevents an unrelated outer page from eavesdropping on completion payloads
  // (which include order_id, job_id, and dataUrls for client-rendered jobs).
  // Resolution order: ancestorOrigins (Chromium/Safari) → document.referrer
  // → NEXT_PUBLIC_EMBED_PARENT_ORIGIN env. Falls back to a defaulted printo.in
  // host so production never silently leaks via '*'.
  const parentOrigin = useMemo<string>(() => {
    if (typeof window === 'undefined') return 'https://printo.in';
    const ancestors = (window.location as unknown as { ancestorOrigins?: { length: number; [i: number]: string } }).ancestorOrigins;
    if (ancestors && ancestors.length > 0 && ancestors[0]) return ancestors[0];
    if (document.referrer) {
      try { return new URL(document.referrer).origin; } catch { /* fall through */ }
    }
    return process.env.NEXT_PUBLIC_EMBED_PARENT_ORIGIN || 'https://printo.in';
  }, []);

  // Quantity enforcement — optional ?qty=N URL param (single-surface only)
  const orderQty = useMemo<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const v = new URLSearchParams(window.location.search).get('qty');
    const n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) || n <= 0 ? null : n;
  }, []);

  // Stable order ID — read from URL or generate a new friendly ID.
  // Written back to the URL immediately so a refresh / share keeps the same ID.
  const [orderId, setOrderId] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const sp = new URLSearchParams(window.location.search);
    let id = sp.get('order_id');
    if (!id) {
      // Generate PE-XXXXXXXX (8 uppercase hex chars)
      const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      id = `PE-${hex}`;
    }
    return id;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !orderId) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('order_id') !== orderId) {
      sp.set('order_id', orderId);
      window.history.replaceState(null, '', `?${sp.toString()}`);
    }
  }, [orderId]);

  // Two distinct request paths, deliberately kept separate:
  //
  //   1. EMBED iframe flow → /api/embed/proxy/* with X-Embed-Token header.
  //      The proxy exchanges the short-lived UUID token for the real API key
  //      server-side; the browser never holds a real key.
  //
  //   2. PIA-LOGGED-IN dashboard/editor flow → /api/internal/proxy/* with no
  //      auth header at all.  The proxy uses the NextAuth session cookie to
  //      gate access and injects the server-side INTERNAL_API_KEY.  The
  //      browser never holds a real key here either — replacing the previous
  //      NEXT_PUBLIC_DIRECT_API_KEY which leaked into the client bundle.
  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (embedToken) return { 'X-Embed-Token': embedToken };
    // Internal proxy reads the session cookie automatically; no header needed.
    return {};
  }, [embedToken]);

  const apiBase = embedToken ? '/api/embed/proxy' : '/api/internal/proxy';

  const isAdmin = !embedToken &&
    (session?.user?.role === 'admin' || session?.is_ops_team === true);

  const [layout, setLayout] = useState<any | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);
  const [canvases, setCanvases] = useState<CanvasItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [globalFitMode, setGlobalFitMode] = useState<FitMode>('contain');
  const globalFitModeRef = useRef<FitMode>(globalFitMode);
  useEffect(() => {
    globalFitModeRef.current = globalFitMode;
  }, [globalFitMode]);

  const [activeCanvasIdx, setActiveCanvasIdx] = useState<number | null>(null);
  const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [serverRenderLabel, setServerRenderLabel] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [colorWarning, setColorWarning] = useState<string | null>(null);
  // Qty enforcement state
  const [qtyUnder, setQtyUnder] = useState<{ uploaded: number; needed: number } | null>(null);
  const [pendingOverFiles, setPendingOverFiles] = useState<File[] | null>(null);
  const [showAutoFillPicker, setShowAutoFillPicker] = useState(false);
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set());
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 7, gutterMm: 5, orientation: 'portrait',
  });

  const fileUrlCache = useRef<Map<File, string>>(new Map());
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const impositionFabricRef = useRef<FabricStaticCanvas | null>(null);
  const skipNextGenerateRef = useRef(false);
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

  // ── Canvas-state persistence ──────────────────────────────────────────────
  const [isSaving, setIsSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dragOverIdx, setDragOverIdx] = useState<{ idx: number, surfaceKey: string | null } | null>(null);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Tracks the 3-second "saved → idle" indicator reset so it can be cancelled
  // on unmount and won't call setState on a dead component.
  const saveIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we've attempted a restore on this page-load already.
  const restoredRef = useRef(false);
  // Set to true during restore so the resulting state-update doesn't trigger
  // a redundant auto-save of data we just loaded from the server.
  const isRestoringRef = useRef(false);

  /**
   * Strip un-serialisable File objects from a canvas item so it can be
   * stored as JSON.  The dataUrl is kept so the preview is still visible
   * after restore even though the original File is gone.
   */
  const serializeCanvasState = useCallback((items: CanvasItem[]) =>
    items.map(c => ({
      ...c,
      frames: c.frames.map(f => ({ ...f, originalFile: null })),
      overlays: c.overlays.map(o => ({ ...o, originalFile: undefined })),
    }))
    , []);

  const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>([]);
  const [activeSurfaceKey, setActiveSurfaceKey] = useState<string>('default');

  // Ref-mirrors so the auto-save timeout closure always reads the latest values
  // without needing these in the effect deps (which would restart the debounce
  // on every surface update). Must be declared after the useState lines above.
  const surfaceStatesRef = useRef(surfaceStates);
  useEffect(() => { surfaceStatesRef.current = surfaceStates; }, [surfaceStates]);
  const activeSurfaceKeyRef = useRef(activeSurfaceKey);
  useEffect(() => { activeSurfaceKeyRef.current = activeSurfaceKey; }, [activeSurfaceKey]);
  const [normalizedLayoutState, setNormalizedLayoutState] = useState<NormalizedLayout | null>(null);

  const [selectedFonts, setSelectedFonts] = useState<string[]>(['sans-serif', 'serif', 'monospace']);
  const [fontsLoaded, setFontsLoaded] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
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
    if ((status === 'unauthenticated' || session?.error === 'RefreshAccessTokenError') && !embedToken) {
      router.push('/login');
    }
  }, [status, session, embedToken, router]);

  useEffect(() => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (embedToken) {
      headers['X-Embed-Token'] = embedToken;
    }
    // Internal proxy uses the NextAuth session cookie; no auth header needed.
    const fontsUrl = embedToken ? '/api/embed/proxy/fonts' : '/api/internal/proxy/fonts';
    fetch(fontsUrl, { headers })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.fonts) setSelectedFonts(data.fonts); })
      .catch(() => { });
  }, [embedToken]);

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
    const canFetch = embedToken || status === 'authenticated';
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
  }, [layoutName, embedToken, status, apiBase, getAuthHeaders]);

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
      // Cancel pending save / idle-reset timers so they don't call setState
      // on an unmounted component.
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
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
      setSurfaceStates(prev => {
        const sIdx = prev.findIndex(s => s.key === activeSurfaceKey);
        if (sIdx === -1) return prev;
        const s = prev[sIdx];
        if (s.files === files && s.canvases === canvases) return prev;
        
        const next = [...prev];
        next[sIdx] = { ...s, files, canvases };
        return next;
      });
    }
  }, [files, canvases, activeSurfaceKey]); // Removed surfaceStates from dependencies

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

  // ── Auto-save: debounce 2 s after canvases change ────────────────────────
  useEffect(() => {
    // Don't save before the layout is known or before the orderId is set.
    if (!orderId || !layout) return;
    // Skip the first save that fires as a side-effect of restoring state —
    // we'd just be writing back the exact data we loaded from the server.
    if (isRestoringRef.current) { isRestoringRef.current = false; return; }
    // Allow saving even when canvases is empty — this covers the "delete all"
    // case so that a refresh after clearing doesn't restore the old design.

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setIsSaving('saving');

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        // Read from refs so the timeout always uses the latest surface data,
        // even if other surfaces were updated during the 2 s debounce window.
        const latestSurfaces = surfaceStatesRef.current;
        const latestActiveKey = activeSurfaceKeyRef.current;

        // The backend stores `editor_state` as an opaque JSON blob.
        const editorState = {
          surfaces: latestSurfaces.map(s => ({
            key: s.key,
            canvases: serializeCanvasState(s.canvases),
            globalFitMode: s.globalFitMode,
          })),
          activeSurfaceKey: latestActiveKey,
          layoutName,
        };

        const res = await fetch(`${apiBase}/canvas-state/${orderId}/`, {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            layout_name: layoutName,   // required by backend
            editor_state: editorState,
          }),
        });

        if (res.ok) {
          setIsSaving('saved');
          // Reset indicator to idle after 3 s; tracked so unmount can cancel it.
          if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
          saveIdleTimeoutRef.current = setTimeout(() => setIsSaving('idle'), 3000);
        } else {
          setIsSaving('idle');
        }
      } catch {
        setIsSaving('idle');
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
    // surfaceStates/activeSurfaceKey are intentionally read via refs so this
    // effect only re-runs when the active surface's canvases actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvases, orderId, layout]);

  // ── Auto-restore: run once after layout is ready ──────────────────────────
  useEffect(() => {
    if (!orderId || !layout || layoutLoading || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      try {
        const res = await fetch(`${apiBase}/canvas-state/${orderId}/`, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        if (!res.ok) return; // 404 = first visit, no state to restore

        const data = await res.json();
        if (!data?.editor_state?.surfaces?.length) return;

        const savedLayoutName: string | undefined = data.editor_state.layoutName;
        // Don't restore if it belongs to a different layout template.
        if (savedLayoutName && savedLayoutName !== layoutName) return;

        const savedSurfaces: Array<{
          key: string;
          canvases: CanvasItem[];
          globalFitMode: FitMode;
        }> = data.editor_state.surfaces;

        // Flag: the state updates below will trigger the auto-save effect —
        // suppress that one fire since we just loaded the data from the server.
        isRestoringRef.current = true;

        // Remove any stale ?canvas= param from a previous session so the modal
        // doesn't auto-open on top of the freshly-restored state.
        const sp = new URLSearchParams(window.location.search);
        if (sp.has('canvas')) {
          sp.delete('canvas');
          window.history.replaceState(null, '', sp.toString() ? `?${sp.toString()}` : window.location.pathname);
        }

        // Hydrate Files from IndexedDB (B1 fix). We strip `originalFile` on
        // serialise but persist the raw blob client-side keyed by `fileId`,
        // so refreshing the page recovers everything needed to re-render.
        const fileMap = await getFilesForOrder(orderId).catch(() => new Map<string, File>());
        const hydrate = (canvases: CanvasItem[]): CanvasItem[] =>
          canvases.map(c => ({
            ...c,
            frames: c.frames.map(f => {
              if (!f.fileId) return f;
              const file = fileMap.get(f.fileId);
              return file ? { ...f, originalFile: file } : f;
            }),
            overlays: c.overlays.map(o => {
              if (o.type !== 'image' || !o.fileId) return o;
              const file = fileMap.get(o.fileId);
              if (!file) return o;
              // Re-create the blob URL since the saved one was revoked when
              // the previous browser session ended. getFileUrl caches by File
              // reference so revocation hooks elsewhere still work.
              return { ...o, originalFile: file, src: getFileUrl(file) };
            }),
          }));

        // Merge saved canvas data into the surface states that were just
        // initialised from the layout definition.
        setSurfaceStates(prev => prev.map(s => {
          const saved = savedSurfaces.find(ss => ss.key === s.key);
          if (!saved || !saved.canvases?.length) return s;
          return {
            ...s,
            canvases: hydrate(saved.canvases),
            globalFitMode: saved.globalFitMode ?? s.globalFitMode,
          };
        }));

        // Activate the surface that was open when the user last saved.
        const savedActiveKey: string | undefined = data.editor_state.activeSurfaceKey;
        if (savedActiveKey) setActiveSurfaceKey(savedActiveKey);

        // Sync the active-surface shortcut state.
        const activeSaved = savedSurfaces.find(
          ss => ss.key === (savedActiveKey ?? activeSurfaceKey)
        );
        if (activeSaved?.canvases?.length) {
          skipNextGenerateRef.current = true; // suppress generateCanvases trigger
          setCanvases(hydrate(activeSaved.canvases));
          setGlobalFitMode(activeSaved.globalFitMode ?? 'contain');
        }
      } catch {
        // Restore failures are silent — user just starts fresh.
      }
    })();
    // Run exactly once when layout becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layoutLoading, orderId]);

  const canvasesRef = useRef<CanvasItem[]>([]);
  useEffect(() => {
    canvasesRef.current = canvases;
  }, [canvases]);

  // ── Persist Files to IndexedDB on add (B1: survives page refresh) ────────
  // Watches surfaceStates for any frame/overlay that has an originalFile but
  // no fileId, persists the blob, then patches the fileId back into state.
  // Self-stabilising: once every File has a fileId the effect no-ops.
  useEffect(() => {
    if (!orderId) return;
    type Pending = { surfaceKey: string; canvasIdx: number; kind: 'frame' | 'overlay'; idx: number; file: File };
    const pending: Pending[] = [];

    surfaceStates.forEach(s => {
      s.canvases.forEach((c, ci) => {
        c.frames.forEach((f, fi) => {
          if (f.originalFile && !f.fileId) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'frame', idx: fi, file: f.originalFile });
          }
        });
        c.overlays.forEach((o, oi) => {
          if (o.type === 'image' && o.source === 'local' && o.originalFile && !o.fileId) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'overlay', idx: oi, file: o.originalFile });
          }
        });
      });
    });

    if (!pending.length) return;

    let cancelled = false;
    (async () => {
      const results = await Promise.all(pending.map(async (p) => {
        try {
          const fileId = await saveFile(orderId, p.file);
          return { ...p, fileId };
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      const ok = results.filter((r): r is Pending & { fileId: string } => r !== null);
      if (!ok.length) return;

      setSurfaceStates(prev => prev.map(s => {
        const sIds = ok.filter(i => i.surfaceKey === s.key);
        if (!sIds.length) return s;
        return {
          ...s,
          canvases: s.canvases.map((c, ci) => {
            const cIds = sIds.filter(i => i.canvasIdx === ci);
            if (!cIds.length) return c;
            return {
              ...c,
              frames: c.frames.map((f, fi) => {
                const m = cIds.find(i => i.kind === 'frame' && i.idx === fi);
                return m ? { ...f, fileId: m.fileId } : f;
              }),
              overlays: c.overlays.map((o, oi) => {
                const m = cIds.find(i => i.kind === 'overlay' && i.idx === oi);
                if (!m || o.type !== 'image') return o;
                return { ...o, fileId: m.fileId };
              }),
            };
          }),
        };
      }));
    })();

    return () => { cancelled = true; };
  }, [surfaceStates, orderId]);

  const generateCanvasesForLayout = useCallback(async (
    layoutDef: any, surfaceFiles: File[], fitMode: FitMode,
    existingCanvases: CanvasItem[] = canvasesRef.current
  ): Promise<CanvasItem[]> => {
    if (!layoutDef || surfaceFiles.length === 0) return [];
    const frameCount = layoutDef.frames?.length || 1;
    const canvasCount = Math.ceil(surfaceFiles.length / frameCount);
    const newCanvases: CanvasItem[] = [];
    for (let i = 0; i < canvasCount; i++) {
      const canvasFrames: FrameState[] = [];
      const existing = existingCanvases[i];

      for (let f = 0; f < frameCount; f++) {
        const file = surfaceFiles[(i * frameCount + f) % surfaceFiles.length];
        const existingFrame = existing?.frames?.[f];

        if (file) {
            // If we have an existing frame with the SAME file name/size, preserve its transforms
            const isSameFile = existingFrame?.originalFile && 
                              existingFrame.originalFile.name === file.name && 
                              existingFrame.originalFile.size === file.size &&
                              existingFrame.originalFile.lastModified === file.lastModified;
            
            if (isSameFile && existingFrame) {
            canvasFrames.push({
              ...existingFrame,
              originalFile: file // Ensure we use the latest file object
            });
          } else {
            const { width: imgW, height: imgH, element: imgEl } = await getImageMetadata(file);
            const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames) || [];
            const frameSpec = frames[f] || { x: 0, y: 0, width: 1, height: 1 };
            const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
            const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
            const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
            const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
            const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

            const imgRatio = imgW / imgH;
            const targetRatio = frameW / frameH;

            // Check if the image orientation matches the target orientation 
            const isImgLandscape = imgRatio > 1;
            const isTargetLandscape = targetRatio > 1;

            let rotation = 0;
            if (isImgLandscape !== isTargetLandscape) {
              rotation = 90; // Suggest/Apply rotation to fill layout better
            }

            let offset = { x: 0, y: 0 };
            if (fitMode === 'cover') {
              offset = await calculateSmartCropOffsets(imgEl, frameW, frameH, rotation);
            }

            canvasFrames.push({
              id: f, originalFile: file,
              offset, scale: 1, rotation, fitMode,
            });
          }
        }
      }
      const item: CanvasItem = {
        id: i,
        frames: canvasFrames,
        overlays: existing?.overlays || [],
        bgColor: existing?.bgColor || '#ffffff',
        paperColor: existing?.paperColor || '#ffffff',
        dataUrl: existing?.dataUrl || null
      };

      const framesChanged = !existing || 
        canvasFrames.length !== existing.frames.length ||
        canvasFrames.some((f, idx) => {
          const ef = existing.frames[idx];
          return !ef || 
                 ef.originalFile !== f.originalFile || 
                 ef.rotation !== f.rotation || 
                 ef.fitMode !== f.fitMode ||
                 ef.scale !== f.scale ||
                 ef.offset.x !== f.offset.x ||
                 ef.offset.y !== f.offset.y;
        });

      if (framesChanged || !item.dataUrl) {
          // Use thumbnail for grid previews to save memory and CPU
          item.dataUrl = await renderCanvas({ ...item, dataUrl: null }, { thumbnail: true, layoutOverride: layoutDef });
        }

      newCanvases.push(item);
    }
    return newCanvases;
  }, [renderCanvas]);

  const generateCanvases = useCallback(async () => {
    if (!layout || files.length === 0 || isProcessing) return;
    setIsProcessing(true);
    setError(null);

    const frameCount = layout.frames?.length || 1;
    const canvasCount = Math.ceil(files.length / frameCount);
    setRenderProgress({ current: 0, total: canvasCount });
    
    // Use current canvases from ref to preserve transforms without creating a dependency loop
    const existingCanvases = [...canvasesRef.current];

    try {
      const built: CanvasItem[] = [];
      const BATCH_SIZE = 5;
      
      for (let i = 0; i < canvasCount; i += BATCH_SIZE) {
        const end = Math.min(i + BATCH_SIZE, canvasCount);
        const batchPromises: Promise<CanvasItem>[] = [];

        for (let batchIdx = i; batchIdx < end; batchIdx++) {
          const p: Promise<CanvasItem> = (async () => {
            const canvasFrames: FrameState[] = [];
            const existing = existingCanvases[batchIdx];

            for (let f = 0; f < frameCount; f++) {
              const file = files[(batchIdx * frameCount + f) % files.length];
              const existingFrame = existing?.frames?.[f];

              if (file) {
                const isSameFile = existingFrame?.originalFile && 
                                  existingFrame.originalFile.name === file.name && 
                                  existingFrame.originalFile.size === file.size &&
                                  existingFrame.originalFile.lastModified === file.lastModified;
                
                if (isSameFile && existingFrame) {
                  canvasFrames.push({
                    ...existingFrame,
                    originalFile: file
                  });
                } else {
                  const { width: imgW, height: imgH, element: imgEl } = await getImageMetadata(file);
                  const frameSpec = layout.frames?.[f] || { width: 1, height: 1 };
                  const canvasW = layout.canvas?.width || layout.surfaces?.[0]?.canvas?.width || 1200;
                  const canvasH = layout.canvas?.height || layout.surfaces?.[0]?.canvas?.height || 1800;
                  const frameW = frameSpec.width <= 1 ? frameSpec.width * canvasW : frameSpec.width;
                  const frameH = frameSpec.height <= 1 ? frameSpec.height * canvasH : frameSpec.height;

                  const imgRatio = imgW / imgH;
                  const targetRatio = frameW / frameH;
                  const isImgLandscape = imgRatio > 1;
                  const isTargetLandscape = targetRatio > 1;

                  let rotation = 0;
                  if (isImgLandscape !== isTargetLandscape) {
                    rotation = 90;
                  }

                  let offset = { x: 0, y: 0 };
                  if (globalFitModeRef.current === 'cover') {
                    offset = await calculateSmartCropOffsets(imgEl, frameW, frameH, rotation);
                  }

                  canvasFrames.push({
                    id: f, originalFile: file,
                    offset, scale: 1, rotation, fitMode: globalFitModeRef.current,
                  });
                }
              }
            }
            
            const item: CanvasItem = {
              id: batchIdx, 
              frames: canvasFrames, 
              overlays: existing?.overlays || [],
              bgColor: existing?.bgColor || '#ffffff', 
              paperColor: existing?.paperColor || '#ffffff', 
              dataUrl: existing?.dataUrl || null,
            };

            const framesChanged = !existing || 
              canvasFrames.length !== existing.frames.length ||
              canvasFrames.some((f, idx) => {
                const ef = existing.frames[idx];
                return !ef || 
                       ef.originalFile !== f.originalFile || 
                       ef.rotation !== f.rotation || 
                       ef.fitMode !== f.fitMode ||
                       ef.scale !== f.scale ||
                       ef.offset.x !== f.offset.x ||
                       ef.offset.y !== f.offset.y;
              });

            if (framesChanged || !item.dataUrl) {
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
  }, [layout, files, renderCanvas]); // Removed globalFitMode from dependencies

  useEffect(() => {
    if (skipNextGenerateRef.current) { skipNextGenerateRef.current = false; return; }
    if (layout && files.length > 0) generateCanvases();
  }, [layout, files, generateCanvases]);

  useEffect(() => {
    if (surfaceStates.length === 0) return;
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
                newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, f.rotation);
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

  const updateCanvasState = useCallback(async (idx: number, surfaceKey: string | null, updateFn: (c: CanvasItem) => CanvasItem | Promise<CanvasItem>) => {
    if (surfaceKey) {
      const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
      if (sIdx === -1) return;
      const targetSurface = surfaceStates[sIdx];
      const targetCanvas = targetSurface.canvases[idx];
      if (!targetCanvas) return;

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
    } else {
      const targetCanvas = canvases[idx];
      if (!targetCanvas) return;

      const updatedCanvas = await updateFn(targetCanvas);
      const canRerender = updatedCanvas.frames.some(f => f.originalFile !== null);
      if (canRerender) updatedCanvas.dataUrl = await renderCanvas(updatedCanvas, { thumbnail: true });

      setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
    }
  }, [surfaceStates, canvases, activeSurfaceKey, renderCanvas]);

  const handleQuickRotate = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, async (c) => {
      const updatedFrames: FrameState[] = await Promise.all(c.frames.map(async (f, fIdx) => {
        const newRotation = (f.rotation + 90) % 360;
        let newOffset = { ...f.offset };
        
        // If the user hasn't manually adjusted the image, we can re-calculate smartcrop for the new rotation
        if (f.fitMode === 'cover' && f.offset.x === 0 && f.offset.y === 0 && f.scale === 1 && f.originalFile) {
          const { element: imgEl } = await getImageMetadata(f.originalFile);
          const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
          const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
          const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
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
          const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
          const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
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
      setFiles(prev => prev.filter((_, i) => i !== idx));
    }
    setDeleteConfirm(null);
  };

  const handleQuickDownload = async (idx: number, surfaceKey: string | null = null) => {
    const targetCanvases = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.canvases : canvases;
    const c = targetCanvases?.[idx];
    if (!c) return;

    // Re-render at full resolution if dataUrl is missing or is a thumbnail
    let dataUrl = c.dataUrl;
    if (!dataUrl) {
      try {
        const layoutDef = surfaceKey
          ? surfaceStates.find(s => s.key === surfaceKey)?.def
          : layout;
        dataUrl = await renderCanvas(c, { isExport: true, includeMask: false, layoutOverride: layoutDef });
      } catch (err) {
        console.error('[quick-download] render failed:', err);
        return;
      }
    }
    if (!dataUrl) return;

    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${layout?.id || 'canvas'}-${surfaceKey || 'canvas'}-${idx + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

  const handleDrop = async (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.preventDefault();
    setDragOverIdx(null);
    if (isProcessing) return;
    
    const droppedFiles = Array.from(e.dataTransfer.files);
    
    if (droppedFiles.length > 0) {
      // ── Handle external files ──────────────────────────────────────────────
      const firstFile = droppedFiles[0];
      if (!firstFile.type.startsWith('image/')) return;
      
      if (surfaceKey) {
        // Multi-surface: update that specific surface's file
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return;
        
        const s = surfaceStates[sIdx];
        const surfaceLayout = {
          ...normalizedLayoutState?._raw,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        
        const newCanvases = await generateCanvasesForLayout(surfaceLayout, [firstFile], s.globalFitMode);
        setSurfaceStates(prev => prev.map((ps, pi) => 
          pi === sIdx ? { ...ps, files: [firstFile], canvases: newCanvases } : ps
        ));
        
        if (surfaceKey === activeSurfaceKey) {
          setFiles([firstFile]);
          setCanvases(newCanvases);
        }
      } else {
        // Single surface: update files array at index idx
        const frameCount = layout?.frames?.length || 1;
        const fileIdx = idx * frameCount; // Start file index for this canvas
        
        const nextFiles = [...files];
        // Replace/Insert files starting at the target index
        nextFiles.splice(fileIdx, droppedFiles.length, ...droppedFiles);
        setFiles(nextFiles);
      }
    } else {
      // ── Handle internal image swap ──────────────────────────────────────────
      const sourceIdx = e.dataTransfer.getData('canvasIdx');
      const sourceSurface = e.dataTransfer.getData('surfaceKey') || null;
      
      if (sourceIdx !== '') {
        const sIdx = parseInt(sourceIdx);
        if (sIdx === idx && sourceSurface === surfaceKey) return;
        
        if (surfaceKey || sourceSurface) {
          // Multi-surface swap
          const targetSurfaceIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
          const sourceSurfaceIdx = surfaceStates.findIndex(s => s.key === sourceSurface);
          
          if (targetSurfaceIdx !== -1 && sourceSurfaceIdx !== -1) {
            const targetFiles = [...surfaceStates[targetSurfaceIdx].files];
            const sourceFiles = [...surfaceStates[sourceSurfaceIdx].files];
            
            // Swap files
            const temp = targetFiles[0];
            targetFiles[0] = sourceFiles[0];
            sourceFiles[0] = temp;
            
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
          const targetFileIdx = idx * frameCount;
          const sourceFileIdx = sIdx * frameCount;
          
          const nextFiles = [...files];
          const temp = nextFiles[targetFileIdx];
          nextFiles[targetFileIdx] = nextFiles[sourceFileIdx];
          nextFiles[sourceFileIdx] = temp;
          setFiles(nextFiles);
        }
      }
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    fileUrlCache.current.forEach(url => URL.revokeObjectURL(url));
    fileUrlCache.current.clear();
    const allFiles = Array.from(e.target.files);

    // ── CMYK color space detection ──────────────────────────────────────────
    setColorWarning(null);
    const colorSpaces = await Promise.all(allFiles.map(f => detectJpegColorSpace(f)));
    const cmykFiles = allFiles.filter((_, i) => colorSpaces[i] === 'CMYK');
    if (cmykFiles.length > 0) {
      setColorWarning(
        `${cmykFiles.length === 1 ? `"${cmykFiles[0].name}"` : `${cmykFiles.length} files`} use CMYK colour (ISOCoated). Colours may shift — convert to sRGB for accurate on-screen preview.`
      );
    }
    // ── Qty enforcement (single-surface only) ──────────────────────────────
    if (orderQty !== null && surfaceStates.length <= 1) {
      setQtyUnder(null);
      setPendingOverFiles(null);
      if (allFiles.length < orderQty) {
        // Under: generate with what we have, show persistent banner
        setQtyUnder({ uploaded: allFiles.length, needed: orderQty });
      } else if (allFiles.length > orderQty) {
        // Over: hold files, show confirm modal
        setPendingOverFiles(allFiles);
        return; // don't process yet — wait for user confirm
      }
      // Exact match or under (proceed with current files)
    }

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

  // ── Qty: auto-fill (cycle images to fill remaining slots) ─────────────────
  const handleAutoFill = () => {
    if (!qtyUnder || files.length === 0) return;
    const needed = qtyUnder.needed - files.length;
    const filled = [...files];
    for (let i = 0; i < needed; i++) filled.push(files[i % files.length]);
    setQtyUnder(null);
    setFiles(filled);
  };

  // ── Qty: fill with user-chosen duplicates from picker ─────────────────────
  const handleFillWithPicked = () => {
    if (!qtyUnder || pickerSelected.size === 0) return;
    const needed = qtyUnder.needed - files.length;
    const picks = Array.from(pickerSelected).slice(0, needed).map(i => files[i]);
    // Pad with auto-cycling if picker selection was fewer than needed
    const filled = [...files, ...picks];
    if (filled.length < qtyUnder.needed) {
      for (let i = 0; filled.length < qtyUnder.needed; i++) filled.push(files[i % files.length]);
    }
    setQtyUnder(null);
    setShowAutoFillPicker(false);
    setPickerSelected(new Set());
    setFiles(filled);
  };

  // ── Qty: over-upload — user confirmed, process all pending files ───────────
  const handleOverConfirm = (proceed: boolean) => {
    if (!pendingOverFiles) return;
    if (proceed) {
      setFiles(pendingOverFiles);
    }
    setPendingOverFiles(null);
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

    let aborted = false;

    // Lazy-load Fabric.js only when the imposition modal is actually opened.
    const run = async () => {
      const { StaticCanvas, Rect: FabricRect, FabricImage, Line } = await import('fabric');
      if (aborted) return;

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

    run();
    return () => {
      aborted = true;
      if (impositionFabricRef.current) {
        impositionFabricRef.current.dispose();
        impositionFabricRef.current = null;
      }
    };
  }, [impositionResult, previewSheetIdx, impositionSettings, canvases, showImpositionModal]);

  // Canvases beyond this threshold are rendered server-side (Celery + Pillow at 300 DPI).
  // At or below, client-side canvas render is fast enough for direct download.
  const SERVER_RENDER_THRESHOLD = 20;

  const executeServerRender = async () => {
    setIsDownloading(true);
    setServerRenderLabel('Preparing upload…');
    setRenderProgress({ current: 0, total: 100 });
    try {
      // 1. Collect all canvases in order across all surfaces
      const allCanvases = surfaceStates.length > 1
        ? surfaceStates.flatMap(s => s.canvases.map(c => ({ ...c, surfaceKey: s.key })))
        : canvases.map(c => ({ ...c, surfaceKey: 'canvas' }));

      // 2. Collect unique File objects in frame order
      const allFiles: File[] = [];
      const seenFiles = new Set<File>();
      for (const c of allCanvases) {
        for (const frame of c.frames) {
          if (frame.originalFile && !seenFiles.has(frame.originalFile)) {
            seenFiles.add(frame.originalFile);
            allFiles.push(frame.originalFile);
          }
        }
      }

      if (allFiles.length === 0) {
        setError('No files to upload for server render.');
        return;
      }

      // 3. Upload files — progress 0–60%
      setServerRenderLabel('Uploading files…');
      const uploadResults = await uploadFiles(
        allFiles,
        apiBase,
        getAuthHeaders,
        (completed, total) => {
          setRenderProgress({ current: Math.round((completed / total) * 60), total: 100 });
        },
      );

      // 4. Build render payload: canvases → frames → upload_id + per-frame transforms
      setServerRenderLabel('Submitting render job…');
      setRenderProgress({ current: 65, total: 100 });

      const canvasesPayload = allCanvases.map((c, canvasIdx) => ({
        canvas_index: canvasIdx,
        surface_key: (c as any).surfaceKey,
        frames: c.frames.map((frame, frameIdx) => {
          const up = frame.originalFile ? uploadResults.get(frame.originalFile) : null;
          return {
            frame_index: frameIdx,
            upload_id: up?.uploadId ?? null,
            offset_x: frame.offset.x,
            offset_y: frame.offset.y,
            scale: frame.scale,
            rotation: frame.rotation,
            fit_mode: frame.fitMode,
          };
        }),
      }));

      const renderRes = await fetch(`${apiBase}/editor/render`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout_name: layoutName,
          order_id: orderId,
          canvases: canvasesPayload,
        }),
      });

      if (!renderRes.ok) {
        const err = await renderRes.json().catch(() => ({}));
        throw new Error(err.detail ?? `Render job submission failed: ${renderRes.status}`);
      }

      const { job_id, order_id: serverOrderId } = await renderRes.json();

      // 5. Embed path: fire postMessage and exit — no download UI shown
      if (embedToken) {
        window.parent.postMessage({
          type: 'pe:render_job',
          jobId: job_id,
          orderID: serverOrderId || orderId,
        }, parentOrigin);
        setSubmitted(true);
        return;
      }

      // 6. Direct/admin path: poll render-status until done
      setServerRenderLabel('Rendering on server…');
      setRenderProgress({ current: 70, total: 100 });

      const MAX_POLLS = 150; // 10 minutes at 4 s intervals
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await new Promise(r => setTimeout(r, 4000));

        const statusRes = await fetch(`${apiBase}/render-status/${job_id}/`, {
          headers: getAuthHeaders(),
        });
        if (!statusRes.ok) continue;

        const jobStatus = await statusRes.json();

        if (jobStatus.status === 'completed') {
          setServerRenderLabel('Downloading…');
          setRenderProgress({ current: 100, total: 100 });

          const dlRes = await fetch(`${apiBase}/jobs/${job_id}/download/`, {
            headers: getAuthHeaders(),
          });
          if (!dlRes.ok) throw new Error('Failed to fetch render output.');
          const blob = await dlRes.blob();
          const zipName = layout?.name || layoutName;
          downloadBlob(blob, `${zipName}.zip`);
          return;
        }

        if (jobStatus.status === 'failed') {
          throw new Error(jobStatus.error || 'Server render failed');
        }

        // Ease progress 70 → 99 while rendering
        setRenderProgress({ current: Math.min(99, 70 + poll * 2), total: 100 });
      }

      throw new Error('Render job timed out after 10 minutes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Server render failed.');
    } finally {
      setIsDownloading(false);
      setShowDownloadModal(false);
      setServerRenderLabel(null);
      setRenderProgress(null);
    }
  };

  const executeBatchDownload = async () => {
    setIsDownloading(true);
    try {
      const zipName = layout.name || layout.id || `job-${Date.now().toString().slice(-6)}`;

      // 1. Prepare the list of all canvases across all surfaces
      const allCanvases = surfaceStates.length > 1
        ? surfaceStates.flatMap(s => s.canvases.map(c => ({ ...c, surfaceKey: s.key })))
        : canvases.map(c => ({ ...c, surfaceKey: 'canvas' }));

      const totalSteps = allCanvases.length;
      if (totalSteps === 0) {
        setError('No canvases to download.');
        setIsDownloading(false);
        return;
      }

      // Delegate large jobs to the server-side render pipeline
      if (totalSteps > SERVER_RENDER_THRESHOLD) {
        setIsDownloading(false);
        return executeServerRender();
      }

      setRenderProgress({ current: 0, total: totalSteps });
      const items: { name: string; blob: Blob }[] = [];

      // 2. Render canvases in parallel batches.
      // Larger batches for big jobs — thumbnail renders are cheap, high-res renders are the
      // bottleneck, so we scale batch size with total count to keep wall time reasonable.
      // Memory bound: each full-res canvas is ~8–30 MB; 5 concurrent = 40–150 MB peak.
      const BATCH_SIZE = totalSteps > 50 ? 5 : 3;
      const RENDER_TIMEOUT_MS = 60_000;
      for (let batchStart = 0; batchStart < totalSteps; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, totalSteps);

        const batchResults = await Promise.all(
          Array.from({ length: batchEnd - batchStart }, async (_, j) => {
            const i = batchStart + j;
            const c = (allCanvases as any)[i];
            const surfaceKey = c.surfaceKey;
            const layoutDef = surfaceStates.length > 1
              ? surfaceStates.find((s: any) => s.key === surfaceKey)?.def
              : layout;

            let dataUrl = '';
            try {
              dataUrl = await Promise.race([
                renderCanvas(c, { isExport: true, includeMask: false, layoutOverride: layoutDef }),
                new Promise<string>((_, reject) =>
                  setTimeout(() => reject(new Error(`Canvas ${i + 1} timed out after ${RENDER_TIMEOUT_MS / 1000}s`)), RENDER_TIMEOUT_MS)
                ),
              ]);
            } catch (renderErr) {
              console.error(`[batch-download] Failed to render canvas ${i + 1}:`, renderErr);
            }
            return { i, c, surfaceKey, dataUrl };
          })
        );

        // Convert renders to blobs in parallel — fetch(dataUrl) is non-blocking so this is safe
        const blobEntries = await Promise.all(
          batchResults.map(async ({ i, c, surfaceKey, dataUrl }) => ({
            i, surfaceKey,
            printBlob: dataUrl ? await dataUrlToBlob(dataUrl) : null,
            mockupBlob: c.dataUrl ? await dataUrlToBlob(c.dataUrl) : null,
          }))
        );
        for (const { i, surfaceKey, printBlob, mockupBlob } of blobEntries) {
          if (printBlob) items.push({ name: `print_file/${surfaceKey}-${i + 1}.png`, blob: printBlob });
          if (mockupBlob) items.push({ name: `mockup_file/${surfaceKey}-${i + 1}.png`, blob: mockupBlob });
        }

        setRenderProgress({ current: batchEnd, total: totalSteps });
        await new Promise(r => setTimeout(r, 0));
      }

      // 3. Add Original Files (CX Files)
      const allOriginalFiles = surfaceStates.length > 1
        ? surfaceStates.flatMap(s => s.files)
        : files;

      for (const file of allOriginalFiles) {
        items.push({
          name: `cx_file/${file.name}`,
          blob: file
        });
      }

      // 4. Use optimized zipping
      const finalZipBlob = await createZipFromDataUrls(
        items,
        (p) => setRenderProgress({ current: Math.round(p * 100), total: 100 })
      );
      
      downloadBlob(finalZipBlob, `${zipName}.zip`);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setIsDownloading(false);
      setShowDownloadModal(false);
      setRenderProgress(null);
    }
  };

  const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
    const res = await fetch(dataUrl);
    return res.blob();
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

      // 1. Prepare for sheet generation
      const cropMarkLen = Math.round((5 / MM_TO_IN) * dpi);
      const cropMarkOff = Math.round((2 / MM_TO_IN) * dpi);
      const sheetBlobs: { name: string; blob: Blob }[] = [];
      const { Canvas: FabricCanvas, FabricImage, Line } = await import('fabric');

      // 2. Process each sheet sequentially to keep memory usage low
      for (let si = 0; si < impositionSheets.length; si++) {
        const sheet = impositionSheets[si];
        const sheetEl = document.createElement('canvas');
        sheetEl.width = sheetW; sheetEl.height = sheetH;
        const fabricSheet = new FabricCanvas(sheetEl, { width: sheetW, height: sheetH, backgroundColor: 'white', renderOnAddRemove: false });

        // For each item in the sheet, render the high-res canvas and place it
        for (let ii = 0; ii < sheet.items.length; ii++) {
          const item = sheet.items[ii];
          const canvasObj = allCanvases[item.canvasIdx];
          const [px, py, pw, ph] = [Math.round(item.x * dpi), Math.round(item.y * dpi), Math.round(item.w * dpi), Math.round(item.h * dpi)];
          
          try {
            // Render the high-res image for this specific spot on the sheet
            const dataUrl = await renderCanvas(canvasObj, { isExport: true, includeMask: true });
            if (dataUrl) {
              const img = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
              if (item.rotated) {
                img.set({ left: px + pw / 2, top: py + ph / 2, originX: 'center', originY: 'center', scaleX: ph / img.width!, scaleY: pw / img.height!, angle: -90, selectable: false, evented: false });
              } else {
                img.set({ left: px, top: py, originX: 'left', originY: 'top', scaleX: pw / img.width!, scaleY: ph / img.height!, selectable: false, evented: false });
              }
              fabricSheet.add(img);
            }
          } catch (err) {
            console.error('Failed to render imposition item:', err);
          }

          // Add crop marks
          for (const [cx, cy, dx, dy] of [[px, py, -1, -1], [px + pw, py, 1, -1], [px, py + ph, -1, 1], [px + pw, py + ph, 1, 1]] as [number, number, number, number][]) {
            fabricSheet.add(new Line([cx, cy + dy * cropMarkOff, cx, cy + dy * (cropMarkOff + cropMarkLen)], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
            fabricSheet.add(new Line([cx + dx * cropMarkOff, cy, cx + dx * (cropMarkOff + cropMarkLen), cy], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
          }

          // Update progress
          setRenderProgress({ 
            current: (si * sheet.items.length) + (ii + 1), 
            total: impositionSheets.reduce((acc, s) => acc + s.items.length, 0) 
          });
          await new Promise(r => setTimeout(r, 0));
        }

        fabricSheet.renderAll();
        const blob = await new Promise<Blob>(res => sheetEl.toBlob(b => res(b!), 'image/png'));
        sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob });
        fabricSheet.dispose();
      }

      if (sheetBlobs.length === 1) downloadBlob(sheetBlobs[0].blob, sheetBlobs[0].name);
      else {
        downloadBlob(await createZipFromDataUrls(sheetBlobs), 'imposition-sheets.zip');
      }
    } catch (err) { 
      console.error('Imposition failed:', err);
      setError('Imposition failed.'); 
    } finally { 
      setIsImposing(false); 
      setShowImpositionModal(false); 
      setRenderProgress(null);
    }
  };

  const handleSubmitDesign = async () => {
    const allCanvases = surfaceStates.length > 1
      ? surfaceStates.flatMap(s => s.canvases)
      : canvases;
    if (allCanvases.length === 0) return;

    // Large jobs are rendered server-side; parent receives a job ID via postMessage
    if (allCanvases.length > SERVER_RENDER_THRESHOLD) {
      return executeServerRender();
    }

    setIsDownloading(true);
    setRenderProgress({ current: 0, total: allCanvases.length });
    try {
      const rendered: string[] = [];

      // Render sequentially to keep UI smooth and memory low
      for (let i = 0; i < allCanvases.length; i++) {
        const dataUrl = await renderCanvas(allCanvases[i], { isExport: true, includeMask: false });
        if (dataUrl) rendered.push(dataUrl);
        setRenderProgress({ current: i + 1, total: allCanvases.length });
        await new Promise(r => setTimeout(r, 0));
      }

      const surfacesPayload: Record<string, { index: number; dataUrl: string }[]> = {};
      if (surfaceStates.length > 1) {
        for (const s of surfaceStates) {
          surfacesPayload[s.key] = s.canvases.map((c, i) => ({ index: i, dataUrl: c.dataUrl || '' }));
        }
      }

      // Safeguard for postMessage payload size (e.g., 500MB+ limit)
      // If the batch is very large, we recommend the user to download the ZIP instead
      if (rendered.length > 100) {
        setUploadWarning("Large design batch. Submission might be slow. Consider 'Download ZIP' for high-res production files.");
      }

      window.parent.postMessage({
        type: 'PRODUCT_EDITOR_COMPLETE',
        layoutName: layout?.id,
        ...(surfaceStates.length > 1 ? { surfaces: surfacesPayload } : {}),
        canvases: rendered.map((dataUrl, i) => ({ index: i, dataUrl })),
      }, parentOrigin);
      setSubmitted(true);
    } catch { 
      setError('Failed to prepare design.'); 
    } finally { 
      setIsDownloading(false); 
      setRenderProgress(null);
    }
  };

  if (status === 'loading' && !embedToken) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
    </div>
  );
  if (layoutLoading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50">
      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Loading template…</p>
    </div>
  );
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
      {colorWarning && (
        <div className={`fixed ${uploadWarning ? 'top-44' : 'top-24'} right-8 z-[200001] max-w-sm bg-white/90 backdrop-blur-2xl border border-orange-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-orange-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group`}>
          <div className="w-7 h-7 mt-0.5 rounded-xl bg-orange-500/10 text-orange-600 flex items-center justify-center shrink-0">
            <span className="text-[13px] font-black">⚠</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black text-orange-900/90 uppercase tracking-tight leading-none mb-1">CMYK → RGB colour shift</p>
            <p className="text-[10px] font-medium text-orange-800/70 leading-snug">{colorWarning}</p>
          </div>
          <button onClick={() => setColorWarning(null)} className="p-2 mt-0.5 hover:bg-orange-50 rounded-xl transition-all shrink-0">
            <X className="w-3.5 h-3.5 text-orange-400" />
          </button>
        </div>
      )}
      {/* ── Under-upload banner ─────────────────────────────────────────────── */}
      {qtyUnder && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200002] w-full max-w-md bg-white/95 backdrop-blur-2xl border border-indigo-200/60 rounded-2xl shadow-2xl shadow-indigo-900/10 p-4 animate-in fade-in slide-in-from-top-4 duration-400">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 text-[15px] font-black">↑</div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">
                {qtyUnder.uploaded} of {qtyUnder.needed} images uploaded
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                {qtyUnder.needed - qtyUnder.uploaded} more needed to match your order quantity. You can upload more, or fill the remaining slots from your existing images.
              </p>
            </div>
            <button onClick={() => setQtyUnder(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-all shrink-0">
              <X className="w-3.5 h-3.5 text-slate-400" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoFill}
              className="flex-1 py-2 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
            >
              Auto-fill {qtyUnder.needed - qtyUnder.uploaded} remaining
            </button>
            <button
              onClick={() => { setShowAutoFillPicker(true); setPickerSelected(new Set()); }}
              className="flex-1 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
            >
              Choose which to repeat
            </button>
          </div>
        </div>
      )}

      {/* ── Auto-fill picker modal ──────────────────────────────────────────── */}
      {showAutoFillPicker && qtyUnder && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[12px] font-black text-slate-900 uppercase tracking-tight">Choose images to repeat</p>
              <button onClick={() => setShowAutoFillPicker(false)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-all">
                <X className="w-3.5 h-3.5 text-slate-400" />
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mb-3">
              Select {qtyUnder.needed - qtyUnder.uploaded} image{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''} to duplicate into the remaining slots.
            </p>
            <div className="grid grid-cols-3 gap-2 mb-4 max-h-56 overflow-y-auto custom-scrollbar">
              {files.map((f, i) => {
                const url = fileUrlCache.current.get(f) || URL.createObjectURL(f);
                const isSelected = pickerSelected.has(i);
                return (
                  <button
                    key={i}
                    onClick={() => setPickerSelected(prev => {
                      const next = new Set(prev);
                      isSelected ? next.delete(i) : next.add(i);
                      return next;
                    })}
                    className={clsx('relative aspect-square rounded-xl overflow-hidden border-2 transition-all active:scale-95', isSelected ? 'border-indigo-500 shadow-md shadow-indigo-200' : 'border-slate-200 hover:border-indigo-300')}
                  >
                    <img src={url} alt={f.name} className="w-full h-full object-cover" />
                    {isSelected && (
                      <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                        <div className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px] font-black">\u2713</div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleFillWithPicked}
              disabled={pickerSelected.size === 0}
              className="w-full py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Use selected to fill {qtyUnder.needed - qtyUnder.uploaded} slot{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}

      {/* ── Delete confirm modal ─────────────────────────────────────────────── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7 animate-in zoom-in-95 duration-200">
            <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Remove image?</p>
            <p className="text-xs text-slate-500 leading-relaxed mb-6">This image will be removed from the canvas. This cannot be undone.</p>
            <div className="flex items-center gap-3">
              <button
                onClick={confirmDelete}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-red-500 text-white rounded-xl hover:bg-red-600 transition-all active:scale-95"
              >
                Remove
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Over-upload confirm modal ───────────────────────────────────────── */}
      {pendingOverFiles && orderQty && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-in zoom-in-95 duration-200">
            <p className="text-[12px] font-black text-slate-900 uppercase tracking-tight mb-1">More images than ordered</p>
            <p className="text-[10px] text-slate-500 leading-snug mb-4">
              You uploaded <span className="font-black text-slate-800">{pendingOverFiles.length} images</span> but your order quantity is <span className="font-black text-slate-800">{orderQty}</span>. Do you want to proceed with all {pendingOverFiles.length}, or go back and remove some?
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleOverConfirm(true)}
                className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
              >
                Proceed with all {pendingOverFiles.length}
              </button>
              <button
                onClick={() => handleOverConfirm(false)}
                className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Go back
              </button>
            </div>
          </div>
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
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-tight truncate">
                  {layout?.dimensions ? `${layout.dimensions} | ` : ''}
                  {(files.length > 0 || surfaceStates.some(s => s.files.length > 0)) ? 'Generated Canvases' : 'Upload File'}
                </p>
                {/* Auto-save status indicator */}
                {isSaving === 'saving' && (
                  <span className="flex items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-widest shrink-0">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" /> Saving…
                  </span>
                )}
                {isSaving === 'saved' && (
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 uppercase tracking-widest shrink-0">
                    <CheckCircle2 className="w-2.5 h-2.5" /> Saved
                  </span>
                )}
                {orderId && (
                  <span className="text-[9px] font-mono text-slate-300 shrink-0 hidden sm:inline">
                    {orderId}
                  </span>
                )}
              </div>
            </div>
            <div className="flex-1 max-w-md relative group">
              <div className={clsx("relative flex items-center gap-3 px-4 py-2 rounded-2xl border-2 border-dashed transition-all", (files.length > 0 || surfaceStates.some(s => s.files.length > 0)) ? 'border-emerald-200 bg-emerald-50/30' : 'border-indigo-200 bg-indigo-50/30 hover:border-indigo-400')}>
                <input ref={uploadInputRef} type="file" multiple onChange={handleFileChange} accept="image/*" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
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

          {/* ── Fixed Processing Overlay ────────────────────────────────────── */}
          {(isProcessing || isDownloading) && renderProgress && (
            <div className="fixed inset-0 z-[300001] flex items-center justify-center bg-white/60 backdrop-blur-md animate-in fade-in duration-300">
              <div className="w-full max-w-sm bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 space-y-5 animate-in zoom-in-95 duration-300">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-black text-slate-900 uppercase tracking-tight">
                      {isDownloading ? 'Preparing Download' : 'Processing Your Design'}
                    </span>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      {isDownloading ? 'Bundling high-res print files' : 'Optimizing images for print'}
                    </span>
                  </div>
                  <span className="text-[14px] font-black text-indigo-600 tabular-nums bg-indigo-50 px-3 py-1 rounded-xl">
                    {Math.round((renderProgress.current / renderProgress.total) * 100)}%
                  </span>
                </div>
                
                <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden p-0.5">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300 ease-out shadow-[0_0_12px_rgba(99,102,241,0.4)]"
                    style={{ width: `${Math.round((renderProgress.current / renderProgress.total) * 100)}%` }}
                  />
                </div>
                
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">
                    {serverRenderLabel
                      ? serverRenderLabel
                      : isDownloading
                        ? (renderProgress.total === 100 ? `Zipping... ${renderProgress.current}%` : `Rendering File ${renderProgress.current} of ${renderProgress.total}`)
                        : `Rendering File ${renderProgress.current} of ${renderProgress.total}`
                    }
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Empty state (no canvases, not processing) ─────────────────── */}
          {!isProcessing && canvases.length === 0 && (
            <div 
              className={clsx(
                "flex flex-col items-center justify-center py-24 gap-5 select-none border-2 border-dashed rounded-3xl transition-all cursor-pointer",
                dragOverIdx?.idx === -1 
                  ? "border-indigo-500 bg-indigo-50/50 scale-[1.01]" 
                  : "border-slate-200 bg-slate-50/50"
              )}
              role="button"
              tabIndex={0}
              onClick={() => uploadInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                  e.preventDefault();
                  uploadInputRef.current?.click();
                }
              }}
              onDragOver={(e) => { e.preventDefault(); setDragOverIdx({ idx: -1, surfaceKey: null }); }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOverIdx(null);
                const droppedFiles = Array.from(e.dataTransfer.files);
                if (droppedFiles.length > 0) {
                  const event = { target: { files: e.dataTransfer.files } } as unknown as React.ChangeEvent<HTMLInputElement>;
                  handleFileChange(event);
                }
              }}
            >
              <div className="w-16 h-16 rounded-3xl bg-indigo-50 flex items-center justify-center">
                <Upload className="w-7 h-7 text-indigo-400" />
              </div>
              <div className="text-center space-y-1.5">
                <p className="text-[13px] font-black text-slate-800 uppercase tracking-tight">
                  No images selected
                </p>
                <p className="text-[11px] text-slate-400 font-medium max-w-[220px]">
                  Drag and drop your photos here, or use the upload bar above
                </p>
              </div>
            </div>
          )}

          {canvases.length > 0 && (
            <section className="space-y-6 pt-0">
              {surfaceStates.length > 1 ? (
                <div className="flex gap-6 items-start justify-center overflow-x-auto pb-4 px-4 w-full custom-scrollbar">
                  {surfaceStates.map((surface, sIdx) => {
                    const cw = surface.def.canvas?.width || 1200;
                    const ch = surface.def.canvas?.height || 1800;
                    const surfaceCanvas = surface.canvases[0] || null;
                    return (
                      <div 
                        key={surface.key} 
                        className="shrink-0 flex flex-col gap-3" 
                        style={{ width: cw > ch ? '400px' : '280px' }}
                        draggable
                        onDragStart={(e) => handleDragStart(e, 0, surface.key)}
                        onDragOver={(e) => handleDragOver(e, 0, surface.key)}
                        onDragLeave={() => setDragOverIdx(null)}
                        onDrop={(e) => handleDrop(e, 0, surface.key)}
                      >
                        <div className="flex items-center justify-between px-1">
                          <h3 className="text-xs font-black text-slate-900 uppercase tracking-tight truncate">{surface.label}</h3>
                          <button onClick={() => openEditor(0, surface.key)} className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100 uppercase tracking-wide">Edit</button>
                        </div>
                        <div className={clsx(
                          "bg-white rounded-2xl border-2 transition-all overflow-hidden cursor-pointer group/card relative",
                          dragOverIdx?.idx === 0 && dragOverIdx?.surfaceKey === surface.key 
                            ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100" 
                            : "border-slate-100 hover:border-indigo-400"
                        )} onClick={() => openEditor(0, surface.key)}>
                          <div className="relative overflow-hidden bg-slate-100" style={{ aspectRatio: `${cw} / ${ch}` }}>
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
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-5 justify-center">
                  {canvases.map((canvas, idx) => (
                    <div 
                      key={idx} 
                      className={clsx(
                        "bg-white rounded-2xl border-2 transition-all cursor-pointer group/card relative",
                        dragOverIdx?.idx === idx && dragOverIdx?.surfaceKey === null
                          ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100" 
                          : "border-slate-200 hover:border-indigo-400"
                      )}
                      onClick={() => openEditor(idx)}
                      draggable
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDragLeave={() => setDragOverIdx(null)}
                      onDrop={(e) => handleDrop(e, idx)}
                    >
                      <div className="relative rounded-t-2xl overflow-hidden bg-slate-100" style={{ aspectRatio: `${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}` }}>
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
              <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={() => setShowDownloadModal(false)} />
              <div className="relative w-full max-w-xs bg-white rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="flex items-center justify-between px-4 pt-3 pb-2">
                  <h3 className="text-[11px] font-black text-slate-900 uppercase tracking-tight">Download</h3>
                  <button onClick={() => setShowDownloadModal(false)} className="p-1 hover:bg-slate-100 rounded-full transition-colors">
                    <X className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                </div>
                <div className="px-3 pb-3 flex gap-2">
                  <button onClick={executeBatchDownload} className="flex-1 group flex flex-col items-center gap-1.5 p-3 rounded-xl border border-slate-100 hover:border-indigo-400 hover:bg-indigo-50/40 transition-all">
                    <Archive className="w-5 h-5 text-indigo-600" />
                    <span className="text-[10px] font-black text-slate-800 uppercase tracking-tight">ZIP</span>
                  </button>
                  <button onClick={() => { setShowDownloadModal(false); setShowImpositionModal(true); }} className="flex-1 group flex flex-col items-center gap-1.5 p-3 rounded-xl border border-slate-100 hover:border-emerald-400 hover:bg-emerald-50/40 transition-all">
                    <FileText className="w-5 h-5 text-emerald-600" />
                    <span className="text-[10px] font-black text-slate-800 uppercase tracking-tight">Imposition</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {showImpositionModal && isAdmin && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowImpositionModal(false)} />
              <div className="relative w-full max-w-4xl bg-white rounded-[40px] shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[90vh]">
                {/* Left: Preview */}
                <div className="flex-[1.2] bg-slate-100 p-8 flex flex-col items-center justify-center relative border-r border-slate-100">
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
