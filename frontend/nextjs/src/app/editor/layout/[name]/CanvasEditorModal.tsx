'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, CheckCircle2, X, Minus, Undo2, Redo2, Plus, Sparkles, Palette, Image, Hexagon, ImagePlus, Type, Trash2, AlignLeft, AlignCenter, AlignRight, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
  import { FabricImage } from 'fabric';
import type { CanvasItem, FrameState, TextOverlay, ShapeOverlay, ImageOverlay, FitMode, Overlay, SurfaceState } from './types';
import { renderCanvas as renderCanvasCore } from './fabric-renderer';
import { AlignmentToolbar } from './AlignmentToolbar';
import { LayersPanel, type LayerSelection } from './LayersPanel';
import { FabricEditor, type FabricEditorHandle } from './FabricEditor';
import { ShapesPicker } from './ShapesPicker';
import { IconBrowser } from './IconBrowser';
import { ColorPicker } from '@/components/ColorPicker';
import { CanvasEditorSidebar } from './CanvasEditorSidebar';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface CanvasEditorModalProps {
  activeCanvasIdx: number;
  editingCanvas: CanvasItem;
  canvases: CanvasItem[];
  surfaceStates?: SurfaceState[];
  activeSurfaceKey?: string;
  layout: any;
  globalFitMode: FitMode;
  selectedFonts: string[];

  apiBase: string;
  getAuthHeaders: () => Record<string, string>;

  setEditingCanvas: React.Dispatch<React.SetStateAction<CanvasItem | null>>;
  setCanvases: React.Dispatch<React.SetStateAction<CanvasItem[]>>;
  setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  setError: (msg: string | null) => void;
  onClose: () => void;
  onOpenCanvas: (idx: number, surfaceKey?: string) => void;

  // Bound image helpers from parent (using parent's caches)
  getFileUrl: (file: File) => string;
  loadGoogleFont: (name: string) => void;
  skipNextGenerateRef: React.MutableRefObject<boolean>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CanvasEditorModal({
  activeCanvasIdx, editingCanvas, canvases, surfaceStates, activeSurfaceKey, layout, globalFitMode, selectedFonts,
  apiBase, getAuthHeaders,
  setEditingCanvas, setCanvases, setFiles, setError, onClose, onOpenCanvas,
  getFileUrl, loadGoogleFont, skipNextGenerateRef,
}: CanvasEditorModalProps) {

  // ── Local state (editor-only) ──────────────────────────────────────────────
  const [viewZoom, setViewZoom] = useState(1.0); // 1.0 = fit to viewport
  const [selectedLayer, setSelectedLayer] = useState<LayerSelection>({ type: 'frame', index: 0 });
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  // Refs
  // Undo/redo entry: React state + Fabric canvas JSON snapshot
  type UndoEntry = { canvas: CanvasItem; fabricJSON: object | null };
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const lastPushTime = useRef(0);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderGenRef = useRef(0);
  const fabricEditorRef = useRef<FabricEditorHandle>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    };
  }, []);

  // ── Canvas render wrapper ─────────────────────────────────────────────────
  const renderCanvas = useCallback(async (
    canvasItem: CanvasItem,
    excludeFrameIdx: number | null = null,
    isExport = false,
    includeMask = true,
    layoutOverride?: any,
  ) => {
    return renderCanvasCore(canvasItem, layout, getFileUrl, {
      excludeFrameIdx, isExport, includeMask, layoutOverride,
    });
  }, [layout, getFileUrl]);

  // ── Clone helper ──────────────────────────────────────────────────────────
  const cloneCanvas = useCallback((c: CanvasItem): CanvasItem => ({
    ...c,
    frames: c.frames.map(f => ({ ...f, offset: { ...f.offset }, originalFile: f.originalFile })),
    overlays: c.overlays.map(o => ({ ...o })),
  }), []);

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  const pushUndo = useCallback((snapshot: CanvasItem, force = false) => {
    const now = Date.now();
    if (!force && now - lastPushTime.current < 300 && undoStack.current.length > 0) return;
    lastPushTime.current = now;
    // ✅ #7 Pair React state with Fabric canvas JSON for reliable undo
    const fabricJSON = fabricEditorRef.current?.getCanvasJSON() ?? null;
    undoStack.current.push({ canvas: cloneCanvas(snapshot), fabricJSON });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
    setRedoCount(0);
  }, [cloneCanvas]);

  const handleUndo = useCallback(async () => {
    if (undoStack.current.length === 0 || !editingCanvas) return;
    const currentFabricJSON = fabricEditorRef.current?.getCanvasJSON() ?? null;
    redoStack.current.push({ canvas: cloneCanvas(editingCanvas), fabricJSON: currentFabricJSON });
    const entry = undoStack.current.pop()!;
    setEditingCanvas(entry.canvas);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    // ✅ Restore Fabric canvas visuals instantly from JSON snapshot
    if (entry.fabricJSON && fabricEditorRef.current?.loadCanvasJSON) {
      await fabricEditorRef.current.loadCanvasJSON(entry.fabricJSON);
    }
    const gen = ++renderGenRef.current;
        setTimeout(async () => {
      const dataUrl = fabricEditorRef.current?.toDataURL(true) ?? await renderCanvas(entry.canvas);
      if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
    }, 100);
  }, [editingCanvas, renderCanvas, cloneCanvas, setEditingCanvas]);

  const handleRedo = useCallback(async () => {
    if (redoStack.current.length === 0 || !editingCanvas) return;
    const currentFabricJSON = fabricEditorRef.current?.getCanvasJSON() ?? null;
    undoStack.current.push({ canvas: cloneCanvas(editingCanvas), fabricJSON: currentFabricJSON });
    const entry = redoStack.current.pop()!;
    setEditingCanvas(entry.canvas);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    if (entry.fabricJSON && fabricEditorRef.current?.loadCanvasJSON) {
      await fabricEditorRef.current.loadCanvasJSON(entry.fabricJSON);
    }
    const gen = ++renderGenRef.current;
    setTimeout(async () => {
      const dataUrl = fabricEditorRef.current?.toDataURL() ?? await renderCanvas(entry.canvas);
      if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
    }, 100);
  }, [editingCanvas, renderCanvas, cloneCanvas, setEditingCanvas]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if (mod && e.key === 'z' && e.shiftKey) { e.preventDefault(); handleRedo(); }
      if (mod && e.key === 'y') { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo]);

  // ── Editor save ───────────────────────────────────────────────────────────
    const handleSaveChanges = async () => {
    if (!editingCanvas) return;
    if (renderTimeoutRef.current) { clearTimeout(renderTimeoutRef.current); renderTimeoutRef.current = null; }
    const freshDataUrl = fabricEditorRef.current?.toFullResDataURL(false)
      ?? await renderCanvas(editingCanvas, null, true, false);
    const updated = [...canvases];
    updated[activeCanvasIdx] = { ...editingCanvas, dataUrl: freshDataUrl };
    setCanvases(updated);
    onClose();
  };

  // ── Transform update ──────────────────────────────────────────────────────
  const handleUpdateTransform = useCallback((
    frameIdx: number,
    updates: Partial<{ scale: number; x: number; y: number; rotation: number }>,
  ) => {
    if (!editingCanvas) return;
    pushUndo(editingCanvas);
    const newFrames = editingCanvas.frames.map((f, i) => {
      if (i !== frameIdx) return f;
      const u = { ...f, offset: { ...f.offset } };
      if ('scale' in updates) u.scale = updates.scale!;
      if ('x' in updates) u.offset.x = updates.x!;
      if ('y' in updates) u.offset.y = updates.y!;
      if ('rotation' in updates) u.rotation = updates.rotation!;
      return u;
    });
    const finalized = { ...editingCanvas, frames: newFrames };
    debouncedRender(finalized);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCanvas, pushUndo]);

  // ── Frame Alignment ────────────────────────────────────────────────────────
  const handleAlign = async (
    frameIdx: number,
    alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
  ) => {
    if (!editingCanvas || !layout) return;
    const frameState = editingCanvas.frames[frameIdx];
    if (!frameState) return;

    const canvasW = layout.canvas?.width || 1200;
    const canvasH = layout.canvas?.height || 1800;
    const frameSpec = layout.frames?.[frameIdx] || { x: 0, y: 0, width: canvasW, height: canvasH };
    const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
    const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
    const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;

    const file = frameState.originalFile;
    if (!file) return;
    const imgSource = getFileUrl(file);
    const fabricImg = await FabricImage.fromURL(imgSource, { crossOrigin: 'anonymous' });
    const imgW = fabricImg.width!;
    const imgH = fabricImg.height!;
    const rot = frameState.rotation || 0;
    const rad = (rot * Math.PI) / 180;
    const sinA = Math.abs(Math.sin(rad));
    const cosA = Math.abs(Math.cos(rad));
    const effW = imgW * cosA + imgH * sinA;
    const effH = imgW * sinA + imgH * cosA;
    const baseScale = frameState.fitMode === 'cover'
      ? Math.max(fw / effW, fh / effH)
      : Math.min(fw / effW, fh / effH);
    const finalScale = baseScale * frameState.scale;
    const w = effW * finalScale;
    const h = effH * finalScale;

    switch (alignment) {
      case 'left':   handleUpdateTransform(frameIdx, { x: -(fw - w) / 2 }); break;
      case 'center': handleUpdateTransform(frameIdx, { x: 0 }); break;
      case 'right':  handleUpdateTransform(frameIdx, { x: (fw - w) / 2 }); break;
      case 'top':    handleUpdateTransform(frameIdx, { y: -(fh - h) / 2 }); break;
      case 'middle': handleUpdateTransform(frameIdx, { y: 0 }); break;
      case 'bottom': handleUpdateTransform(frameIdx, { y: (fh - h) / 2 }); break;
    }
  };

  const handleOverlayAlign = (
    overlayIdx: number,
    alignment: 'center' | 'middle',
  ) => {
    if (!editingCanvas) return;
    pushUndo(editingCanvas);
    const newOverlays = editingCanvas.overlays.map((o, i) => {
      if (i !== overlayIdx) return o;
      if (alignment === 'center') return { ...o, x: 50 };
      if (alignment === 'middle') return { ...o, y: 50 };
      return o;
    });
    debouncedRender({ ...editingCanvas, overlays: newOverlays });
  };

  // ── Debounced render helper ───────────────────────────────────────────────
  const debouncedRender = useCallback((updated: CanvasItem) => {
    setEditingCanvas(updated);
    if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    const gen = ++renderGenRef.current;
    renderTimeoutRef.current = setTimeout(async () => {
      const fabricDataUrl = fabricEditorRef.current?.toDataURL();
      if (fabricDataUrl && renderGenRef.current === gen) {
        setEditingCanvas(p => p ? { ...p, dataUrl: fabricDataUrl } : p);
      } else {
        const dataUrl = await renderCanvas(updated);
        if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
      }
    }, 80);
  }, [renderCanvas, setEditingCanvas]);

  const ADD_TABS = [
    { key: 'background' as const, icon: Palette, label: 'BG', activeClass: 'text-amber-600 ring-amber-100' },
    { key: 'text' as const, icon: Type, label: 'Text', activeClass: 'text-pink-600 ring-pink-100' },
    { key: 'shape' as const, icon: Hexagon, label: 'Shape', activeClass: 'text-purple-600 ring-purple-100' },
    { key: 'icon' as const, icon: Sparkles, label: 'Icon', activeClass: 'text-violet-600 ring-violet-100' },
    { key: 'image' as const, icon: Image, label: 'Image', activeClass: 'text-sky-600 ring-sky-100' },
  ];

  // ── Fabric canvas change handler ──────────────────────────────────────────
  const handleFabricChange = useCallback((updated: CanvasItem) => {
    pushUndo(editingCanvas, true);
    debouncedRender(updated);
  }, [editingCanvas, pushUndo, debouncedRender]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isMultiSurface = surfaceStates && surfaceStates.length > 1;
  const currentIdx = isMultiSurface 
    ? surfaceStates.findIndex(s => s.key === activeSurfaceKey)
    : activeCanvasIdx;
  const totalCount = isMultiSurface ? surfaceStates.length : canvases.length;

  return (
    <div className="fixed inset-0 z-[100000] bg-white flex overflow-hidden animate-in fade-in duration-300">
      {/* Workspace — Fabric.js editor */}
      <div className="flex-1 bg-slate-100 flex flex-col overflow-hidden relative">

        {/* Floating close */}
        <button onClick={onClose}
          className="absolute top-4 right-4 z-30 p-2.5 bg-white/90 backdrop-blur-md border border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-white rounded-full shadow-lg transition-all">
          <X className="w-5 h-5" />
        </button>

        {/* Left Surface Rail — Vertical floating list for Multi-surface layouts */}
        {isMultiSurface && (
          <div className="absolute left-12 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2 p-1.5 bg-white/80 backdrop-blur-xl border border-indigo-100/50 rounded-2xl shadow-xl animate-in slide-in-from-left-8 duration-700 max-h-[70vh] overflow-y-auto custom-scrollbar">
            {surfaceStates.map((s, idx) => {
              const isActive = s.key === activeSurfaceKey;
              return (
                <button
                  key={s.key}
                  onClick={() => onOpenCanvas(0, s.key)}
                  className={clsx(
                    "px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-500 whitespace-nowrap text-left flex items-center gap-3 group",
                    isActive 
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200 translate-x-1" 
                      : "text-slate-400 hover:text-indigo-600 hover:bg-indigo-50/50"
                  )}
                >
                  <span className={clsx("w-5 text-center transition-colors font-black", isActive ? "text-indigo-200" : "text-slate-300 group-hover:text-indigo-300")}>
                    {idx + 1}
                  </span>
                  {s.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Floating Controls — Gen-Z pill style */}
        <div className="absolute bottom-6 right-6 z-20 flex flex-col items-end gap-3">
          
          {/* Navigation Hub (Simple Arrows + Numeric Counter) */}
          <div className="flex items-center gap-1 bg-white/80 backdrop-blur-xl border border-slate-200/50 p-1 rounded-2xl shadow-lg animate-in slide-in-from-bottom-2 duration-500 w-[140px] justify-between">
            <button 
              disabled={currentIdx === 0} 
              onClick={() => {
                if (isMultiSurface) onOpenCanvas(0, surfaceStates[currentIdx - 1].key);
                else onOpenCanvas(currentIdx - 1);
              }}
              className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all rounded-xl hover:bg-slate-50 active:scale-90"
            >
              <ChevronRight className="w-4 h-4 rotate-180" />
            </button>

            <span className="text-[10px] font-black text-slate-700 tabular-nums px-1 min-w-[48px] text-center uppercase tracking-tighter">
              {currentIdx + 1}
              <span className="mx-1 text-slate-300">/</span>
              {totalCount}
            </span>

            <button 
              disabled={currentIdx === totalCount - 1} 
              onClick={() => {
                if (isMultiSurface) onOpenCanvas(0, surfaceStates[currentIdx + 1].key);
                else onOpenCanvas(currentIdx + 1);
              }}
              className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-20 transition-all rounded-xl hover:bg-slate-50 active:scale-90"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-white/80 backdrop-blur-xl border border-violet-200/50 p-1 rounded-2xl shadow-lg">
              <button onClick={handleUndo} disabled={undoCount === 0}
                className="p-2 text-violet-400 hover:text-violet-600 hover:bg-violet-50 rounded-xl transition-all disabled:opacity-20" title="Undo (Ctrl+Z)">
                <Undo2 className="w-4 h-4" />
              </button>
              <button onClick={handleRedo} disabled={redoCount === 0}
                className="p-2 text-violet-400 hover:text-violet-600 hover:bg-violet-50 rounded-xl transition-all disabled:opacity-20" title="Redo (Ctrl+Shift+Z)">
                <Redo2 className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-1 bg-white/80 backdrop-blur-xl border border-cyan-200/50 p-1 rounded-2xl shadow-lg w-[140px] justify-between">
              <button onClick={() => setViewZoom(p => Math.max(0.3, p - 0.15))} className="p-1.5 text-cyan-400 hover:text-cyan-600 hover:bg-cyan-50 rounded-xl transition-all"><Minus className="w-4 h-4" /></button>
              <button onClick={() => setViewZoom(1.0)} className="min-w-[48px] text-[10px] font-black text-cyan-500 uppercase tracking-tighter hover:text-cyan-700 transition-colors">
                {(viewZoom * 100).toFixed(0)}%
              </button>
              <button onClick={() => setViewZoom(p => Math.min(3, p + 0.15))} className="p-1.5 text-cyan-400 hover:text-cyan-600 hover:bg-cyan-50 rounded-xl transition-all"><Plus className="w-4 h-4" /></button>
            </div>
          </div>
        </div>

        {/* Fabric.js Canvas Editor — fills workspace */}
        <FabricEditor
          ref={fabricEditorRef}
          editingCanvas={editingCanvas}
          layout={layout}
          viewZoom={viewZoom}
          selectedLayer={selectedLayer}
          onCanvasChange={handleFabricChange}
          onLayerSelect={setSelectedLayer}
          getFileUrl={getFileUrl}
          canvasWidth={layout?.canvas?.width}
          canvasHeight={layout?.canvas?.height}
        />
      </div>

      {/* ═══ Right Sidebar — Gen-Z vibrant glassmorphism ═══ */}
      <CanvasEditorSidebar
        key={`sidebar-${surfaceStates && surfaceStates.length > 1 ? activeSurfaceKey : activeCanvasIdx}`}
        editingCanvas={editingCanvas}
        layout={layout}
        selectedLayer={selectedLayer}
        setSelectedLayer={setSelectedLayer}
        handleAlign={handleAlign}
        handleOverlayAlign={handleOverlayAlign}
        handleUpdateTransform={handleUpdateTransform}
        handleSaveChanges={handleSaveChanges}
        getFileUrl={getFileUrl}
        debouncedRender={debouncedRender}
        pushUndo={pushUndo}
        loadGoogleFont={loadGoogleFont}
        selectedFonts={selectedFonts}
      />
    </div>
  );
}
