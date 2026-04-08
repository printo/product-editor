'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, Minus, Plus, AlignLeft, AlignCenter, AlignRight, Trash2, Type, ImagePlus, CheckCircle2, Image, Sparkles, RotateCw, AlignCenterHorizontal, AlignCenterVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { ColorPicker } from '@/components/ColorPicker';
import { LayersPanel, type LayerSelection } from './LayersPanel';
import { IconBrowser } from './IconBrowser';
import { AlignmentToolbar } from './AlignmentToolbar';
import type { CanvasItem, FitMode, Overlay, TextOverlay, ImageOverlay } from './types';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CanvasEditorSidebarProps {
  editingCanvas: CanvasItem | null;
  layout: any;
  selectedLayer: LayerSelection;
  setSelectedLayer: React.Dispatch<React.SetStateAction<LayerSelection>>;
  handleAlign: (fIdx: number, alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  handleOverlayAlign: (oIdx: number, alignment: 'center' | 'middle') => void;
  handleUpdateTransform: (fIdx: number, updates: Partial<{ scale: number; x: number; y: number; rotation: number }>) => void;
  handleSaveChanges: () => void;
  getFileUrl: (file: File | string | null) => string;
  debouncedRender: (updated: CanvasItem) => void;
  pushUndo: (canvas: CanvasItem, isMajor?: boolean) => void;
  loadGoogleFont: (name: string) => void;
  selectedFonts: string[];
}

// ─── Tab config ───────────────────────────────────────────────────────────────

type TabKey = 'background' | 'text' | 'icon' | 'image';

const ADD_TABS: { key: TabKey; label: string; icon: React.ElementType; activeClass: string; gradient: string }[] = [
  { key: 'background', label: 'BG',      icon: Sparkles, activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
  { key: 'text',       label: 'Text',    icon: Type,     activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
  { key: 'icon',       label: 'Icons',   icon: Sparkles, activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
  { key: 'image',      label: 'Uploads', icon: Image,    activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
];

// ─── Shared sub-components ────────────────────────────────────────────────────

/** Rotation slider + 90deg increment + number input — Premium version */
function RotationControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-4 py-2 bg-transparent">
      <label className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">Rotate</label>
      
      <div className="flex-1 relative h-6 flex items-center group">
        <div className="absolute inset-0 bg-slate-100 rounded-full h-1 my-auto" />
        <input type="range" min="0" max="359" step="1" value={value}
          onChange={e => onChange(parseInt(e.target.value))}
          className="w-full relative z-10 appearance-none bg-transparent cursor-pointer accent-indigo-500" />
      </div>
      
      <div className="flex items-center gap-2">
        <button onClick={() => onChange((value + 90) % 360)}
          className="w-8 h-8 flex items-center justify-center bg-white text-slate-400 border border-slate-200 rounded-lg hover:text-indigo-600 hover:border-indigo-100 transition-all group/btn">
          <RotateCw className="w-3.5 h-3.5 group-hover/btn:rotate-90 transition-transform duration-500" />
        </button>
        
        <div className="relative">
          <input type="number" min="0" max="359" value={value}
            onChange={e => onChange(((parseInt(e.target.value) || 0) % 360 + 360) % 360)}
            className="w-11 h-8 px-0 text-[11px] font-mono font-medium text-center border border-slate-200 rounded-lg bg-white text-slate-700 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all" />
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-slate-300 pointer-events-none">°</span>
        </div>
      </div>
    </div>
  );
}

/** Proportional scale slider + number input — Premium version */
function ScaleControl({ label = "Zoom", width, height, onScale }: { label?: string; width: number; height: number; onScale: (w: number, h: number) => void }) {
  const baseRef = useRef<{ w: number; h: number } | null>(null);
  return (
    <div className="flex items-center gap-4 py-2 bg-transparent">
      <label className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">{label}</label>
      
      <div className="flex-1 relative h-6 flex items-center group">
        <div className="absolute inset-0 bg-slate-100 rounded-full h-1 my-auto" />
        <input type="range" min="5" max="250" step="1" value={Math.round(width)}
          onMouseDown={() => { baseRef.current = { w: width, h: height }; }}
          onChange={e => {
            const newW = parseInt(e.target.value);
            const base = baseRef.current ?? { w: width, h: height };
            const ratio = base.h / (base.w || 1);
            onScale(newW, Math.max(1, Math.min(250, Math.round(newW * ratio))));
          }}
          className="w-full relative z-10 appearance-none bg-transparent cursor-pointer accent-indigo-500" />
      </div>
      
      <div className="relative">
        <input type="number" min="5" max="250" value={Math.round(width)}
          onMouseDown={() => { baseRef.current = { w: width, h: height }; }}
          onChange={e => {
            const newW = parseInt(e.target.value) || 0;
            const base = baseRef.current ?? { w: width, h: height };
            const ratio = base.h / (base.w || 1);
            onScale(Math.max(5, Math.min(250, newW)), Math.max(1, Math.min(250, Math.round(newW * ratio))));
          }}
          className="w-11 h-8 px-0 text-[11px] font-mono font-medium text-center border border-slate-200 rounded-lg bg-white text-slate-700 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all" />
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-slate-300 pointer-events-none">%</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CanvasEditorSidebar({
  editingCanvas,
  layout,
  selectedLayer,
  setSelectedLayer,
  handleAlign,
  handleOverlayAlign,
  handleUpdateTransform,
  handleSaveChanges,
  getFileUrl,
  debouncedRender,
  pushUndo,
  loadGoogleFont,
  selectedFonts,
}: CanvasEditorSidebarProps) {

  const [activeAddTab, setActiveAddTab] = useState<TabKey>('text');

  // ── Auto-switch tab when overlay is selected on canvas ───────────────────
  useEffect(() => {
    if (selectedLayer.type === 'text')  setActiveAddTab('text');
    if (selectedLayer.type === 'image') {
      const ov = editingCanvas?.overlays[selectedLayer.index];
      const src = (ov as any)?.source;
      setActiveAddTab(src === 'local' ? 'image' : 'icon');
    }
  }, [selectedLayer.type, selectedLayer.index, editingCanvas?.overlays]);

  if (!editingCanvas) return null;

  // ── Shared delete helper ─────────────────────────────────────────────────
  const deleteOverlay = (idx: number) => {
    pushUndo(editingCanvas, true);
    debouncedRender({ ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== idx) });
    setSelectedLayer({ type: 'frame', index: 0 });
  };

  return (
    <div className="w-[340px] md:w-[380px] max-w-[380px] shrink-0 flex-none border-l border-slate-200/50 bg-white/95 backdrop-blur-3xl flex flex-col overflow-hidden relative shadow-xl z-20">
      {/* Subtle Background Blobs for Premium feel */}
      <div className="absolute -top-32 -right-32 w-80 h-80 bg-indigo-50/50 blur-[100px] -z-10 rounded-full" />
      <div className="absolute top-1/2 -left-32 w-64 h-64 bg-fuchsia-50/30 blur-[80px] -z-10 rounded-full" />
      
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-slate-100 bg-white/80 sticky top-0 z-20 flex items-center justify-between backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200">
            <Sparkles className="w-4.5 h-4.5 text-white" />
          </div>
          <div className="flex flex-col">
            <h3 className="text-sm font-medium text-slate-900 uppercase">
              Editor
            </h3>
            <span className="text-[10px] text-slate-400 uppercase">Canvas Workspace</span>
          </div>
        </div>
      </div>

      {/* ── Scrollable body ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 custom-scrollbar">

        {/* ═══ Frame properties ════ */}
        {(selectedLayer.type === 'frame' || selectedLayer.type === 'canvas') && (() => {
          const fIdx = selectedLayer.type === 'canvas' ? 0 : selectedLayer.index;
          const frame = editingCanvas.frames[fIdx];
          if (!frame) return null;
          return (
            <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-500">
              {/* Fit */}
              <div className="flex items-center gap-4 py-2 bg-transparent">
                <label className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">Fit Mode</label>
                <div className="flex-1 flex gap-1 p-1 bg-slate-50 rounded-lg border border-slate-100 shadow-inner">
                  {(['contain', 'cover'] as FitMode[]).map(mode => (
                    <button key={mode}
                      onClick={() => {
                        pushUndo(editingCanvas, true);
                        const newFrames = editingCanvas.frames.map((f, i) =>
                          i === fIdx ? { ...f, fitMode: mode, scale: 1, offset: { x: 0, y: 0 } } : f);
                        debouncedRender({ ...editingCanvas, frames: newFrames });
                      }}
                      className={clsx('flex-1 py-1.5 text-[10px] font-medium rounded-md transition-all uppercase',
                        frame.fitMode === mode 
                          ? 'bg-indigo-600 text-white shadow-sm' 
                          : 'text-slate-400 hover:text-slate-600')}>
                      {mode === 'contain' ? 'Fit' : 'Cover'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Rotation */}
              <RotationControl
                value={frame.rotation || 0}
                onChange={v => handleUpdateTransform(fIdx, { rotation: v })}
              />

              {/* Position / Alignment */}
              <div className="space-y-3 pt-4 border-t border-slate-50">
                <label className="text-[11px] font-medium text-slate-500 uppercase">Photo Alignment</label>
                <AlignmentToolbar 
                  onHAlign={v => handleAlign(fIdx, v as any)}
                  onVAlign={v => handleAlign(fIdx, v as any)}
                />
              </div>

              {/* Zoom */}
              <ScaleControl label="Zoom" width={frame.scale * 100} height={100}
                onScale={(w) => handleUpdateTransform(fIdx, { scale: w / 100 })} />
            </div>
          );
        })()}

        {/* ═══ Add-object tabs ════════════════════════════════════════════ */}
        <div className="space-y-4">
          {/* Tab bar */}
          <div className="flex items-center p-1 bg-slate-50 rounded-xl border border-slate-100">
            {ADD_TABS.map(tab => {
              const isActive = activeAddTab === tab.key;
              const Icon = tab.icon;
              return (
                <button key={tab.key} onClick={() => setActiveAddTab(tab.key)}
                  className={clsx('flex-1 flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg transition-all duration-300 relative overflow-hidden',
                    isActive 
                      ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-200' 
                      : 'text-slate-400 hover:text-slate-600 scale-95')}>
                  <Icon className={clsx('w-4 h-4 transition-all', isActive ? 'text-white' : 'text-slate-300')} />
                  <span className={clsx('text-[9px] font-medium uppercase transition-all', isActive ? 'text-white' : 'text-slate-400')}>
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div className="min-h-[80px] animate-in fade-in slide-in-from-bottom-2 duration-300 w-full">

            {/* ── Background tab ────────────────────────────────────────── */}
            {activeAddTab === 'background' && (
              <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                <div className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl shadow-sm hover:border-indigo-100 transition-all group">
                  <div className="space-y-0.5">
                    <p className="text-[11px] font-medium text-slate-800 uppercase">Background Colour</p>
                    <p className="text-[10px] text-slate-400 uppercase tracking-tight">Base canvas color</p>
                  </div>
                  <ColorPicker value={editingCanvas.bgColor || '#ffffff'}
                    onChange={color => {
                      pushUndo(editingCanvas, true);
                      debouncedRender({ ...editingCanvas, bgColor: color });
                    }} />
                </div>
              </div>
            )}

            {/* ── Text tab ──────────────────────────────────────────────── */}
            {activeAddTab === 'text' && (() => {
              if (selectedLayer.type === 'text') {
                const oIdx = selectedLayer.index;
                const overlay = editingCanvas.overlays[oIdx];
                if (!overlay || overlay.type !== 'text') return null;
                const updateOverlay = (patch: Partial<TextOverlay>) => {
                  pushUndo(editingCanvas, true);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
                };
                return (
                  <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                      <div className="flex flex-col">
                        <p className="text-[11px] font-medium text-slate-900 uppercase">Text Styling</p>
                        <span className="text-[10px] text-slate-400 uppercase">Edit content & style</span>
                      </div>
                      <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                        className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-xl transition-all active:scale-90">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-3">
                        <label className="text-[11px] font-medium text-slate-500 uppercase">Font Family</label>
                        <div className="relative group">
                          <select value={overlay.fontFamily}
                            onChange={e => { loadGoogleFont(e.target.value); updateOverlay({ fontFamily: e.target.value }); }}
                            className="w-full h-11 bg-white border border-slate-200 rounded-xl text-[11px] font-medium text-slate-700 px-4 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none appearance-none cursor-pointer hover:bg-slate-50 transition-all shadow-sm">
                            {selectedFonts.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                          </select>
                          <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                            <ChevronRight className="w-3.5 h-3.5 rotate-90" />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-3">
                          <label className="text-[11px] font-medium text-slate-500 uppercase">Size</label>
                          <div className="flex items-center bg-white border border-slate-200 rounded-xl h-11 px-2 shadow-sm">
                            <button onClick={() => updateOverlay({ fontSize: Math.max(8, (overlay.fontSize || 24) - 2) })}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 transition-colors rounded-lg"><Minus className="w-3.5 h-3.5" /></button>
                            <input type="number" value={overlay.fontSize}
                              onChange={e => updateOverlay({ fontSize: Math.max(8, parseInt(e.target.value) || 24) })}
                              className="flex-1 text-center text-[11px] font-mono font-medium text-slate-700 bg-transparent border-none outline-none p-0" />
                            <button onClick={() => updateOverlay({ fontSize: (overlay.fontSize || 24) + 2 })}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 transition-colors rounded-lg"><Plus className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <label className="text-[11px] font-medium text-slate-500 uppercase">Color</label>
                          <div className="bg-white border border-slate-200 rounded-xl h-11 flex items-center justify-center shadow-sm">
                            <ColorPicker value={overlay.color || '#000000'} showHex={false} onChange={color => updateOverlay({ color })} />
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <label className="text-[11px] font-medium text-slate-500 uppercase">Alignment</label>
                        <div className="flex items-center bg-slate-50 rounded-xl h-11 p-1 shadow-inner border border-slate-100">
                          {[{ key: 'left' as const, icon: AlignLeft }, { key: 'center' as const, icon: AlignCenter }, { key: 'right' as const, icon: AlignRight }].map(({ key, icon: Icon }) => (
                            <button key={key} onClick={() => updateOverlay({ textAlign: key })}
                              className={clsx('flex-1 flex items-center justify-center h-full rounded-lg transition-all',
                              overlay.textAlign === key 
                                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200' 
                                : 'text-slate-400 hover:text-slate-600')}>
                              <Icon className="w-4 h-4" />
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-3">
                        <label className="text-[11px] font-medium text-slate-500 uppercase">Content</label>
                        <textarea value={overlay.text} onChange={e => updateOverlay({ text: e.target.value })}
                          className="w-full h-28 text-[12px] font-normal bg-white border border-slate-200 rounded-xl p-4 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all placeholder-slate-300 text-slate-700 resize-none shadow-sm leading-relaxed"
                          placeholder="Type your message…" />
                      </div>

                      <div className="pt-4 border-t border-slate-100 space-y-4">
                        <RotationControl value={overlay.rotation || 0}
                          onChange={v => updateOverlay({ rotation: v })} />
                        
                        <div className="space-y-3">
                          <label className="text-[11px] font-medium text-slate-500 uppercase">Center on Canvas</label>
                          <div className="flex items-center gap-2">
                            <button onClick={() => handleOverlayAlign(oIdx, 'center')} className="flex-1 flex items-center justify-center gap-2 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-xl text-[10px] font-bold text-slate-600 uppercase transition-all">
                              <AlignCenterHorizontal className="w-3.5 h-3.5" /> Center H
                            </button>
                            <button onClick={() => handleOverlayAlign(oIdx, 'middle')} className="flex-1 flex items-center justify-center gap-2 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-xl text-[10px] font-bold text-slate-600 uppercase transition-all">
                              <AlignCenterVertical className="w-3.5 h-3.5" /> Center V
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <button onClick={() => {
                  pushUndo(editingCanvas, true);
                  const newOverlay: Overlay = {
                    type: 'text', id: Date.now(), text: 'New Text',
                    x: 50, y: 50,
                    fontSize: Math.round((layout?.canvas?.height || 1800) * 0.04),
                    color: '#000000', fontFamily: selectedFonts[0] || 'sans-serif',
                    textAlign: 'center', rotation: 0,
                  };
                  const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                  debouncedRender(updated);
                  setSelectedLayer({ type: 'text', index: updated.overlays.length - 1 });
                }} className="w-full h-11 flex items-center justify-center gap-3 bg-indigo-600 text-white rounded-xl text-[11px] font-medium uppercase hover:bg-indigo-700 hover:shadow-lg transition-all active:scale-[0.98]">
                  <Type className="w-4 h-4" /> Add New Text
                </button>
              );
            })()}

            {/* ── Icon tab ──────────────────────────────────────────────── */}
            {activeAddTab === 'icon' && (() => {
              if (selectedLayer.type === 'image') {
                const oIdx = selectedLayer.index;
                const imgOverlay = editingCanvas.overlays[oIdx];
                if (!imgOverlay || imgOverlay.type !== 'image') return null;
                const updateImage = (patch: Partial<ImageOverlay>) => {
                  pushUndo(editingCanvas);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
                };
                return (
                  <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-11 h-11 bg-slate-50 rounded-xl p-2 border border-slate-100 flex items-center justify-center shrink-0 shadow-sm">
                          <img src={imgOverlay.src} alt={imgOverlay.label} className="w-full h-full object-contain" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <p className="text-[11px] font-medium text-slate-900 uppercase truncate">{imgOverlay.label}</p>
                          <span className="text-[10px] text-slate-400 uppercase">Icon Overlay</span>
                        </div>
                      </div>
                      <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                        className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-xl transition-all active:scale-90">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-medium text-slate-500 uppercase">Opacity</label>
                        <span className="text-[11px] font-mono font-medium text-emerald-600">{Math.round(imgOverlay.opacity * 100)}%</span>
                      </div>
                      <input type="range" min="0" max="100" step="5" value={Math.round(imgOverlay.opacity * 100)}
                        onChange={e => updateImage({ opacity: parseInt(e.target.value) / 100 })}
                        className="w-full h-1 bg-slate-100 rounded-full appearance-none cursor-pointer accent-emerald-500" />
                    </div>

                    <div className="space-y-5 pt-5 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                    </div>
                  </div>
                );
              }
              return (
                <div className="w-full animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <IconBrowser onAddImage={imgOverlay => {
                    pushUndo(editingCanvas, true);
                    const newOverlay: Overlay = { type: 'image', ...imgOverlay };
                    const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                    debouncedRender(updated);
                    setSelectedLayer({ type: 'image', index: updated.overlays.length - 1 });
                  }} />
                </div>
              );
            })()}

            {/* ── Uploads tab ───────────────────────────────────────────── */}
            {activeAddTab === 'image' && (() => {
              if (selectedLayer.type === 'image') {
                const oIdx = selectedLayer.index;
                const imgOverlay = editingCanvas.overlays[oIdx];
                if (!imgOverlay || imgOverlay.type !== 'image') return null;
                const updateImage = (patch: Partial<ImageOverlay>) => {
                  pushUndo(editingCanvas);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
                };
                return (
                  <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                      <div className="flex flex-col min-w-0 max-w-[70%]">
                        <p className="text-[11px] font-medium text-slate-900 uppercase truncate">{imgOverlay.label}</p>
                        <span className="text-[10px] text-slate-400 uppercase">Image Overlay</span>
                      </div>
                      <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                        className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-xl transition-all active:scale-90">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-medium text-slate-500 uppercase">Opacity</label>
                        <span className="text-[11px] font-mono font-medium text-rose-600">{Math.round(imgOverlay.opacity * 100)}%</span>
                      </div>
                      <input type="range" min="0" max="100" step="5" value={Math.round(imgOverlay.opacity * 100)}
                        onChange={e => updateImage({ opacity: parseInt(e.target.value) / 100 })}
                        className="w-full h-1 bg-slate-100 rounded-full appearance-none cursor-pointer accent-rose-500" />
                    </div>
                    <div className="space-y-5 pt-5 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                    </div>
                  </div>
                );
              }
              return (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <label className="group relative w-full flex flex-col items-center justify-center gap-2 p-4 bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl text-rose-500 hover:bg-white hover:border-rose-200 transition-all cursor-pointer overflow-hidden shadow-sm">
                    <div className="p-3 bg-rose-50 rounded-xl shadow-inner group-hover:scale-110 transition-all duration-500">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                    <div className="text-center">
                      <p className="text-[11px] font-medium uppercase">Add Photo</p>
                      <p className="text-[10px] text-slate-400 uppercase tracking-tight opacity-80">Floating overlay</p>
                    </div>
                    <input type="file" multiple accept="image/*" className="hidden"
                      onChange={async e => {
                        if (!e.target.files?.length) return;
                        pushUndo(editingCanvas, true);
                        const files = Array.from(e.target.files);
                        e.target.value = '';
                        let updated = { ...editingCanvas };
                        for (const file of files) {
                          const newOverlay: Overlay = {
                            id: Math.random().toString(36).substr(2, 9),
                            type: 'image', src: getFileUrl(file), originalFile: file,
                            source: 'local', x: 50, y: 50, width: 30, height: 30,
                            rotation: 0, opacity: 1, label: file.name,
                          };
                          updated = { ...updated, overlays: [...updated.overlays, newOverlay] };
                        }
                        debouncedRender(updated);
                        setSelectedLayer({ type: 'image', index: updated.overlays.length - 1 });
                      }} />
                  </label>
                </div>
              );
            })()}

          </div>
        </div>
      </div>

      {/* ── Layers Panel ────────────────────────────────────────────────── */}
      <div className="mt-auto px-5 py-1.5 border-t border-amber-300 bg-amber-100/95 backdrop-blur-md">
        <LayersPanel 
          editingCanvas={editingCanvas}
          selected={selectedLayer}
          onSelect={setSelectedLayer}
          onDeleteOverlay={oIdx => {
            pushUndo(editingCanvas, true);
            const updated = { ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== oIdx) };
            debouncedRender(updated);
            if (selectedLayer.index === oIdx) setSelectedLayer({ type: 'frame', index: 0 });
            else if (selectedLayer.index > oIdx) setSelectedLayer({ ...selectedLayer, index: selectedLayer.index - 1 });
          }}
          onReorderOverlays={newOverlays => {
            pushUndo(editingCanvas, true);
            debouncedRender({ ...editingCanvas, overlays: newOverlays });
          }}
          onClearFrame={fIdx => {
            pushUndo(editingCanvas, true);
            const newFrames = editingCanvas.frames.map((f, i) =>
              i === fIdx ? { ...f, offset: { x: 0, y: 0 }, scale: 1, rotation: 0 } : f);
            debouncedRender({ ...editingCanvas, frames: newFrames });
          }}
          onMoveFrameToOverlay={(fIdx, targetOIdx) => {
            const frame = editingCanvas.frames[fIdx];
            if (!frame || !frame.originalFile) return;
            pushUndo(editingCanvas, true);
            
            const canvasW = layout?.canvas?.width || 1200;
            const canvasH = layout?.canvas?.height || 1800;
            const layoutFrame = layout?.frames?.[fIdx] || { x: 0, y: 0, width: canvasW, height: canvasH };
            
            // Normalize layout dimensions if they are percentages
            const isPercent = layoutFrame.width <= 1 && layoutFrame.height <= 1;
            const fw = isPercent ? layoutFrame.width * canvasW : layoutFrame.width;
            const fh = isPercent ? layoutFrame.height * canvasH : layoutFrame.height;
            const fx = isPercent ? layoutFrame.x * canvasW : layoutFrame.x;
            const fy = isPercent ? layoutFrame.y * canvasH : layoutFrame.y;

            // Convert frame to image overlay (Overlay expects percentages 0-100)
            const newOverlay: Overlay = {
              type: 'image',
              id: `ov-${Date.now()}`,
              src: getFileUrl(frame.originalFile),
              originalFile: frame.originalFile,
              source: 'local',
              x: (fx / canvasW) * 100,
              y: (fy / canvasH) * 100,
              width: (fw / canvasW) * 100,
              height: (fh / canvasH) * 100,
              rotation: frame.rotation,
              opacity: 1,
              label: frame.originalFile.name || 'Moved Image',
            };

            const newOverlays = [...editingCanvas.overlays];
            newOverlays.splice(targetOIdx, 0, newOverlay);
            
            // Important: We don't remove the frame because the layout requires N frames.
            // We just clear its content so it's not redundant.
            const newFrames = editingCanvas.frames.map((f, i) => 
              i === fIdx ? { ...f, originalFile: null, offset: { x: 0, y: 0 }, scale: 1, rotation: 0 } : f
            );

            debouncedRender({ ...editingCanvas, overlays: newOverlays, frames: newFrames });
            setSelectedLayer({ type: 'image', index: targetOIdx });
          }}
        />
      </div>

      {/* ── Save Button ─────────────────────────────────────────────────── */}
      <div className="px-4 py-3 bg-white border-t border-slate-100">
        <button onClick={handleSaveChanges}
          className="w-full h-12 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-xl font-medium uppercase text-[11px] hover:shadow-lg hover:shadow-indigo-100 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group">
          <CheckCircle2 className="w-4 h-4 transition-transform group-hover:scale-110" />
          Save Changes
        </button>
      </div>
    </div>
  );
}
