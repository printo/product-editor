'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight, Minus, Plus, AlignLeft, AlignCenter, AlignRight,
  Trash2, Type, ImagePlus, CheckCircle2,
  Image, Sparkles, Hexagon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { ColorPicker } from '@/components/ColorPicker';
import { AlignmentToolbar } from './AlignmentToolbar';
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

/** Rotation preset buttons + slider + number input — always uses orange palette */
function RotationControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[9px] font-extrabold text-orange-400 uppercase">Rotation</label>
      <div className="flex items-center gap-1 mb-1">
        {[0, 90, 180, 270].map(deg => (
          <button key={deg} onClick={() => onChange(deg)}
            className={clsx('flex-1 py-0.5 text-[9px] font-extrabold rounded-lg transition-all text-center',
              value === deg
                ? 'bg-gradient-to-r from-orange-500 to-pink-500 text-white shadow'
                : 'bg-orange-50 text-orange-400 hover:text-orange-600 border border-orange-200/40')}>
            {deg}°
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input type="range" min="0" max="359" step="1" value={value}
          onChange={e => onChange(parseInt(e.target.value))}
          className="flex-1 accent-orange-500" />
        <input type="number" min="0" max="359" value={value}
          onChange={e => onChange(((parseInt(e.target.value) || 0) % 360 + 360) % 360)}
          className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-orange-200/50 rounded-xl bg-orange-50/50" />
      </div>
    </div>
  );
}

/** Proportional scale slider — always uses emerald palette */
function ScaleControl({ width, height, onScale }: { width: number; height: number; onScale: (w: number, h: number) => void }) {
  const baseRef = useRef<{ w: number; h: number } | null>(null);
  return (
    <div className="space-y-1.5">
      <label className="text-[9px] font-extrabold text-emerald-400 uppercase">Scale</label>
      <div className="flex items-center gap-2">
        <input type="range" min="5" max="100" step="1" value={Math.round(width)}
          onMouseDown={() => { baseRef.current = { w: width, h: height }; }}
          onChange={e => {
            const newW = parseInt(e.target.value);
            const base = baseRef.current ?? { w: width, h: height };
            const ratio = base.h / (base.w || 1);
            onScale(newW, Math.max(1, Math.min(100, Math.round(newW * ratio))));
          }}
          className="flex-1 accent-emerald-500" />
        <span className="text-[10px] font-mono text-emerald-400 w-10 text-center">
          {Math.round(width)}%
        </span>
      </div>
    </div>
  );
}

/** Alignment toolbar wired for a canvas-percent-positioned overlay */
function OverlayAlignControl({
  width, height, type,
  onUpdate,
}: {
  width?: number; height?: number; type: 'shape' | 'image' | 'text';
  onUpdate: (patch: Record<string, number>) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[9px] font-extrabold text-cyan-400 uppercase">Align on Canvas</label>
      <AlignmentToolbar
        onHAlign={alignment => {
          if (type === 'text') {
            const x = alignment === 'left' ? 5 : alignment === 'center' ? 50 : 95;
            onUpdate({ x });
          } else {
            const w = width ?? 25;
            const x = alignment === 'left' ? w / 2 : alignment === 'center' ? 50 : 100 - w / 2;
            onUpdate({ x });
          }
        }}
        onVAlign={alignment => {
          if (type === 'text') {
            const y = alignment === 'top' ? 5 : alignment === 'middle' ? 50 : 95;
            onUpdate({ y });
          } else {
            const h = height ?? 25;
            const y = alignment === 'top' ? h / 2 : alignment === 'middle' ? 50 : 100 - h / 2;
            onUpdate({ y });
          }
        }}
      />
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
    <div className="w-[360px] md:w-[400px] max-w-[400px] shrink-0 flex-none border-l border-slate-200/60 bg-gradient-to-b from-white via-slate-50/50 to-white flex flex-col overflow-hidden relative">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-slate-200/60 bg-gradient-to-r from-violet-50/80 to-cyan-50/80 flex items-center gap-2">
        <h3 className="text-xs font-extrabold bg-gradient-to-r from-violet-600 to-cyan-600 bg-clip-text text-transparent mr-auto tracking-tight">Canvas Editor</h3>
        <button disabled={activeCanvasIdx === 0} onClick={() => onOpenCanvas(activeCanvasIdx - 1)}
          className="p-1.5 text-violet-400 hover:text-violet-600 disabled:opacity-20 transition-all rounded-lg hover:bg-violet-100/50">
          <ChevronRight className="w-3.5 h-3.5 rotate-180" />
        </button>
        <span className="text-[10px] font-extrabold text-violet-400 tabular-nums bg-violet-100/60 px-2 py-0.5 rounded-full">
          {activeCanvasIdx + 1}/{canvasesCount}
        </span>
        <button disabled={activeCanvasIdx === canvasesCount - 1} onClick={() => onOpenCanvas(activeCanvasIdx + 1)}
          className="p-1.5 text-violet-400 hover:text-violet-600 disabled:opacity-20 transition-all rounded-lg hover:bg-violet-100/50">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Scrollable body ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ═══ Frame properties (shown when a frame/canvas is selected) ════ */}
        {(selectedLayer.type === 'frame' || selectedLayer.type === 'canvas') && (() => {
          const fIdx = selectedLayer.type === 'canvas' ? 0 : selectedLayer.index;
          const frame = editingCanvas.frames[fIdx];
          if (!frame) return null;
          return (
            <div className="space-y-4">
              {/* Fit + Alignment */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-extrabold text-cyan-500 uppercase tracking-wider">Fit & Alignment</p>
                  <div className="flex items-center bg-cyan-50 rounded-xl p-0.5 border border-cyan-200/50">
                    {(['contain', 'cover'] as FitMode[]).map(mode => (
                      <button key={mode}
                        onClick={() => {
                          pushUndo(editingCanvas, true);
                          const newFrames = editingCanvas.frames.map((f, i) =>
                            i === fIdx ? { ...f, fitMode: mode, scale: 1, offset: { x: 0, y: 0 } } : f);
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
              <RotationControl
                value={frame.rotation || 0}
               
                onChange={v => handleUpdateTransform(fIdx, { rotation: v })}
              />

              {/* Zoom */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-extrabold text-emerald-500 uppercase tracking-wider">Zoom</p>
                <div className="flex items-center gap-2">
                  <input type="range" min="10" max="300" step="10" value={Math.round(frame.scale * 100)}
                    onChange={e => handleUpdateTransform(fIdx, { scale: parseInt(e.target.value) / 100 })}
                    className="flex-1 accent-emerald-500" />
                  <input type="number" min="10" max="300" value={Math.round(frame.scale * 100)}
                    onChange={e => handleUpdateTransform(fIdx, { scale: Math.max(10, Math.min(300, parseInt(e.target.value) || 100)) / 100 })}
                    className="w-14 px-1.5 py-1 text-xs font-mono text-center border border-emerald-200/50 rounded-xl bg-emerald-50/50" />
                </div>
              </div>
            </div>
          );
        })()}

        {/* ═══ Add-object tabs ════════════════════════════════════════════ */}
        <div className="pt-1 space-y-3">
          {/* Tab bar */}
          <div className="flex items-center p-1 bg-slate-100/80 backdrop-blur-sm rounded-2xl border border-slate-200/50 w-full overflow-x-auto">
            {ADD_TABS.map(tab => {
              const isActive = activeAddTab === tab.key;
              const Icon = tab.icon;
              return (
                <button key={tab.key} onClick={() => setActiveAddTab(tab.key)}
                  className={clsx('flex-1 min-w-[50px] flex flex-col items-center justify-center gap-1 py-1.5 rounded-xl transition-all',
                    isActive ? `bg-white shadow-sm ring-1 ${tab.activeClass}` : 'text-slate-400 hover:text-slate-600 hover:bg-white/40')}>
                  <Icon className="w-3.5 h-3.5" />
                  <span className="text-[9px] font-black uppercase tracking-tighter truncate max-w-[50px]">{tab.label}</span>
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
                <div className="flex items-center justify-between p-3 bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl border border-amber-200/40">
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-extrabold text-amber-600 uppercase tracking-wider">Background</p>
                    <p className="text-[9px] text-amber-500/70 font-medium tracking-tight">Bottom layer — shows inside frames</p>
                  </div>
                  <ColorPicker value={editingCanvas.bgColor || '#ffffff'}
                    onChange={color => {
                      pushUndo(editingCanvas, true);
                      debouncedRender({ ...editingCanvas, bgColor: color });
                    }} />
                </div>
                {/* Paper / Mat border colour */}
                <div className="flex items-center justify-between p-3 bg-gradient-to-r from-slate-50 to-zinc-50 rounded-2xl border border-slate-200/40">
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-extrabold text-slate-600 uppercase tracking-wider">Paper / Mat</p>
                    <p className="text-[9px] text-slate-400 font-medium tracking-tight">Mask border around frames</p>
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
                  <div className="space-y-4">
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-extrabold text-violet-500 uppercase tracking-wider">Text Properties</p>
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
                    <div className="flex items-center gap-1.5 p-1.5 bg-slate-100/50 rounded-2xl border border-slate-200/40">
                      <div className="flex-1 min-w-0">
                        <select value={overlay.fontFamily}
                          onChange={e => { loadGoogleFont(e.target.value); updateOverlay({ fontFamily: e.target.value }); }}
                          className="w-full h-8 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 px-1.5 focus:ring-1 focus:ring-violet-400 outline-none appearance-none cursor-pointer hover:bg-slate-50 transition-colors">
                          {selectedFonts.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center bg-white border border-slate-200 rounded-lg h-8 px-1 gap-1">
                        <button onClick={() => updateOverlay({ fontSize: Math.max(8, (overlay.fontSize || 24) - 2) })}
                          className="p-1 text-slate-400 hover:text-violet-600 transition-colors"><Minus className="w-3 h-3" /></button>
                        <input type="number" value={overlay.fontSize}
                          onChange={e => updateOverlay({ fontSize: Math.max(8, parseInt(e.target.value) || 24) })}
                          className="w-8 text-center text-[10px] font-black text-slate-700 bg-transparent border-none outline-none p-0" />
                        <button onClick={() => updateOverlay({ fontSize: (overlay.fontSize || 24) + 2 })}
                          className="p-1 text-slate-400 hover:text-violet-600 transition-colors"><Plus className="w-3 h-3" /></button>
                      </div>
                      <ColorPicker value={overlay.color || '#000000'} showHex={false} onChange={color => updateOverlay({ color })} />
                      <div className="flex items-center bg-white border border-slate-200 rounded-lg h-8 p-0.5 shadow-sm">
                        {[{ key: 'left' as const, icon: AlignLeft }, { key: 'center' as const, icon: AlignCenter }, { key: 'right' as const, icon: AlignRight }].map(({ key, icon: Icon }) => (
                          <button key={key} onClick={() => updateOverlay({ textAlign: key })}
                            className={clsx('p-1.5 rounded-md transition-all',
                              overlay.textAlign === key ? 'bg-violet-100 text-violet-600 shadow-inner' : 'text-slate-400 hover:text-slate-600')}>
                            <Icon className="w-3 h-3" />
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Text content */}
                    <textarea value={overlay.text} onChange={e => updateOverlay({ text: e.target.value })}
                      className="w-full h-20 text-xs bg-slate-50/80 border border-slate-200/60 rounded-xl p-3 focus:ring-2 focus:ring-violet-400 outline-none transition-all placeholder-slate-300 font-medium leading-relaxed"
                      placeholder="Type your text here…" />

                    {/* Common: Rotation + Alignment */}
                    <div className="space-y-3 pt-2 border-t border-slate-100">
                      <RotationControl value={overlay.rotation || 0}
                        onChange={v => updateOverlay({ rotation: v })} />
                      <OverlayAlignControl type="text"
                        onUpdate={patch => updateOverlay(patch as Partial<TextOverlay>)} />
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
                }} className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-gradient-to-r from-pink-500 to-violet-500 text-white rounded-2xl text-xs font-black hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] transition-all border-none">
                  <Type className="w-4 h-4" /> ADD TEXT OVERLAY
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
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-extrabold text-indigo-500 uppercase tracking-wider">
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
                    <div className="space-y-3 pt-3 border-t border-slate-100">
                      <RotationControl value={shape.rotation || 0}
                        onChange={v => updateShape({ rotation: v })} />
                      <ScaleControl width={shape.width} height={shape.height}
                        onScale={(w, h) => updateShape({ width: w, height: h })} />
                      <OverlayAlignControl type="shape" width={shape.width} height={shape.height}
                        onUpdate={patch => updateShape(patch as Partial<ShapeOverlay>)} />
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
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <img src={imgOverlay.src} alt={imgOverlay.label} className="w-7 h-7 object-contain shrink-0" />
                        <p className="text-[10px] font-extrabold text-emerald-600 uppercase tracking-wider truncate">{imgOverlay.label}</p>
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
                    <div className="space-y-3 pt-3 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                      <OverlayAlignControl type="image" width={imgOverlay.width} height={imgOverlay.height}
                        onUpdate={patch => updateImage(patch as Partial<ImageOverlay>)} />
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
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-extrabold text-fuchsia-500 uppercase tracking-wider truncate max-w-[70%]">{imgOverlay.label}</p>
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
                    <div className="space-y-3 pt-3 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                      <OverlayAlignControl type="image" width={imgOverlay.width} height={imgOverlay.height}
                        onUpdate={patch => updateImage(patch as Partial<ImageOverlay>)} />
                    </div>
                  </div>
                );
              }
              // Upload UI
              return (
                <div className="space-y-4">
                  <label className="group relative w-full flex flex-col items-center justify-center gap-2 p-5 bg-gradient-to-br from-violet-50 to-fuchsia-50 border-2 border-dashed border-violet-200/50 rounded-3xl text-violet-600 hover:from-violet-100 hover:to-fuchsia-100 transition-all cursor-pointer overflow-hidden shadow-sm">
                    <div className="p-3 bg-white rounded-2xl shadow-sm text-violet-500 group-hover:scale-110 transition-transform">
                      <ImagePlus className="w-6 h-6" />
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
            i === fIdx ? { ...f, processedUrl: null, offset: { x: 0, y: 0 }, scale: 1, rotation: 0 } : f);
          debouncedRender({ ...editingCanvas, frames: newFrames });
        }}
      />

      {/* ── Save button ──────────────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 bg-white border-t border-slate-200/60 z-10 relative">
        <button onClick={handleSaveChanges}
          className="w-full py-2.5 bg-gradient-to-r from-violet-600 via-purple-600 to-pink-600 text-white rounded-2xl text-xs font-extrabold hover:from-violet-700 hover:via-purple-700 hover:to-pink-700 transition-all flex items-center justify-center gap-1.5 active:scale-[0.98] shadow-lg shadow-purple-200">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" /> Save Changes
        </button>
      </div>
    </div>
  );
}
