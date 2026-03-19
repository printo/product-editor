'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload, ChevronRight, Loader2, CheckCircle2, X,
  Wand2, Minus, Undo2, Redo2, Plus, Sparkles, Palette, Image, Hexagon, ImagePlus,
  Type, Trash2, AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { FabricImage } from 'fabric';
import type { CanvasItem, FrameState, TextOverlay, ShapeOverlay, ImageOverlay, FitMode, Overlay } from './types';
import { renderCanvas as renderCanvasCore } from './fabric-renderer';
import { AlignmentToolbar } from './AlignmentToolbar';
import { LayersPanel, type LayerSelection } from './LayersPanel';
import { FabricEditor, type FabricEditorHandle } from './FabricEditor';
import { ShapesPicker } from './ShapesPicker';
import { IconBrowser } from './IconBrowser';
import { ColorPicker } from '@/components/ColorPicker';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface CanvasEditorModalProps {
  activeCanvasIdx: number;
  editingCanvas: CanvasItem;
  canvases: CanvasItem[];
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
  onOpenCanvas: (idx: number) => void;

  // Bound image helpers from parent (using parent's caches)
  getFileUrl: (file: File) => string;
  loadGoogleFont: (name: string) => void;
  skipNextGenerateRef: React.MutableRefObject<boolean>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CanvasEditorModal({
  activeCanvasIdx, editingCanvas, canvases, layout, globalFitMode, selectedFonts,
  apiBase, getAuthHeaders,
  setEditingCanvas, setCanvases, setFiles, setError, onClose, onOpenCanvas,
  getFileUrl, loadGoogleFont, skipNextGenerateRef,
}: CanvasEditorModalProps) {

  // ── Local state (editor-only) ──────────────────────────────────────────────
  const [viewZoom, setViewZoom] = useState(1.0); // 1.0 = fit to viewport
  const [selectedLayer, setSelectedLayer] = useState<LayerSelection>({ type: 'frame', index: 0 });
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [activeAddTab, setActiveAddTab] = useState<'background' | 'text' | 'icon' | 'image' | 'shape'>('text');

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
      const dataUrl = fabricEditorRef.current?.toDataURL() ?? await renderCanvas(entry.canvas);
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
    const freshDataUrl = fabricEditorRef.current?.toFullResDataURL()
      ?? await renderCanvas(editingCanvas);
    const updated = [...canvases];
    updated[activeCanvasIdx] = { ...editingCanvas, dataUrl: freshDataUrl };
    setCanvases(updated);
    onClose();
  };

  // ── AI background removal ─────────────────────────────────────────────────
  const handleRemoveBackground = async (frameIdx: number) => {
    if (!editingCanvas || editingCanvas.frames[frameIdx].isRemovingBg) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

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
          const gen = ++renderGenRef.current;
          setTimeout(async () => {
            const dataUrl = fabricEditorRef.current?.toDataURL() ?? await renderCanvas(updatedCanvas!);
            if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
          }, 200);
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
      if ('x' in updates) u.offset.x = Math.abs(updates.x!) < 8 ? 0 : updates.x!;
      if ('y' in updates) u.offset.y = Math.abs(updates.y!) < 8 ? 0 : updates.y!;
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

    const imgSource = frameState.processedUrl || getFileUrl(frameState.originalFile);
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

  return (
    <div className="fixed inset-0 z-[100000] bg-white flex overflow-hidden animate-in fade-in duration-300">
      {/* Workspace — Fabric.js editor */}
      <div className="flex-1 bg-slate-100 flex flex-col overflow-hidden relative">

        {/* Floating close */}
        <button onClick={onClose}
          className="absolute top-4 right-4 z-30 p-2.5 bg-white/90 backdrop-blur-md border border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-white rounded-full shadow-lg transition-all">
          <X className="w-5 h-5" />
        </button>

        {/* Floating undo/redo + zoom — Gen-Z pill style */}
        <div className="absolute bottom-6 right-6 z-20 flex items-center gap-2">
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
          <div className="flex items-center gap-1 bg-white/80 backdrop-blur-xl border border-cyan-200/50 p-1 rounded-2xl shadow-lg">
            <button onClick={() => setViewZoom(p => Math.max(0.3, p - 0.15))} className="p-1.5 text-cyan-400 hover:text-cyan-600 hover:bg-cyan-50 rounded-xl transition-all"><Minus className="w-4 h-4" /></button>
            <button onClick={() => setViewZoom(1.0)} className="min-w-[48px] text-[10px] font-black text-cyan-500 uppercase tracking-tighter hover:text-cyan-700 transition-colors">
              {(viewZoom * 100).toFixed(0)}%
            </button>
            <button onClick={() => setViewZoom(p => Math.min(3, p + 0.15))} className="p-1.5 text-cyan-400 hover:text-cyan-600 hover:bg-cyan-50 rounded-xl transition-all"><Plus className="w-4 h-4" /></button>
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

      {/* ═══ Right Sidebar — Gen-Z colorful minimalist ═══ */}
      <div className="w-112 border-l border-slate-200/60 bg-gradient-to-b from-white via-slate-50/50 to-white flex flex-col overflow-hidden shrink-0">
        {/* Header — canvas navigation with gradient accent */}
        <div className="px-4 py-3 border-b border-slate-200/60 bg-gradient-to-r from-violet-50/80 to-cyan-50/80 flex items-center gap-2">
          <h3 className="text-xs font-extrabold bg-gradient-to-r from-violet-600 to-cyan-600 bg-clip-text text-transparent mr-auto tracking-tight">Canvas Editor</h3>
          <button disabled={activeCanvasIdx === 0} onClick={() => onOpenCanvas(activeCanvasIdx - 1)}
            className="p-1.5 text-violet-400 hover:text-violet-600 disabled:opacity-20 transition-all rounded-lg hover:bg-violet-100/50">
            <ChevronRight className="w-3.5 h-3.5 rotate-180" />
          </button>
          <span className="text-[10px] font-extrabold text-violet-400 tabular-nums bg-violet-100/60 px-2 py-0.5 rounded-full">{activeCanvasIdx + 1}/{canvases.length}</span>
          <button disabled={activeCanvasIdx === canvases.length - 1} onClick={() => onOpenCanvas(activeCanvasIdx + 1)}
            className="p-1.5 text-violet-400 hover:text-violet-600 disabled:opacity-20 transition-all rounded-lg hover:bg-violet-100/50">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Properties panel — context-sensitive */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* ── Frame properties ─────────────────────────────────────── */}
          {(selectedLayer.type === 'frame' || selectedLayer.type === 'canvas') && (() => {
            const fIdx = selectedLayer.type === 'canvas' ? 0 : selectedLayer.index;
            const frame = editingCanvas.frames[fIdx];
            if (!frame) return null;
            return (
              <div className="space-y-4">
                {/* AI Processing */}
                <div className="space-y-2">
                  <p className="text-[10px] font-extrabold text-violet-500 uppercase tracking-wider">AI Processing</p>
                  <button onClick={() => handleRemoveBackground(fIdx)}
                    disabled={frame.isRemovingBg || !!frame.processedUrl}
                    className="w-full flex items-center gap-2 px-3 py-2.5 bg-gradient-to-r from-violet-50 to-pink-50 border border-violet-200/50 rounded-2xl text-xs font-bold text-violet-700 hover:from-violet-100 hover:to-pink-100 transition-all disabled:opacity-50">
                    {frame.isRemovingBg ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-pink-500" /><span className="animate-pulse">Processing AI...</span></> : <><Wand2 className="w-3.5 h-3.5 text-pink-500" />{frame.processedUrl ? 'Background Removed' : 'Remove Background'}</>}
                  </button>
                </div>

                {/* Fit + Alignment */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-extrabold text-cyan-500 uppercase tracking-wider">Fit & Alignment</p>
                    <div className="flex items-center bg-cyan-50 rounded-xl p-0.5 border border-cyan-200/50">
                      {(['contain', 'cover'] as FitMode[]).map(mode => (
                        <button key={mode}
                          onClick={() => {
                            pushUndo(editingCanvas, true);
                            const newFrames = editingCanvas.frames.map((f, i) => i === fIdx ? { ...f, fitMode: mode } : f);
                            debouncedRender({ ...editingCanvas, frames: newFrames });
                          }}
                          className={clsx('px-3 py-1 text-[10px] font-extrabold rounded-lg transition-all text-center',
                            frame.fitMode === mode ? 'bg-white text-cyan-600 shadow-sm' : 'text-cyan-400 hover:text-cyan-600')}>
                          {mode === 'contain' ? 'Fit' : 'Cover'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <AlignmentToolbar
                    onHAlign={key => handleAlign(fIdx, key)}
                    onVAlign={key => handleAlign(fIdx, key)}
                  />
                </div>

                {/* Rotation */}
                <div className="space-y-2">
                  <p className="text-[10px] font-extrabold text-orange-500 uppercase tracking-wider">Rotation</p>
                  <div className="flex items-center gap-1.5">
                    {[0, 90, 180, 270].map(deg => (
                      <button key={deg}
                        onClick={() => handleUpdateTransform(fIdx, { rotation: deg })}
                        className={clsx('flex-1 px-1.5 py-1 text-[10px] font-extrabold rounded-xl transition-all text-center',
                          (frame.rotation || 0) === deg ? 'bg-gradient-to-r from-orange-500 to-pink-500 text-white shadow-md' : 'bg-orange-50 text-orange-400 hover:text-orange-600 border border-orange-200/50')}>
                        {deg}°
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0" max="359" step="1" value={frame.rotation || 0}
                      onChange={e => handleUpdateTransform(fIdx, { rotation: parseInt(e.target.value) })}
                      className="flex-1 accent-orange-500" />
                    <input type="number" min="0" max="359" value={frame.rotation || 0}
                      onChange={e => {
                        let v = parseInt(e.target.value) || 0;
                        v = ((v % 360) + 360) % 360;
                        handleUpdateTransform(fIdx, { rotation: v });
                      }}
                      className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-orange-200/50 rounded-xl bg-orange-50/50" />
                  </div>
                </div>

                {/* Zoom */}
                <div className="space-y-2">
                  <p className="text-[10px] font-extrabold text-emerald-500 uppercase tracking-wider">Zoom</p>
                  <div className="flex items-center gap-2">
                    <input type="range" min="10" max="300" step="10" value={Math.round(frame.scale * 100)}
                      onChange={e => handleUpdateTransform(fIdx, { scale: parseInt(e.target.value) / 100 })}
                      className="flex-1 accent-emerald-500" />
                    <input type="number" min="10" max="300" value={Math.round(frame.scale * 100)}
                      onChange={e => {
                        const v = Math.max(10, Math.min(300, parseInt(e.target.value) || 100));
                        handleUpdateTransform(fIdx, { scale: v / 100 });
                      }}
                      className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-emerald-200/50 rounded-xl bg-emerald-50/50" />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── Text properties ──────────────────────────────────────── */}
          {selectedLayer.type === 'text' && (() => {
            const oIdx = selectedLayer.index;
            const overlay = editingCanvas.overlays[oIdx];
            if (!overlay || overlay.type !== 'text') return null;
            const updateOverlay = (patch: Partial<TextOverlay>) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas, true);
              const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
              debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
            };

            return (
              <div className="space-y-4">
                {/* ── Text Properties Toolbar (Modern Single Row) ──────────────── */}
                <div className="flex items-center gap-1.5 p-1.5 bg-slate-100/50 rounded-2xl border border-slate-200/40">
                  {/* Font Dropdown */}
                  <div className="flex-1 min-w-0">
                    <select
                      value={overlay.fontFamily}
                      onChange={(e) => {
                        loadGoogleFont(e.target.value);
                        updateOverlay({ fontFamily: e.target.value });
                      }}
                      className="w-full h-8 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 px-1.5 focus:ring-1 focus:ring-violet-400 outline-none appearance-none cursor-pointer hover:bg-slate-50 transition-colors"
                      title="Font Family"
                    >
                      {selectedFonts.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                    </select>
                  </div>

                  {/* Font Size controls */}
                  <div className="flex items-center bg-white border border-slate-200 rounded-lg h-8 px-1 gap-1">
                    <button onClick={() => updateOverlay({ fontSize: Math.max(8, (overlay.fontSize || 24) - 2) })}
                      className="p-1 text-slate-400 hover:text-violet-600 transition-colors">
                      <Minus className="w-3 h-3" />
                    </button>
                    <input
                      type="number"
                      value={overlay.fontSize}
                      onChange={(e) => updateOverlay({ fontSize: Math.max(8, parseInt(e.target.value) || 24) })}
                      className="w-8 text-center text-[10px] font-black text-slate-700 bg-transparent border-none outline-none p-0"
                    />
                    <button onClick={() => updateOverlay({ fontSize: (overlay.fontSize || 24) + 2 })}
                      className="p-1 text-slate-400 hover:text-violet-600 transition-colors">
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Mini Color Picker */}
                  <div className="flex shrink-0">
                    <ColorPicker
                      value={overlay.color || '#000000'}
                      showHex={false}
                      onChange={color => updateOverlay({ color })}
                    />
                  </div>

                  {/* Alignment Toggles */}
                  <div className="flex items-center bg-white border border-slate-200 rounded-lg h-8 p-0.5 shadow-sm">
                    {([
                      { key: 'left' as const, icon: AlignLeft, tip: 'Left' },
                      { key: 'center' as const, icon: AlignCenter, tip: 'Center' },
                      { key: 'right' as const, icon: AlignRight, tip: 'Right' },
                    ]).map(({ key, icon: Icon, tip }) => (
                      <button
                        key={key}
                        onClick={() => updateOverlay({ textAlign: key })}
                        className={clsx(
                          'p-1.5 rounded-md transition-all',
                          overlay.textAlign === key ? 'bg-violet-100 text-violet-600 shadow-inner' : 'text-slate-400 hover:text-slate-600'
                        )}
                        title={`Align ${tip}`}
                      >
                        <Icon className="w-3 h-3" />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Text Content area (retained but polished) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest pl-1">Edit Content</p>
                    <span className="text-[9px] text-slate-300 font-medium">Synced with Canvas</span>
                  </div>
                  <textarea
                    value={overlay.text}
                    onChange={(e) => updateOverlay({ text: e.target.value })}
                    className="w-full h-24 text-xs bg-slate-50/80 border border-slate-200/60 rounded-xl p-3 focus:ring-2 focus:ring-violet-400 outline-none transition-all placeholder-slate-300 font-medium leading-relaxed"
                    placeholder="Type your text here..."
                  />
                </div>

                {/* Delete text */}
                <button onClick={() => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  debouncedRender({ ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== oIdx) });
                  setSelectedLayer({ type: 'frame', index: 0 });
                }} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all w-full">
                  <Trash2 className="w-3 h-3" /> Delete Text
                </button>
              </div>
            );
          })()}

          {/* ── Shape properties ──────────────────────────────────────── */}
          {selectedLayer.type === 'shape' && (() => {
            const oIdx = selectedLayer.index;
            const shape = editingCanvas.overlays[oIdx];
            if (!shape || shape.type !== 'shape') return null;
            const updateShape = (patch: Partial<ShapeOverlay>) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas);
              const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
              debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
            };
            return (
              <div className="space-y-4">
                <p className="text-[10px] font-extrabold text-purple-500 uppercase tracking-wider">
                  {shape.shapeType.charAt(0).toUpperCase() + shape.shapeType.slice(1).replace(/-/g, ' ')} Properties
                </p>

                {/* Fill & Stroke */}
                <div className="flex items-center gap-3">
                  <ColorPicker label="Fill" value={shape.fill} showHex={false}
                    onChange={fill => updateShape({ fill })} />
                  <ColorPicker label="Stroke" value={shape.stroke} showHex={false}
                    onChange={stroke => updateShape({ stroke })} />
                </div>

                {/* Stroke Width */}
                <div className="space-y-1">
                  <label className="text-[9px] font-extrabold text-purple-400 uppercase">Stroke Width</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0" max="20" step="1" value={shape.strokeWidth}
                      onChange={e => updateShape({ strokeWidth: parseInt(e.target.value) })}
                      className="flex-1 accent-purple-500" />
                    <span className="text-[10px] font-mono text-purple-400 w-6 text-center">{shape.strokeWidth}</span>
                  </div>
                </div>

                {/* Opacity */}
                <div className="space-y-1">
                  <label className="text-[9px] font-extrabold text-purple-400 uppercase">Opacity</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0" max="100" step="5" value={Math.round(shape.opacity * 100)}
                      onChange={e => updateShape({ opacity: parseInt(e.target.value) / 100 })}
                      className="flex-1 accent-purple-500" />
                    <span className="text-[10px] font-mono text-purple-400 w-8 text-center">{Math.round(shape.opacity * 100)}%</span>
                  </div>
                </div>

                {/* Rotation */}
                <div className="space-y-1">
                  <label className="text-[9px] font-extrabold text-purple-400 uppercase">Rotation</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0" max="359" step="1" value={shape.rotation}
                      onChange={e => updateShape({ rotation: parseInt(e.target.value) })}
                      className="flex-1 accent-purple-500" />
                    <input type="number" min="0" max="359" value={shape.rotation}
                      onChange={e => updateShape({ rotation: ((parseInt(e.target.value) || 0) % 360 + 360) % 360 })}
                      className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-purple-200/50 rounded-xl bg-purple-50/30" />
                  </div>
                </div>

                {/* Delete shape */}
                <button onClick={() => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  debouncedRender({ ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== oIdx) });
                  setSelectedLayer({ type: 'frame', index: 0 });
                }} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all w-full">
                  <Trash2 className="w-3 h-3" /> Delete Shape
                </button>
              </div>
            );
          })()}

          {/* ── Image overlay properties ───────────────────────────── */}
          {selectedLayer.type === 'image' && (() => {
            const oIdx = selectedLayer.index;
            const imgOverlay = editingCanvas.overlays[oIdx];
            if (!imgOverlay || imgOverlay.type !== 'image') return null;
            const updateImage = (patch: Partial<ImageOverlay>) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas);
              const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
              debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
            };
            return (
              <div className="space-y-4">
                <p className="text-[10px] font-extrabold text-emerald-500 uppercase tracking-wider">
                  Icon Properties
                </p>

                {/* Preview */}
                <div className="flex items-center gap-3 p-2.5 bg-emerald-50/50 rounded-2xl border border-emerald-200/50">
                  <img src={imgOverlay.src} alt={imgOverlay.label} className="w-10 h-10 object-contain" />
                  <span className="text-[11px] text-emerald-700 font-medium truncate flex-1">{imgOverlay.label}</span>
                </div>

                {/* Opacity */}
                <div className="space-y-1">
                  <label className="text-[9px] font-extrabold text-emerald-400 uppercase">Opacity</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0" max="100" step="5" value={Math.round(imgOverlay.opacity * 100)}
                      onChange={e => updateImage({ opacity: parseInt(e.target.value) / 100 })}
                      className="flex-1 accent-emerald-500" />
                    <span className="text-[10px] font-mono text-emerald-400 w-8 text-center">{Math.round(imgOverlay.opacity * 100)}%</span>
                  </div>
                </div>

                {/* Rotation */}
                <div className="space-y-1">
                  <label className="text-[9px] font-extrabold text-emerald-400 uppercase">Rotation</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0" max="359" step="1" value={imgOverlay.rotation}
                      onChange={e => updateImage({ rotation: parseInt(e.target.value) })}
                      className="flex-1 accent-emerald-500" />
                    <input type="number" min="0" max="359" value={imgOverlay.rotation}
                      onChange={e => updateImage({ rotation: ((parseInt(e.target.value) || 0) % 360 + 360) % 360 })}
                      className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-emerald-200/50 rounded-xl bg-emerald-50/30" />
                  </div>
                </div>

                {/* Delete */}
                <button onClick={() => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  debouncedRender({ ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== oIdx) });
                  setSelectedLayer({ type: 'frame', index: 0 });
                }} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all w-full">
                  <Trash2 className="w-3 h-3" /> Delete Icon
                </button>
              </div>
            );
          })()}

          {/* ── Add Objects Tabs ────────────────────────────────────────── */}
          <div className="pt-2 space-y-3">
            <div className="flex items-center p-1 bg-slate-100/80 backdrop-blur-sm rounded-2xl border border-slate-200/50 w-full">
              {ADD_TABS.map(tab => {
                const isActive = activeAddTab === tab.key;
                const Icon = tab.icon;
                return (
                  <button key={tab.key} onClick={() => setActiveAddTab(tab.key)}
                    className={clsx('flex-1 flex flex-col items-center justify-center gap-1 py-2 rounded-xl transition-all',
                      isActive ? `bg-white shadow-sm ring-1 ${tab.activeClass}` : 'text-slate-400 hover:text-slate-600 hover:bg-white/40')}>
                    <Icon className="w-4 h-4" />
                    <span className="text-[9px] font-black uppercase tracking-tighter">{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="min-h-[60px] animate-in fade-in slide-in-from-bottom-2 duration-300">
              {activeAddTab === 'background' && (
                <div className="flex items-center justify-between p-3 bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl border border-amber-200/40">
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-extrabold text-amber-600 uppercase tracking-wider">Canvas BG</p>
                    <p className="text-[9px] text-amber-500/70 font-medium tracking-tight">Set base paper color</p>
                  </div>
                  <ColorPicker value={editingCanvas?.bgColor || '#ffffff'}
                    onChange={color => {
                      if (!editingCanvas) return;
                      pushUndo(editingCanvas, true);
                      debouncedRender({ ...editingCanvas, bgColor: color });
                    }} />
                </div>
              )}

              {activeAddTab === 'text' && (
                <button onClick={() => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  const newOverlay: Overlay = {
                    type: 'text',
                    id: Date.now(),
                    text: 'New Text',
                    x: 50, y: 50,
                    fontSize: Math.round((layout?.canvas?.height || 1800) * 0.04),
                    color: '#000000',
                    fontFamily: selectedFonts[0] || 'sans-serif',
                    textAlign: 'center',
                    rotation: 0,
                  };
                  const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                  debouncedRender(updated);
                  setSelectedLayer({ type: 'text', index: updated.overlays.length - 1 });
                }} className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-gradient-to-r from-pink-500 to-violet-500 text-white rounded-2xl text-xs font-black hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] transition-all border-none">
                  <Type className="w-4 h-4 shadow-sm" /> ADD TEXT OVERLAY
                </button>
              )}

              {activeAddTab === 'shape' && (
                <ShapesPicker onAddShape={(shape) => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  const newOverlay: Overlay = { type: 'shape', ...shape };
                  const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                  debouncedRender(updated);
                  setSelectedLayer({ type: 'shape', index: updated.overlays.length - 1 });
                }} />
              )}

              {activeAddTab === 'icon' && (
                <IconBrowser onAddImage={(imgOverlay) => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  const newOverlay: Overlay = { type: 'image', ...imgOverlay };
                  const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                  debouncedRender(updated);
                  setSelectedLayer({ type: 'image', index: updated.overlays.length - 1 });
                }} />
              )}

              {activeAddTab === 'image' && (
                <div className="space-y-4">
                  {/* Option 1: Add as Overlay to CURRENT */}
                  <label className="group relative flex flex-col items-center justify-center gap-2 p-5 bg-gradient-to-br from-violet-50 to-fuchsia-50 border-2 border-dashed border-violet-200/50 rounded-3xl text-violet-600 hover:from-violet-100 hover:to-fuchsia-100 transition-all cursor-pointer overflow-hidden shadow-sm">
                    <div className="p-3 bg-white rounded-2xl shadow-sm text-violet-500 group-hover:scale-110 transition-transform">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-black uppercase tracking-tight">Add to Current Canvas</p>
                      <p className="text-[9px] text-violet-400 font-bold uppercase tracking-widest opacity-60 mt-0.5">Add as floating overlay</p>
                    </div>
                    <input type="file" multiple accept="image/*" className="hidden"
                      onChange={async (e) => {
                        if (!e.target.files?.length || !editingCanvas) return;
                        pushUndo(editingCanvas, true);
                        const files = Array.from(e.target.files);
                        e.target.value = '';
                        
                        let updated = { ...editingCanvas };
                        for (const file of files) {
                          const newOverlay: Overlay = {
                            id: Math.random().toString(36).substr(2, 9),
                            type: 'image',
                            src: getFileUrl(file),
                            originalFile: file,
                            source: 'local',
                            x: 50, y: 50, width: 30, height: 30, rotation: 0, opacity: 1,
                            label: file.name
                          };
                          updated = { ...updated, overlays: [...updated.overlays, newOverlay] };
                        }
                        
                        debouncedRender(updated);
                        setSelectedLayer({ type: 'image', index: updated.overlays.length - 1 });
                      }} />
                  </label>

                  <div className="flex items-center gap-3 px-2">
                    <div className="h-[1px] flex-1 bg-slate-200/60" />
                    <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">or</span>
                    <div className="h-[1px] flex-1 bg-slate-200/60" />
                  </div>

                  {/* Option 2: Bulk Create NEW Canvases */}
                  <label className="group relative flex flex-col items-center justify-center gap-2 p-5 bg-gradient-to-br from-sky-50 to-cyan-50 border-2 border-dashed border-sky-200/50 rounded-3xl text-sky-600 hover:from-sky-100 hover:to-cyan-100 transition-all cursor-pointer overflow-hidden opacity-80 hover:opacity-100">
                    <div className="p-3 bg-white rounded-2xl shadow-sm text-sky-500 group-hover:scale-110 transition-transform">
                      <Upload className="w-5 h-5" />
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-black uppercase tracking-tight">Bulk Create Layouts</p>
                      <p className="text-[8px] text-sky-400 font-bold uppercase tracking-widest opacity-60 mt-0.5">Generate multiple new pages</p>
                    </div>
                    <input type="file" multiple accept="image/*" className="hidden"
                      onChange={async (e) => {
                        if (!e.target.files?.length || !layout) return;
                        const addedFiles = Array.from(e.target.files);
                        e.target.value = '';
                        const frameCount = layout.frames?.length || 1;
                        const startId = canvases.length;
                        const newCanvasCount = Math.ceil(addedFiles.length / frameCount);
                        const newCanvases: CanvasItem[] = [];
                        for (let i = 0; i < newCanvasCount; i++) {
                          const canvasFrames: FrameState[] = [];
                          for (let f = 0; f < frameCount; f++) {
                            const file = addedFiles[(i * frameCount + f) % addedFiles.length];
                            if (file) canvasFrames.push({
                              id: f, originalFile: file, processedUrl: null,
                              offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: globalFitMode,
                              isRemovingBg: false, isDetectingProduct: false,
                            });
                          }
                          const item: CanvasItem = {
                            id: startId + i,
                            frames: canvasFrames,
                            overlays: [],
                            bgColor: '#ffffff',
                            dataUrl: null
                          };
                          item.dataUrl = await renderCanvas(item);
                          newCanvases.push(item);
                        }
                        setCanvases(prev => [...prev, ...newCanvases]);
                        skipNextGenerateRef.current = true;
                        setFiles(prev => [...prev, ...addedFiles]);
                      }} />
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Layers Panel */}
        <LayersPanel
          editingCanvas={editingCanvas}
          selected={selectedLayer}
          onSelect={setSelectedLayer}
          onDeleteOverlay={(oIdx) => {
            if (!editingCanvas) return;
            pushUndo(editingCanvas, true);
            const updated = { ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== oIdx) };
            debouncedRender(updated);
            if (selectedLayer.index === oIdx) setSelectedLayer({ type: 'frame', index: 0 });
            else if (selectedLayer.index > oIdx) setSelectedLayer({ ...selectedLayer, index: selectedLayer.index - 1 });
          }}
          onReorderOverlays={(newOverlays) => {
            if (!editingCanvas) return;
            pushUndo(editingCanvas, true);
            debouncedRender({ ...editingCanvas, overlays: newOverlays });
          }}
          onClearFrame={(fIdx) => {
            if (!editingCanvas) return;
            pushUndo(editingCanvas, true);
            const newFrames = editingCanvas.frames.map((f, i) =>
              i === fIdx ? { ...f, processedUrl: null, offset: { x: 0, y: 0 }, scale: 1, rotation: 0 } : f
            );
            debouncedRender({ ...editingCanvas, frames: newFrames });
          }}
        />

        {/* Save button — Gen-Z gradient */}
        <div className="px-3 py-2.5 bg-white border-t border-slate-200/60">
          <button onClick={handleSaveChanges}
            className="w-full py-2.5 bg-gradient-to-r from-violet-600 via-purple-600 to-pink-600 text-white rounded-2xl text-xs font-extrabold hover:from-violet-700 hover:via-purple-700 hover:to-pink-700 transition-all flex items-center justify-center gap-1.5 active:scale-[0.98] shadow-lg shadow-purple-200">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
