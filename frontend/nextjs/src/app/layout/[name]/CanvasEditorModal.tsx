'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload, ChevronRight, Loader2, CheckCircle2, X,
  Wand2, Minus, Undo2, Redo2, Plus,
  Type, Trash2, AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { FabricImage } from 'fabric';
import type { CanvasItem, FrameState, TextOverlay, ShapeOverlay, ImageOverlay, FitMode } from './types';
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

  // Refs
  const undoStack = useRef<CanvasItem[]>([]);
  const redoStack = useRef<CanvasItem[]>([]);
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
    textOverlays: c.textOverlays.map(t => ({ ...t })),
    shapeOverlays: c.shapeOverlays.map(s => ({ ...s })),
    imageOverlays: c.imageOverlays.map(img => ({ ...img })),
  }), []);

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  const pushUndo = useCallback((snapshot: CanvasItem, force = false) => {
    const now = Date.now();
    if (!force && now - lastPushTime.current < 300 && undoStack.current.length > 0) return;
    lastPushTime.current = now;
    undoStack.current.push(cloneCanvas(snapshot));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
    setRedoCount(0);
  }, [cloneCanvas]);

  const handleUndo = useCallback(async () => {
    if (undoStack.current.length === 0 || !editingCanvas) return;
    redoStack.current.push(cloneCanvas(editingCanvas));
    const prev = undoStack.current.pop()!;
    setEditingCanvas(prev);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    const gen = ++renderGenRef.current;
    setTimeout(async () => {
      const dataUrl = fabricEditorRef.current?.toDataURL() ?? await renderCanvas(prev);
      if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
    }, 150);
  }, [editingCanvas, renderCanvas, cloneCanvas, setEditingCanvas]);

  const handleRedo = useCallback(async () => {
    if (redoStack.current.length === 0 || !editingCanvas) return;
    undoStack.current.push(cloneCanvas(editingCanvas));
    const next = redoStack.current.pop()!;
    setEditingCanvas(next);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    const gen = ++renderGenRef.current;
    setTimeout(async () => {
      const dataUrl = fabricEditorRef.current?.toDataURL() ?? await renderCanvas(next);
      if (renderGenRef.current === gen) setEditingCanvas(p => p ? { ...p, dataUrl } : p);
    }, 150);
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
          className="absolute top-4 left-4 z-30 p-2.5 bg-white/90 backdrop-blur-md border border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-white rounded-full shadow-lg transition-all">
          <X className="w-5 h-5" />
        </button>

        {/* Floating undo/redo + zoom — Gen-Z pill style */}
        <div className="absolute bottom-6 left-6 z-20 flex items-center gap-2">
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
        />
      </div>

      {/* ═══ Right Sidebar — Gen-Z colorful minimalist ═══ */}
      <div className="w-80 border-l border-slate-200/60 bg-gradient-to-b from-white via-slate-50/50 to-white flex flex-col overflow-hidden">
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
          {selectedLayer.type === 'frame' && (() => {
            const fIdx = selectedLayer.index;
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
            const overlay = editingCanvas.textOverlays[oIdx];
            if (!overlay) return null;
            const updateOverlay = (patch: Partial<TextOverlay>) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas);
              const newOverlays = editingCanvas.textOverlays.map((t, i) => i === oIdx ? { ...t, ...patch } : t);
              debouncedRender({ ...editingCanvas, textOverlays: newOverlays });
            };
            return (
              <div className="space-y-4">
                {/* Text input */}
                <div className="space-y-2">
                  <p className="text-[10px] font-extrabold text-pink-500 uppercase tracking-wider">Text Content</p>
                  <textarea value={overlay.text} rows={3}
                    onChange={e => updateOverlay({ text: e.target.value })}
                    className="w-full px-3 py-2 text-xs border border-pink-200/50 rounded-2xl resize-none focus:outline-none focus:ring-2 focus:ring-pink-500/20 focus:border-pink-400 bg-pink-50/30"
                    placeholder="Enter text..." />
                </div>

                {/* Size, Color, Font */}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="text-[9px] font-extrabold text-violet-400 uppercase">Size</label>
                    <input type="number" min="8" max="500" value={overlay.fontSize}
                      onChange={e => updateOverlay({ fontSize: Math.max(8, parseInt(e.target.value) || 24) })}
                      className="w-full px-1.5 py-1 text-xs font-mono text-center border border-violet-200/50 rounded-xl bg-violet-50/30" />
                  </div>
                  <div className="flex-1">
                    <ColorPicker label="Color" value={overlay.color} showHex={false}
                      onChange={color => updateOverlay({ color })} />
                  </div>
                  <div className="flex-[1.5]">
                    <label className="text-[9px] font-extrabold text-violet-400 uppercase">Font</label>
                    <select value={overlay.fontFamily}
                      onChange={e => { loadGoogleFont(e.target.value); updateOverlay({ fontFamily: e.target.value }); }}
                      className="w-full px-1 py-1 text-[10px] border border-violet-200/50 rounded-xl bg-violet-50/30">
                      {selectedFonts.map(f => (
                        <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Text Alignment — Fabric-native (directly sets textAlign) */}
                <div className="space-y-2">
                  <p className="text-[10px] font-extrabold text-cyan-500 uppercase tracking-wider">Alignment</p>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center bg-cyan-50 rounded-xl p-0.5 border border-cyan-200/50">
                      {([
                        { key: 'left' as const, icon: AlignLeft, tip: 'Left' },
                        { key: 'center' as const, icon: AlignCenter, tip: 'Center' },
                        { key: 'right' as const, icon: AlignRight, tip: 'Right' },
                      ]).map(({ key, icon: Icon, tip }) => (
                        <button key={key} title={tip}
                          onClick={() => updateOverlay({ textAlign: key })}
                          className={clsx('p-1.5 rounded-lg transition-all',
                            overlay.textAlign === key
                              ? 'bg-white text-cyan-600 shadow-sm'
                              : 'text-cyan-400 hover:text-cyan-600 hover:bg-white/50')}>
                          <Icon className="w-3.5 h-3.5" />
                        </button>
                      ))}
                    </div>
                    <span className="text-[9px] text-slate-400 ml-auto">Double-click to edit on canvas</span>
                  </div>
                </div>

                {/* Delete text */}
                <button onClick={() => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  debouncedRender({ ...editingCanvas, textOverlays: editingCanvas.textOverlays.filter((_, i) => i !== oIdx) });
                  setSelectedLayer({ type: 'frame', index: 0 });
                }} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all w-full">
                  <Trash2 className="w-3 h-3" /> Delete Text
                </button>
              </div>
            );
          })()}

          {/* ── Shape properties ──────────────────────────────────────── */}
          {selectedLayer.type === 'shape' && (() => {
            const sIdx = selectedLayer.index;
            const shape = editingCanvas.shapeOverlays[sIdx];
            if (!shape) return null;
            const updateShape = (patch: Partial<ShapeOverlay>) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas);
              const newShapes = editingCanvas.shapeOverlays.map((s, i) => i === sIdx ? { ...s, ...patch } : s);
              debouncedRender({ ...editingCanvas, shapeOverlays: newShapes });
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
                  debouncedRender({ ...editingCanvas, shapeOverlays: editingCanvas.shapeOverlays.filter((_, i) => i !== sIdx) });
                  setSelectedLayer({ type: 'frame', index: 0 });
                }} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all w-full">
                  <Trash2 className="w-3 h-3" /> Delete Shape
                </button>
              </div>
            );
          })()}

          {/* ── Image overlay properties ───────────────────────────── */}
          {selectedLayer.type === 'image' && (() => {
            const iIdx = selectedLayer.index;
            const imgOverlay = (editingCanvas.imageOverlays || [])[iIdx];
            if (!imgOverlay) return null;
            const updateImage = (patch: Partial<ImageOverlay>) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas);
              const newImages = (editingCanvas.imageOverlays || []).map((img, i) => i === iIdx ? { ...img, ...patch } : img);
              debouncedRender({ ...editingCanvas, imageOverlays: newImages });
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
                  debouncedRender({ ...editingCanvas, imageOverlays: (editingCanvas.imageOverlays || []).filter((_, i) => i !== iIdx) });
                  setSelectedLayer({ type: 'frame', index: 0 });
                }} className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all w-full">
                  <Trash2 className="w-3 h-3" /> Delete Icon
                </button>
              </div>
            );
          })()}

          {/* ── Canvas-level controls (always visible) ───────────────── */}
          <div className="pt-4 border-t border-slate-200/60 space-y-3">
            {/* Background Color */}
            <div className="flex items-center justify-between p-2.5 bg-gradient-to-r from-amber-50/60 to-orange-50/60 rounded-2xl border border-amber-200/40">
              <p className="text-[10px] font-extrabold text-amber-600 uppercase tracking-wider">Background</p>
              <ColorPicker value={editingCanvas?.bgColor || '#ffffff'}
                onChange={color => {
                  if (!editingCanvas) return;
                  pushUndo(editingCanvas, true);
                  debouncedRender({ ...editingCanvas, bgColor: color });
                }} />
            </div>

            {/* Add Text */}
            <button onClick={() => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas, true);
              const newOverlay: TextOverlay = {
                id: Date.now(),
                text: 'Text',
                x: 50, y: 50,
                fontSize: Math.round((layout?.canvas?.height || 1800) * 0.04),
                color: '#000000',
                fontFamily: selectedFonts[0] || 'sans-serif',
                textAlign: 'center',
              };
              const updated = { ...editingCanvas, textOverlays: [...editingCanvas.textOverlays, newOverlay] };
              debouncedRender(updated);
              setSelectedLayer({ type: 'text', index: updated.textOverlays.length - 1 });
            }} className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gradient-to-r from-pink-50 to-violet-50 text-pink-600 rounded-2xl text-xs font-extrabold hover:from-pink-100 hover:to-violet-100 transition-all border border-pink-200/50">
              <Type className="w-3.5 h-3.5" /> Add Text
            </button>

            {/* Shapes Picker */}
            <ShapesPicker onAddShape={(shape) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas, true);
              const updated = { ...editingCanvas, shapeOverlays: [...editingCanvas.shapeOverlays, shape] };
              debouncedRender(updated);
              setSelectedLayer({ type: 'shape', index: updated.shapeOverlays.length - 1 });
            }} />

            {/* Icon Browser (local storage + Iconify fallback) */}
            <IconBrowser onAddImage={(imgOverlay) => {
              if (!editingCanvas) return;
              pushUndo(editingCanvas, true);
              const updated = { ...editingCanvas, imageOverlays: [...(editingCanvas.imageOverlays || []), imgOverlay] };
              debouncedRender(updated);
              setSelectedLayer({ type: 'image', index: updated.imageOverlays.length - 1 });
            }} />

            {/* Add More Images */}
            <label className="flex items-center gap-2 px-3 py-2.5 bg-gradient-to-r from-sky-50 to-cyan-50 border border-sky-200/50 rounded-2xl text-xs font-extrabold text-sky-600 hover:from-sky-100 hover:to-cyan-100 transition-all cursor-pointer">
              <Upload className="w-3.5 h-3.5" /> Add More Images
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
                    const item: CanvasItem = { id: startId + i, frames: canvasFrames, textOverlays: [], shapeOverlays: [], imageOverlays: [], bgColor: '#ffffff', dataUrl: null };
                    item.dataUrl = await renderCanvas(item);
                    newCanvases.push(item);
                  }
                  setCanvases(prev => [...prev, ...newCanvases]);
                  skipNextGenerateRef.current = true;
                  setFiles(prev => [...prev, ...addedFiles]);
                }} />
            </label>
          </div>
        </div>

        {/* Layers Panel — collapsible, bottom */}
        <LayersPanel
          editingCanvas={editingCanvas}
          selected={selectedLayer}
          onSelect={setSelectedLayer}
          onDeleteText={(oIdx) => {
            if (!editingCanvas) return;
            pushUndo(editingCanvas, true);
            const updated = { ...editingCanvas, textOverlays: editingCanvas.textOverlays.filter((_, i) => i !== oIdx) };
            debouncedRender(updated);
            if (selectedLayer.type === 'text' && selectedLayer.index === oIdx) {
              setSelectedLayer({ type: 'frame', index: 0 });
            } else if (selectedLayer.type === 'text' && selectedLayer.index > oIdx) {
              setSelectedLayer({ type: 'text', index: selectedLayer.index - 1 });
            }
          }}
          onDeleteShape={(sIdx) => {
            if (!editingCanvas) return;
            pushUndo(editingCanvas, true);
            const updated = { ...editingCanvas, shapeOverlays: editingCanvas.shapeOverlays.filter((_, i) => i !== sIdx) };
            debouncedRender(updated);
            if (selectedLayer.type === 'shape' && selectedLayer.index === sIdx) {
              setSelectedLayer({ type: 'frame', index: 0 });
            } else if (selectedLayer.type === 'shape' && selectedLayer.index > sIdx) {
              setSelectedLayer({ type: 'shape', index: selectedLayer.index - 1 });
            }
          }}
          onDeleteImage={(iIdx) => {
            if (!editingCanvas) return;
            pushUndo(editingCanvas, true);
            const updated = { ...editingCanvas, imageOverlays: (editingCanvas.imageOverlays || []).filter((_, i) => i !== iIdx) };
            debouncedRender(updated);
            if (selectedLayer.type === 'image' && selectedLayer.index === iIdx) {
              setSelectedLayer({ type: 'frame', index: 0 });
            } else if (selectedLayer.type === 'image' && selectedLayer.index > iIdx) {
              setSelectedLayer({ type: 'image', index: selectedLayer.index - 1 });
            }
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
