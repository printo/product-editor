'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, Minus, Plus, AlignLeft, AlignCenter, AlignRight, Trash2, Type, ImagePlus, CheckCircle2, Image, Sparkles, Hexagon, RotateCw } from 'lucide-react';
import { clsx } from 'clsx';
import { ColorPicker } from '@/components/ColorPicker';
import { LayersPanel, type LayerSelection } from './LayersPanel';
import { ShapesPicker } from './ShapesPicker';
import { IconBrowser } from './IconBrowser';
import type { CanvasItem, FitMode, Overlay, TextOverlay, ShapeOverlay, ImageOverlay } from './types';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CanvasEditorSidebarProps {
  activeCanvasIdx: number;
  canvasesCount: number;
  onOpenCanvas: (idx: number) => void;
  editingCanvas: CanvasItem | null;
  layout: any;
  selectedLayer: LayerSelection;
  setSelectedLayer: React.Dispatch<React.SetStateAction<LayerSelection>>;
  handleAlign: (fIdx: number, alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  handleUpdateTransform: (fIdx: number, updates: Partial<{ scale: number; x: number; y: number; rotation: number }>) => void;
  handleSaveChanges: () => void;
  getFileUrl: (file: File | string | null) => string;
  debouncedRender: (updated: CanvasItem) => void;
  pushUndo: (canvas: CanvasItem, isMajor?: boolean) => void;
  loadGoogleFont: (name: string) => void;
  selectedFonts: string[];
}

// ─── Tab config ───────────────────────────────────────────────────────────────

type TabKey = 'background' | 'text' | 'shape' | 'icon' | 'image';

const ADD_TABS: { key: TabKey; label: string; icon: React.ElementType; activeClass: string }[] = [
  { key: 'background', label: 'BG',      icon: Sparkles, activeClass: 'text-amber-500' },
  { key: 'text',       label: 'Text',    icon: Type,     activeClass: 'text-violet-500' },
  { key: 'shape',      label: 'Shapes',  icon: Hexagon,  activeClass: 'text-indigo-500' },
  { key: 'icon',       label: 'Icons',   icon: Sparkles, activeClass: 'text-emerald-500' },
  { key: 'image',      label: 'Uploads', icon: Image,    activeClass: 'text-fuchsia-500' },
];

// ─── Shared sub-components ────────────────────────────────────────────────────

/** Rotation slider + 90deg increment + number input — always uses orange palette */
function RotationControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.2em]">Rotation</label>
        <div className="flex items-center gap-1 bg-orange-50 dark:bg-orange-500/10 px-2 py-0.5 rounded-lg border border-orange-100 dark:border-orange-500/20">
          <span className="text-[11px] font-mono font-black text-orange-600 dark:text-orange-400">{value}°</span>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 relative h-6 flex items-center group">
          <div className="absolute inset-0 bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 my-auto" />
          <input type="range" min="0" max="359" step="1" value={value}
            onChange={e => onChange(parseInt(e.target.value))}
            className="w-full relative z-10 appearance-none bg-transparent cursor-pointer accent-orange-500" />
        </div>
        
        <div className="flex items-center gap-2">
          <button onClick={() => onChange((value + 90) % 360)}
            className="w-10 h-10 flex items-center justify-center bg-white dark:bg-slate-900 text-orange-600 dark:text-orange-400 border border-slate-200 dark:border-slate-700 rounded-xl hover:border-orange-400 hover:shadow-lg hover:shadow-orange-500/10 active:scale-90 transition-all">
            <RotateCw className="w-5 h-5" />
          </button>
          
          <input type="number" min="0" max="359" value={value}
            onChange={e => onChange(((parseInt(e.target.value) || 0) % 360 + 360) % 360)}
            className="w-14 h-10 px-0 text-[11px] font-mono font-black text-center border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 outline-none" />
        </div>
      </div>
    </div>
  );
}

/** Proportional scale slider + number input — always uses emerald palette */
function ScaleControl({ label = "Scale", width, height, onScale }: { label?: string; width: number; height: number; onScale: (w: number, h: number) => void }) {
  const baseRef = useRef<{ w: number; h: number } | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.2em]">{label}</label>
        <div className="flex items-center gap-1 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 rounded-lg border border-emerald-100 dark:border-emerald-500/20">
          <span className="text-[11px] font-mono font-black text-emerald-600 dark:text-emerald-400">{Math.round(width)}%</span>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 relative h-6 flex items-center group">
          <div className="absolute inset-0 bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 my-auto" />
          <input type="range" min="5" max="250" step="1" value={Math.round(width)}
            onMouseDown={() => { baseRef.current = { w: width, h: height }; }}
            onChange={e => {
              const newW = parseInt(e.target.value);
              const base = baseRef.current ?? { w: width, h: height };
              const ratio = base.h / (base.w || 1);
              onScale(newW, Math.max(1, Math.min(250, Math.round(newW * ratio))));
            }}
            className="w-full relative z-10 appearance-none bg-transparent cursor-pointer accent-emerald-500" />
        </div>
        
        <input type="number" min="5" max="250" value={Math.round(width)}
          onMouseDown={() => { baseRef.current = { w: width, h: height }; }}
          onChange={e => {
            const newW = parseInt(e.target.value) || 0;
            const base = baseRef.current ?? { w: width, h: height };
            const ratio = base.h / (base.w || 1);
            onScale(Math.max(5, Math.min(250, newW)), Math.max(1, Math.min(250, Math.round(newW * ratio))));
          }}
          className="w-14 h-10 px-0 text-[11px] font-mono font-black text-center border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none" />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CanvasEditorSidebar({
  activeCanvasIdx,
  canvasesCount,
  onOpenCanvas,
  editingCanvas,
  layout,
  selectedLayer,
  setSelectedLayer,
  handleAlign,
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
    if (selectedLayer.type === 'shape') setActiveAddTab('shape');
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
    <div className="w-[340px] md:w-[380px] max-w-[380px] shrink-0 flex-none border-l border-slate-200/50 dark:border-white/5 bg-slate-50/80 dark:bg-slate-950/80 backdrop-blur-3xl flex flex-col overflow-hidden relative shadow-2xl z-20">
      {/* Background Blobs for Gen-Z glassmorphism */}
      <div className="absolute -top-32 -right-32 w-64 h-64 bg-violet-400/20 dark:bg-violet-600/20 blur-[100px] -z-10 rounded-full" />
      <div className="absolute -bottom-32 -left-32 w-64 h-64 bg-cyan-400/20 dark:bg-cyan-600/20 blur-[100px] -z-10 rounded-full" />
      {/* ── Header glassmorphism ─────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-white/50 dark:border-white/5 bg-white/50 dark:bg-black/20 sticky top-0 z-20 flex items-center gap-2">
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-500 p-[1.5px] shadow-sm">
          <div className="w-full h-full bg-white dark:bg-slate-900 rounded-[10px] flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-violet-500" />
          </div>
        </div>
        <h3 className="text-sm font-black bg-gradient-to-r from-violet-600 via-fuchsia-600 to-cyan-600 bg-clip-text text-transparent uppercase tracking-widest mr-auto">
          Editor
        </h3>
        
        <div className="flex items-center gap-0.5 bg-white/80 dark:bg-white/10 backdrop-blur-md p-1 rounded-xl border border-white/50 dark:border-white/5 shadow-sm">
          <button disabled={activeCanvasIdx === 0} onClick={() => onOpenCanvas(activeCanvasIdx - 1)}
            className="p-1 text-slate-500 hover:text-violet-600 dark:text-slate-400 dark:hover:text-violet-300 disabled:opacity-20 transition-all rounded-lg hover:bg-slate-100 dark:hover:bg-white/10 active:scale-95">
            <ChevronRight className="w-4 h-4 rotate-180" />
          </button>
          <span className="text-[10px] font-black text-slate-600 dark:text-slate-300 tabular-nums px-2 min-w-[40px] text-center">
            {activeCanvasIdx + 1}
            <span className="mx-0.5 text-slate-300 dark:text-slate-600 text-[8px]">OF</span>
            {canvasesCount}
          </span>
          <button disabled={activeCanvasIdx === canvasesCount - 1} onClick={() => onOpenCanvas(activeCanvasIdx + 1)}
            className="p-1 text-slate-500 hover:text-violet-600 dark:text-slate-400 dark:hover:text-violet-300 disabled:opacity-20 transition-all rounded-lg hover:bg-slate-100 dark:hover:bg-white/10 active:scale-95">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Scrollable body ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 custom-scrollbar">

        {/* ═══ Frame properties (shown when a frame/canvas is selected) ════ */}
        {(selectedLayer.type === 'frame' || selectedLayer.type === 'canvas') && (() => {
          const fIdx = selectedLayer.type === 'canvas' ? 0 : selectedLayer.index;
          const frame = editingCanvas.frames[fIdx];
          if (!frame) return null;
          return (
            <div className="space-y-6">
              {/* Fit */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.2em]">Fit Mode</p>
                  <div className="flex items-center gap-1 bg-white/80 dark:bg-white/5 backdrop-blur-md p-1 rounded-xl border border-white/50 dark:border-white/5 shadow-sm">
                    {(['contain', 'cover'] as FitMode[]).map(mode => (
                      <button key={mode}
                        onClick={() => {
                          pushUndo(editingCanvas, true);
                          const newFrames = editingCanvas.frames.map((f, i) =>
                            i === fIdx ? { ...f, fitMode: mode, scale: 1, offset: { x: 0, y: 0 } } : f);
                          debouncedRender({ ...editingCanvas, frames: newFrames });
                        }}
                        className={clsx('px-6 py-2 text-[10px] font-black rounded-xl transition-all text-center min-w-[70px]',
                          frame.fitMode === mode 
                            ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-400 shadow-md ring-1 ring-cyan-500/20' 
                            : 'text-slate-400 dark:text-slate-500 hover:text-cyan-600 dark:hover:text-cyan-400')}>
                        {mode === 'contain' ? 'Fit' : 'Cover'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Rotation */}
              <RotationControl
                value={frame.rotation || 0}
               
                onChange={v => handleUpdateTransform(fIdx, { rotation: v })}
              />

              {/* Zoom */}
              <ScaleControl label="Zoom" width={frame.scale * 100} height={100}
                onScale={(w) => handleUpdateTransform(fIdx, { scale: w / 100 })} />
            </div>
          );
        })()}

        {/* ═══ Add-object tabs ════════════════════════════════════════════ */}
        <div className="pt-1 space-y-3">
          {/* Tab bar */}
          <div className="flex items-center p-1 bg-white/60 dark:bg-white/5 backdrop-blur-xl rounded-xl border border-white/50 dark:border-white/10 w-full overflow-x-auto shadow-sm custom-scrollbar">
            {ADD_TABS.map(tab => {
              const isActive = activeAddTab === tab.key;
              const Icon = tab.icon;
              return (
                <button key={tab.key} onClick={() => setActiveAddTab(tab.key)}
                  className={clsx('flex-1 min-w-[50px] flex flex-col items-center justify-center gap-1 py-2 rounded-lg transition-all',
                    isActive 
                      ? 'bg-white/90 dark:bg-white/10 shadow-sm ring-1 ring-black/5 dark:ring-white/10' 
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-white/40 dark:hover:bg-white/5')}>
                  <Icon className={clsx('w-5 h-5 transition-all duration-300', isActive ? tab.activeClass : 'text-slate-400')} />
                  <span className={clsx('text-[9px] font-black uppercase tracking-widest truncate transition-all', isActive ? tab.activeClass : 'text-slate-400')}>
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div className="min-h-[60px] animate-in fade-in slide-in-from-bottom-2 duration-300 w-full">

            {/* ── Background tab ────────────────────────────────────────── */}
            {activeAddTab === 'background' && (
              <div className="space-y-2">
                {/* Background layer colour */}
                <div className="flex items-center justify-between p-3 bg-white/80 dark:bg-white/5 backdrop-blur-sm rounded-xl border border-white/50 dark:border-white/5 shadow-sm hover:shadow-md transition-all">
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-amber-600 dark:text-amber-400 uppercase tracking-widest">Workspace</p>
                    <p className="text-[9px] text-amber-500/70 dark:text-amber-500/50 font-medium tracking-tight">Bottom layer color</p>
                  </div>
                  <ColorPicker value={editingCanvas.bgColor || '#ffffff'}
                    onChange={color => {
                      pushUndo(editingCanvas, true);
                      debouncedRender({ ...editingCanvas, bgColor: color });
                    }} />
                </div>
                {/* Paper / Mat border colour */}
                <div className="flex items-center justify-between p-3 bg-white/80 dark:bg-white/5 backdrop-blur-sm rounded-xl border border-white/50 dark:border-white/5 shadow-sm hover:shadow-md transition-all">
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-slate-600 dark:text-slate-400 uppercase tracking-widest">Matte / Mask</p>
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 font-medium tracking-tight">Edge protection border</p>
                  </div>
                  <ColorPicker value={editingCanvas.paperColor || '#ffffff'}
                    onChange={color => {
                      pushUndo(editingCanvas, true);
                      debouncedRender({ ...editingCanvas, paperColor: color });
                    }} />
                </div>
              </div>
            )}

            {/* ── Text tab ──────────────────────────────────────────────── */}
            {activeAddTab === 'text' && (() => {
              // If a text overlay is selected, show its properties
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
                  <div className="space-y-6">
                    {/* Header row */}
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                      <p className="text-[10px] font-black text-violet-500 dark:text-violet-400 uppercase tracking-[0.2em]">Text Context</p>
                      <div className="flex items-center gap-1">
                        <button onClick={handleSaveChanges} title="Save"
                          className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Font + size + colour + align */}
                    <div className="flex items-center gap-1.5 p-1 bg-white/60 dark:bg-white/5 rounded-xl border border-white/50 dark:border-white/10 shadow-sm">
                      <div className="flex-1 min-w-0">
                        <select value={overlay.fontFamily}
                          onChange={e => { loadGoogleFont(e.target.value); updateOverlay({ fontFamily: e.target.value }); }}
                          className="w-full h-7 bg-white dark:bg-slate-900 border border-slate-200/50 dark:border-slate-700/50 rounded-lg text-[9px] font-bold text-slate-700 dark:text-slate-300 px-1.5 focus:ring-1 focus:ring-violet-400 outline-none appearance-none cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                          {selectedFonts.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center bg-white dark:bg-slate-900 border border-slate-200/50 dark:border-slate-700/50 rounded-lg h-7 px-1 gap-1">
                        <button onClick={() => updateOverlay({ fontSize: Math.max(8, (overlay.fontSize || 24) - 2) })}
                          className="p-1 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"><Minus className="w-2.5 h-2.5" /></button>
                        <input type="number" value={overlay.fontSize}
                          onChange={e => updateOverlay({ fontSize: Math.max(8, parseInt(e.target.value) || 24) })}
                          className="w-6 text-center text-[9px] font-black text-slate-700 dark:text-slate-300 bg-transparent border-none outline-none p-0" />
                        <button onClick={() => updateOverlay({ fontSize: (overlay.fontSize || 24) + 2 })}
                          className="p-1 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"><Plus className="w-2.5 h-2.5" /></button>
                      </div>
                      <ColorPicker value={overlay.color || '#000000'} showHex={false} onChange={color => updateOverlay({ color })} />
                      <div className="flex items-center bg-white dark:bg-slate-900 border border-slate-200/50 dark:border-slate-700/50 rounded-lg h-7 p-0.5 shadow-sm">
                        {[{ key: 'left' as const, icon: AlignLeft }, { key: 'center' as const, icon: AlignCenter }, { key: 'right' as const, icon: AlignRight }].map(({ key, icon: Icon }) => (
                          <button key={key} onClick={() => updateOverlay({ textAlign: key })}
                            className={clsx('p-1 rounded-md transition-all',
                            overlay.textAlign === key 
                              ? 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-400 shadow-inner' 
                              : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-300')}>
                            <Icon className="w-3 h-3" />
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Text content */}
                    <textarea value={overlay.text} onChange={e => updateOverlay({ text: e.target.value })}
                      className="w-full h-20 text-xs bg-slate-50/80 border border-slate-200/60 rounded-xl p-3 focus:ring-2 focus:ring-violet-400 outline-none transition-all placeholder-slate-300 font-medium leading-relaxed"
                      placeholder="Type your text here…" />

                    {/* Common: Rotation */}
                    <div className="pt-4 border-t border-slate-100">
                      <RotationControl value={overlay.rotation || 0}
                        onChange={v => updateOverlay({ rotation: v })} />
                    </div>
                  </div>
                );
              }
              // No text selected — show Add Text button
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
                }} className="w-full flex items-center justify-center gap-2 px-3 py-3 bg-white/80 dark:bg-white/5 backdrop-blur-sm text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-500/20 rounded-xl text-[10px] font-black hover:bg-violet-50 dark:hover:bg-violet-500/10 hover:shadow-sm active:scale-[0.98] transition-all">
                  <Type className="w-3.5 h-3.5" /> ADD NEW TEXT
                </button>
              );
            })()}

            {/* ── Shape tab ─────────────────────────────────────────────── */}
            {activeAddTab === 'shape' && (() => {
              if (selectedLayer.type === 'shape') {
                const oIdx = selectedLayer.index;
                const shape = editingCanvas.overlays[oIdx];
                if (!shape || shape.type !== 'shape') return null;
                const updateShape = (patch: Partial<ShapeOverlay>) => {
                  pushUndo(editingCanvas);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as any });
                };
                return (
                  <div className="space-y-6">
                    {/* Header */}
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                      <p className="text-[10px] font-black text-indigo-500 dark:text-indigo-400 uppercase tracking-[0.2em]">
                        {shape.shapeType.charAt(0).toUpperCase() + shape.shapeType.slice(1).replace(/-/g, ' ')}
                      </p>
                      <div className="flex items-center gap-1">
                        <button onClick={handleSaveChanges} title="Save"
                          className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Fill + Stroke */}
                    <div className="flex items-center gap-3">
                      <ColorPicker label="Fill"   value={shape.fill}   showHex={false} onChange={fill   => updateShape({ fill })} />
                      <ColorPicker label="Stroke" value={shape.stroke} showHex={false} onChange={stroke => updateShape({ stroke })} />
                    </div>

                    {/* Stroke Width */}
                    <div className="space-y-1">
                      <label className="text-[9px] font-extrabold text-indigo-400 uppercase">Stroke Width</label>
                      <div className="flex items-center gap-2">
                        <input type="range" min="0" max="20" step="1" value={shape.strokeWidth}
                          onChange={e => updateShape({ strokeWidth: parseInt(e.target.value) })}
                          className="flex-1 accent-indigo-500" />
                        <span className="text-[10px] font-mono text-indigo-400 w-6 text-center">{shape.strokeWidth}</span>
                      </div>
                    </div>

                    {/* Opacity */}
                    <div className="space-y-1">
                      <label className="text-[9px] font-extrabold text-indigo-400 uppercase">Opacity</label>
                      <div className="flex items-center gap-2">
                        <input type="range" min="0" max="100" step="5" value={Math.round(shape.opacity * 100)}
                          onChange={e => updateShape({ opacity: parseInt(e.target.value) / 100 })}
                          className="flex-1 accent-indigo-500" />
                        <span className="text-[10px] font-mono text-indigo-400 w-8 text-center">{Math.round(shape.opacity * 100)}%</span>
                      </div>
                    </div>

                    {/* ── Common controls ── */}
                    <div className="space-y-4 pt-4 border-t border-slate-100">
                      <RotationControl value={shape.rotation || 0}
                        onChange={v => updateShape({ rotation: v })} />
                      <ScaleControl width={shape.width} height={shape.height}
                        onScale={(w, h) => updateShape({ width: w, height: h })} />
                    </div>
                  </div>
                );
              }
              // No shape selected — show picker
              return (
                <div className="w-full overflow-hidden">
                  <ShapesPicker onAddShape={shape => {
                    pushUndo(editingCanvas, true);
                    const newOverlay: Overlay = { type: 'shape', ...shape };
                    const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                    debouncedRender(updated);
                    setSelectedLayer({ type: 'shape', index: updated.overlays.length - 1 });
                  }} />
                </div>
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
                  <div className="space-y-6">
                    {/* Header */}
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                      <div className="flex items-center gap-3 min-w-0">
                        <img src={imgOverlay.src} alt={imgOverlay.label} className="w-8 h-8 object-contain shrink-0 bg-slate-50 dark:bg-slate-800 rounded-lg p-1" />
                        <p className="text-[10px] font-black text-emerald-500 dark:text-emerald-400 uppercase tracking-[0.2em] truncate">{imgOverlay.label}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={handleSaveChanges} title="Save"
                          className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
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

                    {/* ── Common controls ── */}
                    <div className="space-y-4 pt-4 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                    </div>
                  </div>
                );
              }
              // No image overlay selected — show icon browser
              return (
                <div className="w-full overflow-hidden">
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
                  <div className="space-y-6">
                    {/* Header */}
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                      <p className="text-[10px] font-black text-fuchsia-500 dark:text-fuchsia-400 uppercase tracking-[0.2em] truncate max-w-[70%]">{imgOverlay.label}</p>
                      <div className="flex items-center gap-1">
                        <button onClick={handleSaveChanges} title="Save"
                          className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-extrabold text-fuchsia-400 uppercase">Opacity</label>
                      <div className="flex items-center gap-2">
                        <input type="range" min="0" max="100" step="5" value={Math.round(imgOverlay.opacity * 100)}
                          onChange={e => updateImage({ opacity: parseInt(e.target.value) / 100 })}
                          className="flex-1 accent-fuchsia-500" />
                        <span className="text-[10px] font-mono text-fuchsia-400 w-8 text-center">{Math.round(imgOverlay.opacity * 100)}%</span>
                      </div>
                    </div>
                    <div className="space-y-4 pt-4 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                    </div>
                  </div>
                );
              }
              // Upload UI
              return (
                <div className="space-y-4">
                  <label className="group relative w-full flex flex-col items-center justify-center gap-2 p-4 bg-white/60 dark:bg-white/5 backdrop-blur-md border border-dashed border-violet-300 dark:border-white/10 rounded-2xl text-violet-600 dark:text-violet-400 hover:bg-white/80 dark:hover:bg-white/10 transition-all cursor-pointer overflow-hidden shadow-sm">
                    <div className="p-2.5 bg-violet-100 dark:bg-violet-500/20 rounded-xl shadow-sm group-hover:scale-110 transition-transform">
                      <ImagePlus className="w-5 h-5" />
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-black uppercase tracking-tight">Add to Current Canvas</p>
                      <p className="text-[9px] text-violet-400 font-bold uppercase tracking-widest opacity-60 mt-0.5">Add as floating overlay</p>
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

      {/* ── Layers Panel ────────────────────────────────────────────────────── */}
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
      />

      {/* ── Save button ──────────────────────────────────────────────────────── */}
      <div className="px-3 py-3 bg-white/50 dark:bg-black/20 backdrop-blur-xl border-t border-white/50 dark:border-white/5 z-10 relative">
        <button onClick={handleSaveChanges}
          className="w-full py-2.5 bg-violet-600 dark:bg-violet-500 text-white rounded-xl text-[11px] font-black hover:bg-violet-700 dark:hover:bg-violet-600 transition-all flex items-center justify-center gap-2 active:scale-[0.98] shadow-md shadow-violet-500/20">
          <CheckCircle2 className="w-4 h-4 text-white/80" /> SAVE CHANGES
        </button>
      </div>
    </div>
  );
}
