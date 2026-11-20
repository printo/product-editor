'use client';

import React, { useEffect, useId, useState, useRef } from 'react';
import { Minus, Plus, AlignLeft, AlignCenter, AlignRight, Trash2, Type, ImagePlus, Image, Sparkles, RotateCw, AlignCenterHorizontal, AlignCenterVertical, CheckCircle2, AlertTriangle, Layers, Palette } from 'lucide-react';
import { clsx } from 'clsx';
import { ColorPicker } from '@/components/ColorPicker';
import { Dropdown } from '@/components/ui/Dropdown';
import { LayersPanel, type LayerSelection } from './LayersPanel';
import { IconBrowser } from './IconBrowser';
import { AlignmentToolbar } from './AlignmentToolbar';
import { isLostLocalImage, type OverlayAlignment } from './editor-utils';
import { ARTWORK_LABEL, artworkOverlayFor } from './template-authoring';
import { UnprintableTextNote } from './EditorNotices';
import { isAllowedImageFile, IMAGE_AND_PDF_ACCEPT_ATTR } from '@/lib/upload-utils';
import { convertHeicFiles, type ServerHeicConverter } from '@/lib/heic-convert';
import { useIsPhone } from '@/lib/use-is-phone';
import { ownIconUrl } from '@/lib/icon-source';
import { DEFAULT_OVERLAY_FONT, fontOptionLabel, overlayFontFamily } from '@/lib/overlay-fonts';
import type { CanvasItem, FitMode, Overlay, TextOverlay, ImageOverlay } from './types';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CanvasEditorSidebarProps {
  editingCanvas: CanvasItem | null;
  layout: any;
  selectedLayer: LayerSelection;
  setSelectedLayer: React.Dispatch<React.SetStateAction<LayerSelection>>;
  handleAlign: (fIdx: number, alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  handleOverlayAlign: (oIdx: number, alignment: OverlayAlignment) => void;
  handleUpdateTransform: (fIdx: number, updates: Partial<{ scale: number; x: number; y: number; rotation: number }>) => void;
  handleSaveChanges: () => void;
  getFileUrl: (file: File) => string;
  debouncedRender: (updated: CanvasItem) => void;
  pushUndo: (canvas: CanvasItem, isMajor?: boolean) => void;
  loadGoogleFont: (name: string) => void;
  selectedFonts: string[];
  fontLanguages?: Record<string, string[]>;
  getImageMetadata: (file: File) => Promise<{ width: number; height: number; orientation: number; element: HTMLImageElement }>;
  calculateSmartCropOffsets: (img: HTMLImageElement | HTMLCanvasElement, frameW: number, frameH: number, rotation: number, cacheKey?: string) => Promise<{ x: number; y: number }>;
  /** Expands any PDFs in a picked file list into customer-chosen page
   *  images, showing a picker modal when needed — see use-pdf-page-import. */
  expandPdfPages: (files: File[], opts: { maxSelectable: number | null }) => Promise<File[]>;
  /** Server-side HEIC decode, used when the browser decoders fail — see
   *  lib/heic-convert.ts. Optional so the component still renders in
   *  isolation (tests, storybook) without an API base. */
  serverHeicConvert?: ServerHeicConverter;
  /** The pieces of a text overlay the print can't draw in its font
   *  (useUnprintableText.ts); shown under the text box. Optional like the
   *  converter above. */
  unprintableFor?: (overlay: Overlay) => string[];
  /** Unsupported characters were taken out of a text box while this editor
   *  was open; say so under the text box. */
  textRemoved?: boolean;
  /** The page's API proxy and its auth headers, for the icon search. */
  apiBase?: string;
  getAuthHeaders?: () => Record<string, string>;
}

// ─── Tab config ───────────────────────────────────────────────────────────────

type TabKey = 'background' | 'text' | 'icon' | 'image';

const ADD_TABS: { key: TabKey; label: string; icon: React.ElementType; activeClass: string; gradient: string }[] = [
  { key: 'background', label: 'BG',      icon: Sparkles, activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
  { key: 'text',       label: 'Text',    icon: Type,     activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
  { key: 'icon',       label: 'Icons',   icon: Sparkles, activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
  { key: 'image',      label: 'Uploads', icon: Image,    activeClass: 'text-violet-600', gradient: 'from-violet-500 to-fuchsia-500' },
];

// On a phone the sheet shows one section at a time, chosen from one pinned row
// of tabs: the photo's own controls, one of the add tabs above, or the layers.
type PhoneView = 'photo' | 'add' | 'layers';

const PHONE_TAB_ICONS: Record<TabKey, React.ElementType> = {
  background: Palette, text: Type, icon: Sparkles, image: ImagePlus,
};

function SheetTab({ label, icon: Icon, active, onClick, phone = false }: {
  label: string; icon: React.ElementType; active: boolean; onClick: () => void; phone?: boolean;
}) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={clsx('flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg transition-all duration-300 relative overflow-hidden',
        active
          ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-200'
          : 'text-slate-500 hover:text-slate-600 scale-95')}>
      <Icon className={clsx('w-4 h-4 transition-all', active ? 'text-white' : 'text-slate-500')} />
      <span className={clsx('font-medium uppercase transition-all', phone ? 'text-[10px]' : 'text-[9px]', active ? 'text-white' : 'text-slate-500')}>
        {label}
      </span>
    </button>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

/** A number box that lets the customer finish typing. The value is applied as
 *  soon as it is a whole number within [min, max], and corrected into the range
 *  only when the box loses focus or Enter is pressed: correcting it on every
 *  keystroke turned "16" into 86 (the "1" was raised to the minimum first). */
function DraftNumberInput({ value, min, max, onCommit, onFocus, className, label }: {
  value: number; min: number; max: number;
  onCommit: (v: number) => void; onFocus?: () => void; className?: string; label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, n)));
    setDraft(null);
  };
  return (
    <input type="number" inputMode="numeric" min={min} max={max}
      value={draft ?? String(value)}
      onFocus={onFocus}
      aria-label={label}
      onChange={e => {
        setDraft(e.target.value);
        const n = parseInt(e.target.value, 10);
        if (Number.isFinite(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={finish}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(); }
        else if (e.key === 'Escape' && draft !== null) { e.stopPropagation(); setDraft(null); }
      }}
      className={className} />
  );
}

/** The box of a photo or icon added on top of the design, in percent of the
 *  canvas: the picture's own shape, `widthPct` (30) of the canvas wide, made
 *  smaller when that would be taller than 60% of it. */
export function addedPhotoBox(imgW: number, imgH: number, canvasW: number, canvasH: number, widthPct = 30): { width: number; height: number } {
  if (!(imgW > 0 && imgH > 0 && canvasW > 0 && canvasH > 0)) return { width: widthPct, height: widthPct };
  let width = widthPct;
  let height = width * (canvasW / canvasH) * (imgH / imgW);
  if (height > 60) { width *= 60 / height; height = 60; }
  return { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 };
}

// The phone's way to add another icon or photo while one is selected: its
// settings fill the sheet, and the add controls below them went unseen.
const PHONE_ADD_BUTTON = 'shrink-0 h-9 px-3 flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white text-[11px] font-medium uppercase cursor-pointer';

/** Opacity of an added picture: its label, value and slider, on one line on a
 *  phone. */
function OpacityControl({ value, tone, onChange }: { value: number; tone: 'emerald' | 'rose'; onChange: (v: number) => void }) {
  const percent = Math.round(value * 100);
  return (
    <div className="flex items-center gap-4 py-1 md:block md:space-y-3 md:py-0">
      <div className="flex items-center justify-between gap-2 md:gap-0">
        <label className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">Opacity</label>
        <span className={clsx('hidden md:inline text-[11px] font-mono font-medium', tone === 'emerald' ? 'text-emerald-600' : 'text-rose-600')}>{percent}%</span>
      </div>
      <input type="range" min="0" max="100" step="5" value={percent}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        aria-label="Opacity" aria-valuetext={`${percent} percent`}
        className={clsx('flex-1 md:w-full h-1 bg-slate-100 rounded-full appearance-none cursor-pointer', tone === 'emerald' ? 'accent-emerald-500' : 'accent-rose-500')} />
      <span className={clsx('md:hidden w-10 text-right text-[11px] font-mono font-medium', tone === 'emerald' ? 'text-emerald-600' : 'text-rose-600')}>{percent}%</span>
    </div>
  );
}

/** A picture's own pixel size, read from an image that is never put on the
 *  page; null when it does not load within a moment (the icon is then taken
 *  as square, which nearly all are). */
function pictureSize(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const img = new window.Image();
    const timer = setTimeout(() => resolve(null), 1500);
    const done = (size: { width: number; height: number } | null) => { clearTimeout(timer); resolve(size); };
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = src;
  });
}

/** A step button that keeps stepping while it is held, for a finger or the
 *  mouse; a keyboard press steps once. */
function HoldButton({ onStep, label, className, children }: {
  onStep: () => void; label: string; className?: string; children: React.ReactNode;
}) {
  const stepRef = useRef(onStep);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { stepRef.current = onStep; });
  const stop = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => stop, []);
  const start = () => {
    stop();
    stepRef.current();
    const tick = () => { stepRef.current(); timerRef.current = setTimeout(tick, 80); };
    timerRef.current = setTimeout(tick, 400);
  };
  return (
    <button type="button" aria-label={label}
      onPointerDown={e => { if (e.button === 0) start(); }}
      onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onContextMenu={e => e.preventDefault()}
      // A click with no pointer behind it is the keyboard's.
      onClick={e => { if (e.detail === 0) onStep(); }}
      className={clsx('select-none touch-manipulation [-webkit-touch-callout:none]', className)}>
      {children}
    </button>
  );
}

/** Rotation slider + 90deg increment + number input — Premium version */
function RotationControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const sliderId = useId();
  return (
    <div className="flex items-center gap-4 py-1 md:py-2 bg-transparent">
      <label htmlFor={sliderId} className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">Rotate</label>
      
      <div className="flex-1 relative h-6 flex items-center group">
        <div className="absolute inset-0 bg-slate-100 rounded-full h-1 my-auto" />
        <input id={sliderId} type="range" min="0" max="359" step="1" value={value} aria-valuetext={`${value} degrees`}
          onChange={e => onChange(parseInt(e.target.value))}
          className="w-full relative z-10 appearance-none bg-transparent cursor-pointer accent-indigo-500" />
      </div>
      
      <div className="flex items-center gap-2">
        <button onClick={() => onChange((value + 90) % 360)} aria-label="Rotate 90 degrees"
          className="w-8 h-8 flex items-center justify-center bg-white text-slate-500 border border-slate-200 rounded-lg hover:text-indigo-600 hover:border-indigo-100 transition-all group/btn">
          <RotateCw className="w-3.5 h-3.5 motion-safe:group-hover/btn:rotate-90 transition-transform duration-500" />
        </button>
        
        <div className="relative">
          <DraftNumberInput min={0} max={359} value={value} onCommit={onChange} label="Rotation in degrees"
            className="w-11 h-8 px-0 text-base md:text-[11px] font-mono font-medium text-center border border-slate-200 rounded-lg bg-white text-slate-700 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all" />
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-slate-500 pointer-events-none">°</span>
        </div>
      </div>
    </div>
  );
}

/** Proportional scale slider + number input — Premium version */
function ScaleControl({ label = "Zoom", width, height, onScale }: { label?: string; width: number; height: number; onScale: (w: number, h: number) => void }) {
  const baseRef = useRef<{ w: number; h: number } | null>(null);
  const sliderId = useId();
  return (
    <div className="flex items-center gap-4 py-1 md:py-2 bg-transparent">
      <label htmlFor={sliderId} className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">{label}</label>
      
      <div className="flex-1 relative h-6 flex items-center group">
        <div className="absolute inset-0 bg-slate-100 rounded-full h-1 my-auto" />
        <input id={sliderId} type="range" min="5" max="250" step="1" value={Math.round(width)} aria-valuetext={`${Math.round(width)} percent`}
          onPointerDown={() => { baseRef.current = { w: width, h: height }; }}
          onChange={e => {
            const newW = parseInt(e.target.value);
            const base = baseRef.current ?? { w: width, h: height };
            const ratio = base.h / (base.w || 1);
            onScale(newW, Math.max(1, Math.min(250, Math.round(newW * ratio))));
          }}
          className="w-full relative z-10 appearance-none bg-transparent cursor-pointer accent-indigo-500" />
      </div>
      
      <div className="relative">
        <DraftNumberInput min={5} max={250} value={Math.round(width)} label={`${label} in percent`}
          onFocus={() => { baseRef.current = { w: width, h: height }; }}
          onCommit={newW => {
            const base = baseRef.current ?? { w: width, h: height };
            const ratio = base.h / (base.w || 1);
            onScale(newW, Math.max(1, Math.min(250, Math.round(newW * ratio))));
          }}
          className="w-11 h-8 px-0 text-base md:text-[11px] font-mono font-medium text-center border border-slate-200 rounded-lg bg-white text-slate-700 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all" />
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-slate-500 pointer-events-none">%</span>
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
  fontLanguages,
  getImageMetadata,
  calculateSmartCropOffsets,
  expandPdfPages,
  serverHeicConvert,
  unprintableFor,
  textRemoved = false,
  apiBase,
  getAuthHeaders,
}: CanvasEditorSidebarProps) {

  const tabForSelection = (sel: LayerSelection): TabKey | null => {
    if (sel.type === 'text') return 'text';
    if (sel.type !== 'image') return null;
    const ov = editingCanvas?.overlays[sel.index];
    return ov?.type === 'image' && ov.source === 'local' ? 'image' : 'icon';
  };
  // The modal can open with an image already selected (one that couldn't be
  // recovered), so the first tab follows the selection too.
  const [activeAddTab, setActiveAddTab] = useState<TabKey>(() => tabForSelection(selectedLayer) ?? 'text');
  const isPhone = useIsPhone();
  const [phoneView, setPhoneView] = useState<PhoneView>(() => (tabForSelection(selectedLayer) ? 'add' : 'photo'));

  // ── Auto-switch tab when overlay is selected on canvas ───────────────────
  // React docs' "adjust state when a prop changes" pattern — guard a
  // render-phase setState with a stable identity check on the dependency.
  // Avoids the cascading-render hazard of doing this inside useEffect
  // (https://react.dev/learn/you-might-not-need-an-effect).
  const selectionKey = `${selectedLayer.type}:${selectedLayer.index}`;
  const [lastSelectionKey, setLastSelectionKey] = useState(selectionKey);
  const fieldId = useId();
  const iconBrowserRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const [iconOpenSignal, setIconOpenSignal] = useState(0);
  // Opens the icon search and brings it to the top of the sheet's own scroll
  // area. Not scrollIntoView: that also scrolled the sheet itself, which is
  // clipped, and the tabs went off the top with no way to bring them back.
  const showIconSearch = () => {
    setIconOpenSignal(n => n + 1);
    requestAnimationFrame(() => {
      const body = scrollBodyRef.current;
      const target = iconBrowserRef.current;
      if (!body || !target) return;
      body.scrollTo({ top: body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top, behavior: 'smooth' });
    });
  };
  if (selectionKey !== lastSelectionKey) {
    setLastSelectionKey(selectionKey);
    const tab = tabForSelection(selectedLayer);
    if (tab) setActiveAddTab(tab);
    // The phone sheet follows a tap on the canvas, except from the Layers
    // tab, where picking a row only selects it so the list stays in view.
    if (phoneView !== 'layers') {
      if (tab) setPhoneView('add');
      else if (selectedLayer.type === 'frame' || selectedLayer.type === 'canvas') setPhoneView('photo');
    }
  }

  if (!editingCanvas) return null;

  // ── Shared delete helper ─────────────────────────────────────────────────
  const deleteOverlay = (idx: number) => {
    pushUndo(editingCanvas, true);
    debouncedRender({ ...editingCanvas, overlays: editingCanvas.overlays.filter((_, i) => i !== idx) });
    setSelectedLayer({ type: 'frame', index: 0 });
  };

  // PDF pages are expanded first (see pdf-import.ts), then iPhone HEIC photos
  // are converted to JPEG (see heic-convert.ts), then unsupported types (e.g.
  // .svg) are dropped — they'd preview in the browser but fail to render
  // server-side.
  const prepareImageFiles = async (picked: File[], maxSelectable: number | null) => {
    const expandedFiles = await expandPdfPages(picked, { maxSelectable });
    const { converted } = await convertHeicFiles(expandedFiles, serverHeicConvert);
    return converted.filter(isAllowedImageFile);
  };

  // The add controls of the Icons and Uploads tabs. Shown on their own when
  // nothing of that kind is selected, and under the selected image's settings
  // otherwise: until 2026-10-13 selecting an icon or sticker hid them, so a
  // second one could only be added after selecting some other layer.
  const handleAddPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
                        if (!e.target.files?.length) return;
                        const rawFiles = Array.from(e.target.files);
                        e.target.value = '';
                        const files = await prepareImageFiles(rawFiles, null);
                        if (files.length === 0) return;
                        // The box takes the photo's own shape. Its sides are
                        // percentages of a canvas that is rarely square, so
                        // equal numbers squeezed every photo into the
                        // canvas's shape.
                        const canvasW = layout?.canvas?.width || 1200;
                        const canvasH = layout?.canvas?.height || 1800;
                        const boxes = await Promise.all(files.map(async file => {
                          try {
                            const { width, height } = await getImageMetadata(file);
                            return addedPhotoBox(width, height, canvasW, canvasH);
                          } catch {
                            return { width: 30, height: 30 };
                          }
                        }));
                        pushUndo(editingCanvas, true);
                        let updated = { ...editingCanvas };
                        for (const [i, file] of files.entries()) {
                          const newOverlay: Overlay = {
                            id: Math.random().toString(36).slice(2, 11),
                            type: 'image', src: getFileUrl(file), originalFile: file,
                            source: 'local', x: 50, y: 50, ...boxes[i],
                            rotation: 0, opacity: 1, label: file.name,
                          };
                          updated = { ...updated, overlays: [...updated.overlays, newOverlay] };
                        }
                        debouncedRender(updated);
                        setSelectedLayer({ type: 'image', index: updated.overlays.length - 1 });
                      };

  const addIconBlock = (
                <div className="w-full">
                  <IconBrowser apiBase={apiBase} getAuthHeaders={getAuthHeaders} openSignal={iconOpenSignal} onAddImage={async imgOverlay => {
                    // An icon's box is in percent of a canvas that is rarely
                    // square, so the equal numbers it comes with squeezed it.
                    const size = await pictureSize(ownIconUrl(imgOverlay.src));
                    const box = addedPhotoBox(size?.width ?? 1, size?.height ?? 1,
                      layout?.canvas?.width || 1200, layout?.canvas?.height || 1800, imgOverlay.width);
                    pushUndo(editingCanvas, true);
                    const newOverlay: Overlay = { type: 'image', ...imgOverlay, ...box };
                    const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                    debouncedRender(updated);
                    setSelectedLayer({ type: 'image', index: updated.overlays.length - 1 });
                  }} />
                </div>
  );
  const addPhotoBlock = (
                <div>
                  <label className="group relative w-full flex flex-col items-center justify-center gap-2 p-4 bg-slate-50 border-2 border-dashed border-slate-200 rounded-lg text-rose-500 hover:bg-white hover:border-rose-200 transition-all cursor-pointer overflow-hidden shadow-sm">
                    <div className="p-3 bg-rose-50 rounded-lg shadow-inner motion-safe:group-hover:scale-110 transition-all duration-500">
                      <ImagePlus className="w-6 h-6" />
                    </div>
                    <div className="text-center">
                      <p className="text-[11px] font-medium uppercase">Add Photo</p>
                      <p className="text-[10px] text-slate-500 uppercase tracking-tight opacity-80">Floating overlay</p>
                    </div>
                    <input type="file" multiple accept={IMAGE_AND_PDF_ACCEPT_ATTR} className="hidden"
                      onChange={handleAddPhotos} />
                  </label>
                </div>
  );

  const layersPanel = (
        <LayersPanel
          alwaysOpen={isPhone}
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
          onClearFrame={async fIdx => {
            pushUndo(editingCanvas, true);
            const updatedFrames = await Promise.all(editingCanvas.frames.map(async (f, i) => {
              if (i !== fIdx) return f;
              
              let newOffset = { x: 0, y: 0 };
              if (f.fitMode === 'cover' && f.originalFile) {
                const { element: imgEl } = await getImageMetadata(f.originalFile);
                const canvasW = layout?.canvas?.width || 1200;
                const canvasH = layout?.canvas?.height || 1800;
                const frameSpec = layout?.frames?.[fIdx] || { x: 0, y: 0, width: canvasW, height: canvasH };
                const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
                const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
                const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
                const ck = f.fileId ? `${f.fileId}:${fw}x${fh}:0` : undefined;
                newOffset = await calculateSmartCropOffsets(imgEl, fw, fh, 0, ck); // reset rotation to 0
              }
              
              return { ...f, offset: newOffset, scale: 1, rotation: 0 };
            }));
            debouncedRender({ ...editingCanvas, frames: updatedFrames });
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
  );

  const showFrameProps = isPhone
    ? phoneView === 'photo'
    : selectedLayer.type === 'frame' || selectedLayer.type === 'canvas';

  return (
    // Mobile (<md): a bottom sheet of one fixed height (so the canvas does not
    // jump between tabs) with the tabs pinned on top and one section below.
    // Save and the layers bar are not in it: Save sits in the modal's top row.
    // md+: the classic fixed-width right rail.
    <div className="w-full h-[48dvh] max-h-[340px] md:h-auto border-t rounded-t-2xl shadow-2xl md:w-[380px] md:max-w-[380px] md:max-h-none md:border-t-0 md:rounded-none md:shadow-xl shrink-0 flex-none border-l border-slate-200/50 bg-white/95 backdrop-blur-3xl flex flex-col overflow-hidden relative z-20">
      {/* Subtle Background Blobs for Premium feel */}
      <div className="absolute -top-32 -right-32 w-80 h-80 bg-indigo-50/50 blur-[100px] -z-10 rounded-full" />
      <div className="absolute top-1/2 -left-32 w-64 h-64 bg-fuchsia-50/30 blur-[80px] -z-10 rounded-full" />
      
      {isPhone && (
        <div className="px-3 pt-3 pb-1 touch-none">
          <div className="flex items-center p-1 bg-slate-50 rounded-lg border border-slate-100">
            <SheetTab phone label="Photo" icon={Image} active={phoneView === 'photo'}
              onClick={() => {
                setPhoneView('photo');
                if (selectedLayer.type !== 'frame' && selectedLayer.type !== 'canvas') setSelectedLayer({ type: 'frame', index: 0 });
              }} />
            {ADD_TABS.map(tab => (
              <SheetTab phone key={tab.key} label={tab.label} icon={PHONE_TAB_ICONS[tab.key]}
                active={phoneView === 'add' && activeAddTab === tab.key}
                onClick={() => { setActiveAddTab(tab.key); setPhoneView('add'); }} />
            ))}
            <SheetTab phone label="Layers" icon={Layers} active={phoneView === 'layers'}
              onClick={() => setPhoneView('layers')} />
          </div>
        </div>
      )}

      {/* ── Scrollable body ────────────────────────────────────────────────── */}
      <div ref={scrollBodyRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-2 pb-[calc(1rem+env(safe-area-inset-bottom))] md:py-4 custom-scrollbar">
      {/* On a phone the content is always a pixel taller than the area, so the
          area always scrolls and keeps a drag to itself. With nothing to
          scroll, a drag on the sheet moved the page behind the editor, the
          browser's bars slid in and out, and the canvas resized each time. */}
      <div className="space-y-6 min-h-[calc(100%+1px)] md:min-h-0">

        {/* ═══ Frame properties ════ */}
        {showFrameProps && (() => {
          const fIdx = selectedLayer.type === 'frame' ? selectedLayer.index : 0;
          const frame = editingCanvas.frames[fIdx];
          if (!frame) return null;
          // On a phone Zoom sits with the other sliders, above the fold.
          const zoomControl = (
            <ScaleControl label="Zoom" width={frame.scale * 100} height={100}
              onScale={(w) => handleUpdateTransform(fIdx, { scale: w / 100 })} />
          );
          return (
            <div className="space-y-1 md:space-y-3">
              {/* Fit */}
              <div className="flex items-center gap-4 py-1 md:py-2 bg-transparent">
                <label className="text-[11px] font-medium text-slate-500 uppercase min-w-[50px]">Fit Mode</label>
                <div className="flex-1 flex gap-1 p-1 bg-slate-50 rounded-lg border border-slate-100 shadow-inner">
                  {(['contain', 'cover'] as FitMode[]).map(mode => (
                    <button key={mode}
                      onClick={async () => {
                        pushUndo(editingCanvas, true);
                        const updatedFrames = await Promise.all(editingCanvas.frames.map(async (f, i) => {
                          if (i !== fIdx) return f;
                          
                          let newOffset = { x: 0, y: 0 };
                          if (mode === 'cover' && f.originalFile) {
                            const { element: imgEl } = await getImageMetadata(f.originalFile);
                            const canvasW = layout?.canvas?.width || 1200;
                            const canvasH = layout?.canvas?.height || 1800;
                            const frameSpec = layout?.frames?.[fIdx] || { x: 0, y: 0, width: canvasW, height: canvasH };
                            const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
                            const fw = isPercent ? frameSpec.width * canvasW : frameSpec.width;
                            const fh = isPercent ? frameSpec.height * canvasH : frameSpec.height;
                            const ck = f.fileId ? `${f.fileId}:${fw}x${fh}:${f.rotation}` : undefined;
                            newOffset = await calculateSmartCropOffsets(imgEl, fw, fh, f.rotation, ck);
                          }
                          
                          return { ...f, fitMode: mode, scale: 1, offset: newOffset };
                        }));
                        debouncedRender({ ...editingCanvas, frames: updatedFrames });
                      }}
                      className={clsx('flex-1 py-1.5 text-[10px] font-medium rounded-md transition-all uppercase',
                        frame.fitMode === mode 
                          ? 'bg-indigo-600 text-white shadow-sm' 
                          : 'text-slate-500 hover:text-slate-600')}>
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
              {isPhone && zoomControl}

              {/* Caption — per-template opt-in (layout.frameCaptionsEnabled); OFF by
                  default so it never appears on a product it wasn't designed for. */}
              {Boolean(layout?.frameCaptionsEnabled) && (
              <div className="space-y-2 pt-4 border-t border-slate-50">
                <label htmlFor={`${fieldId}-caption`} className="text-[11px] font-medium text-slate-500 uppercase">Caption</label>
                <textarea
                  id={`${fieldId}-caption`}
                  value={frame.caption || ''}
                  onChange={(e) => {
                    pushUndo(editingCanvas, true);
                    const updatedFrames = editingCanvas.frames.map((f, i) => i === fIdx ? { ...f, caption: e.target.value } : f);
                    debouncedRender({ ...editingCanvas, frames: updatedFrames });
                  }}
                  placeholder="Optional caption"
                  className="min-h-[72px] w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-base md:text-[12px] text-slate-600 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50"
                />
                <label className="flex items-center gap-2 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={Boolean(frame.captionEnabled)}
                    onChange={(e) => {
                      pushUndo(editingCanvas, true);
                      const updatedFrames = editingCanvas.frames.map((f, i) => i === fIdx ? { ...f, captionEnabled: e.target.checked } : f);
                      debouncedRender({ ...editingCanvas, frames: updatedFrames });
                    }}
                  />
                  Show caption in output
                </label>
              </div>
              )}

              {/* Blur Effect + Photo Alignment share one row. Blur only applies in
                  contain mode, where a photo whose aspect ratio differs from the
                  frame leaves whitespace; in cover mode it's hidden and alignment
                  takes the whole row. On a phone they stack, one per line. */}
              <div className="flex flex-col gap-2 pt-2 md:flex-row md:items-start md:gap-4 md:pt-4 border-t border-slate-50">
                {frame.fitMode === 'contain' && (() => {
                  const fillOn = frame.fillStyle === 'blur';
                  return (
                    <div className="min-w-0 flex-1 flex items-center gap-3 md:block md:space-y-2">
                      <div className="flex items-center gap-2 shrink-0">
                        <label className="text-[11px] font-medium text-slate-500 uppercase">Blur Effect</label>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={fillOn}
                          aria-label="Blur Effect — fill empty space with a blurred copy of the photo"
                          onClick={() => {
                            pushUndo(editingCanvas, true);
                            const fillStyle = fillOn ? undefined : ('blur' as const);
                            const updatedFrames = editingCanvas.frames.map((f, i) => i === fIdx ? { ...f, fillStyle } : f);
                            debouncedRender({ ...editingCanvas, frames: updatedFrames });
                          }}
                          className={clsx(
                            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
                            fillOn ? 'bg-indigo-600' : 'bg-slate-500',
                          )}
                        >
                          <span className={clsx(
                            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                            fillOn ? 'translate-x-[18px]' : 'translate-x-0.5',
                          )} />
                        </button>
                      </div>
                      <p className="text-[10px] leading-4 text-slate-500 min-w-0">Blur the photo behind it to fill empty space</p>
                    </div>
                  );
                })()}

                {/* Position / Alignment */}
                <div className="shrink-0 flex items-center justify-between gap-3 md:block md:space-y-2">
                  <label className="text-[11px] font-medium text-slate-500 uppercase">Photo Alignment</label>
                  <AlignmentToolbar 
                    onHAlign={v => handleAlign(fIdx, v)}
                    onVAlign={v => handleAlign(fIdx, v)}
                  />
                </div>
              </div>

              {!isPhone && zoomControl}
            </div>
          );
        })()}

        {/* ═══ Add-object tabs ════════════════════════════════════════════ */}
        {(!isPhone || phoneView === 'add') && (
        <div className="space-y-4">
          {/* Tab bar (on a phone it is the pinned row above) */}
          {!isPhone && (
          <div className="flex items-center p-1 bg-slate-50 rounded-lg border border-slate-100">
            {ADD_TABS.map(tab => (
              <SheetTab key={tab.key} label={tab.label} icon={tab.icon}
                active={activeAddTab === tab.key} onClick={() => setActiveAddTab(tab.key)} />
            ))}
          </div>
          )}

          {/* Tab content */}
          <div className="min-h-[80px] w-full">

            {/* ── Background tab ────────────────────────────────────────── */}
            {activeAddTab === 'background' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-lg shadow-sm hover:border-indigo-100 transition-all group">
                  <div className="space-y-0.5">
                    <p className="text-[11px] font-medium text-slate-800 uppercase">Background Colour</p>
                    <p className="text-[10px] text-slate-500 uppercase tracking-tight">Base canvas color</p>
                  </div>
                  <ColorPicker value={editingCanvas.bgColor || '#ffffff'} ariaLabel="Background colour"
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
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as Overlay[] });
                };
                const deleteButton = (
                  <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                        className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-lg transition-all motion-safe:active:scale-90">
                        <Trash2 className="w-4 h-4" />
                      </button>
                );
                const fontField = (
                  <Dropdown
                          labelledBy={`${fieldId}-font`}
                          value={overlayFontFamily(overlay.fontFamily)}
                          onChange={(f) => { loadGoogleFont(f); updateOverlay({ fontFamily: f }); }}
                          options={selectedFonts.map(f => ({ value: f, label: fontOptionLabel(f, fontLanguages), labelStyle: { fontFamily: f } }))}
                          panelClassName="w-full"
                          triggerClassName="w-full h-11 bg-white border border-slate-200 rounded-lg text-[11px] font-medium text-slate-700 px-4 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none hover:bg-slate-50 transition-all shadow-sm"
                          optionClassName="text-[11px] font-medium"
                        />
                );
                const sizeField = (
                  <div className="flex items-center bg-white border border-slate-200 rounded-lg h-11 px-2 shadow-sm">
                            <HoldButton onStep={() => updateOverlay({ fontSize: Math.max(8, (overlay.fontSize || 24) - 2) })} label="Smaller text"
                              className="p-2 md:p-1.5 text-slate-500 hover:text-indigo-600 transition-colors rounded-lg"><Minus className="w-3.5 h-3.5" /></HoldButton>
                            <DraftNumberInput min={8} max={2000} value={overlay.fontSize || 24} label="Font size"
                              onCommit={fontSize => updateOverlay({ fontSize })}
                              className="flex-1 min-w-0 text-center text-base md:text-[11px] font-mono font-medium text-slate-700 bg-transparent border-none outline-none p-0" />
                            <HoldButton onStep={() => updateOverlay({ fontSize: Math.min(2000, (overlay.fontSize || 24) + 2) })} label="Larger text"
                              className="p-2 md:p-1.5 text-slate-500 hover:text-indigo-600 transition-colors rounded-lg"><Plus className="w-3.5 h-3.5" /></HoldButton>
                          </div>
                );
                const colorField = (
                  <div className="bg-white border border-slate-200 rounded-lg h-11 flex items-center justify-center shadow-sm">
                            <ColorPicker value={overlay.color || '#000000'} showHex={false} ariaLabel="Text colour" onChange={color => updateOverlay({ color })} />
                          </div>
                );
                const alignField = (
                  <div role="group" aria-labelledby={`${fieldId}-align`} className="flex items-center bg-slate-50 rounded-lg h-11 p-1 shadow-inner border border-slate-100">
                          {[{ key: 'left' as const, icon: AlignLeft }, { key: 'center' as const, icon: AlignCenter }, { key: 'right' as const, icon: AlignRight }].map(({ key, icon: Icon }) => (
                            <button key={key} onClick={() => updateOverlay({ textAlign: key })}
                              aria-label={`Align ${key}`} aria-pressed={(overlay.textAlign ?? 'center') === key}
                              className={clsx('flex-1 flex items-center justify-center h-full rounded-lg transition-all',
                              (overlay.textAlign ?? 'center') === key 
                                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200' 
                                : 'text-slate-500 hover:text-slate-600')}>
                              <Icon className="w-4 h-4" />
                            </button>
                          ))}
                        </div>
                );
                const contentField = (
                  <>
                    <textarea id={`${fieldId}-content`} value={overlay.text} onChange={e => updateOverlay({ text: e.target.value })}
                          className="w-full h-20 md:h-28 text-base md:text-[12px] font-normal bg-white border border-slate-200 rounded-lg p-3 md:p-4 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all placeholder-slate-500 text-slate-700 resize-none shadow-sm leading-relaxed"
                          placeholder="Type your message…" />
                    <UnprintableTextNote chars={unprintableFor?.(overlay) ?? []} removed={textRemoved} />
                  </>
                );
                const rotateField = (
                  <RotationControl value={overlay.rotation || 0}
                          onChange={v => updateOverlay({ rotation: v })} />
                );
                const centerField = (
                  <div className="flex items-center gap-2">
                            <button onClick={() => handleOverlayAlign(oIdx, 'center')} className="flex-1 flex items-center justify-center gap-2 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-lg text-[10px] font-bold text-slate-600 uppercase transition-all">
                              <AlignCenterHorizontal className="w-3.5 h-3.5" /> Center H
                            </button>
                            <button onClick={() => handleOverlayAlign(oIdx, 'middle')} className="flex-1 flex items-center justify-center gap-2 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-lg text-[10px] font-bold text-slate-600 uppercase transition-all">
                              <AlignCenterVertical className="w-3.5 h-3.5" /> Center V
                            </button>
                          </div>
                );
                const label = 'text-[11px] font-medium text-slate-500 uppercase';
                // Phone: font and size on one line, alignment and colour under
                // them on the next, so the text box shows without scrolling. The controls
                // say what they are, so their headings are kept for screen
                // readers only.
                if (isPhone) {
                  return (
                    <div className="space-y-2 pt-1">
                      <label id={`${fieldId}-font`} className="sr-only">Font Family</label>
                      <span id={`${fieldId}-align`} className="sr-only">Alignment</span>
                      <label htmlFor={`${fieldId}-content`} className="sr-only">Content</label>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">{fontField}</div>
                        <div className="w-32 shrink-0">{sizeField}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">{alignField}</div>
                        <div className="w-32 shrink-0 flex items-center gap-2">
                          <div className="flex-1 min-w-0">{colorField}</div>
                          {deleteButton}
                        </div>
                      </div>
                      {contentField}
                      {rotateField}
                      {centerField}
                    </div>
                  );
                }
                return (
                  <div className="space-y-5">
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                      <div className="flex flex-col">
                        <p className="text-[11px] font-medium text-slate-900 uppercase">Text Styling</p>
                        <span className="text-[10px] text-slate-500 uppercase">Edit content & style</span>
                      </div>
                      {deleteButton}
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-3">
                        <label id={`${fieldId}-font`} className={label}>Font Family</label>
                        {fontField}
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-3">
                          <label className={label}>Size</label>
                          {sizeField}
                        </div>
                        <div className="space-y-3">
                          <label className={label}>Color</label>
                          {colorField}
                        </div>
                      </div>

                      <div className="space-y-3">
                        <span id={`${fieldId}-align`} className={`block ${label}`}>Alignment</span>
                        {alignField}
                      </div>

                      <div className="space-y-3">
                        <label htmlFor={`${fieldId}-content`} className={label}>Content</label>
                        {contentField}
                      </div>

                      <div className="pt-4 border-t border-slate-100 space-y-4">
                        {rotateField}

                        <div className="space-y-3">
                          <label className={label}>Center on Canvas</label>
                          {centerField}
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
                    color: '#000000', fontFamily: selectedFonts[0] || DEFAULT_OVERLAY_FONT,
                    textAlign: 'center', rotation: 0,
                  };
                  const updated = { ...editingCanvas, overlays: [...editingCanvas.overlays, newOverlay] };
                  debouncedRender(updated);
                  setSelectedLayer({ type: 'text', index: updated.overlays.length - 1 });
                }} className="w-full h-11 flex items-center justify-center gap-3 bg-indigo-600 text-white rounded-lg text-[11px] font-medium uppercase hover:bg-indigo-700 hover:shadow-lg transition-all motion-safe:active:scale-[0.98]">
                  <Type className="w-4 h-4" /> Add New Text
                </button>
              );
            })()}

            {/* ── Icon tab ──────────────────────────────────────────────── */}
            {activeAddTab === 'icon' && (() => {
              if (tabForSelection(selectedLayer) === 'icon') {
                const oIdx = selectedLayer.index;
                const imgOverlay = editingCanvas.overlays[oIdx];
                if (!imgOverlay || imgOverlay.type !== 'image') return null;
                const updateImage = (patch: Partial<ImageOverlay>) => {
                  pushUndo(editingCanvas);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as Overlay[] });
                };
                return (
                  <div className="space-y-2 md:space-y-5">
                    <div className="flex items-center justify-between gap-2 pb-2 md:pb-4 border-b border-slate-100">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-11 h-11 bg-slate-50 rounded-lg p-2 border border-slate-100 flex items-center justify-center shrink-0 shadow-sm">
                          <img src={imgOverlay.src} alt={imgOverlay.label} className="w-full h-full object-contain" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <p className="text-[11px] font-medium text-slate-900 uppercase truncate">{imgOverlay.label}</p>
                          <span className="text-[10px] text-slate-500 uppercase">Icon Overlay</span>
                        </div>
                      </div>
                      {isPhone && (
                        <button type="button" onClick={showIconSearch}
                          className={PHONE_ADD_BUTTON}>
                          <Plus className="w-3.5 h-3.5" /> Add icon
                        </button>
                      )}
                      <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                        className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-lg transition-all motion-safe:active:scale-90">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <OpacityControl value={imgOverlay.opacity} tone="emerald" onChange={opacity => updateImage({ opacity })} />

                    <div className="flex items-center justify-between gap-3 pt-2 md:block md:space-y-3 md:pt-5 border-t border-slate-100">
                      <label className="text-[11px] font-medium text-slate-500 uppercase">Position</label>
                      <AlignmentToolbar
                        onHAlign={key => handleOverlayAlign(oIdx, key)}
                        onVAlign={key => handleOverlayAlign(oIdx, key)}
                        suffix={imgOverlay.label === ARTWORK_LABEL && layout ? (
                          // A template's full-sheet artwork belongs over what the
                          // side prints; one click puts it back there after a nudge.
                          <button
                            type="button"
                            onClick={() => {
                              const fit = artworkOverlayFor(layout, imgOverlay.src);
                              updateImage({ x: fit.x, y: fit.y, width: fit.width, height: fit.height, rotation: 0 });
                            }}
                            title="Cover what this side prints again: the print areas plus bleed, or the whole canvas"
                            className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-[10px] font-bold uppercase tracking-tight text-slate-600 hover:text-indigo-600 hover:bg-white transition-all"
                          >
                            Fit print area
                          </button>
                        ) : undefined}
                      />
                    </div>

                    <div className="space-y-1 pt-1 md:space-y-5 md:pt-5 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                    </div>
                    <div ref={iconBrowserRef} className="pt-3 md:pt-5 border-t border-slate-100">{addIconBlock}</div>
                  </div>
                );
              }
              return addIconBlock;
            })()}

            {/* ── Uploads tab ───────────────────────────────────────────── */}
            {activeAddTab === 'image' && (() => {
              if (tabForSelection(selectedLayer) === 'image') {
                const oIdx = selectedLayer.index;
                const imgOverlay = editingCanvas.overlays[oIdx];
                if (!imgOverlay || imgOverlay.type !== 'image') return null;
                const updateImage = (patch: Partial<ImageOverlay>) => {
                  pushUndo(editingCanvas);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx ? { ...o, ...patch } : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays as Overlay[] });
                };
                // Keeps the lost image's place, size and rotation. The fileId is
                // cleared so the new File is stored for the next restore.
                const replaceLostImage = async (picked: File[]) => {
                  const [file] = await prepareImageFiles(picked, 1);
                  if (!file) return;
                  pushUndo(editingCanvas, true);
                  const newOverlays = editingCanvas.overlays.map((o, i) => i === oIdx && o.type === 'image'
                    ? { ...o, src: getFileUrl(file), originalFile: file, fileId: undefined, label: file.name }
                    : o);
                  debouncedRender({ ...editingCanvas, overlays: newOverlays });
                };
                return (
                  <div className="space-y-2 md:space-y-5">
                    <div className="flex items-center justify-between gap-2 pb-2 md:pb-4 border-b border-slate-100">
                      <div className="flex flex-col min-w-0 flex-1 md:flex-none md:max-w-[70%]">
                        <p className="text-[11px] font-medium text-slate-900 uppercase truncate">{imgOverlay.label}</p>
                        <span className="text-[10px] text-slate-500 uppercase">Image Overlay</span>
                      </div>
                      {isPhone && (
                        <label className={PHONE_ADD_BUTTON}>
                          <Plus className="w-3.5 h-3.5" /> Add photo
                          <input type="file" multiple accept={IMAGE_AND_PDF_ACCEPT_ATTR} className="hidden" onChange={handleAddPhotos} />
                        </label>
                      )}
                      <button onClick={() => deleteOverlay(oIdx)} title="Delete"
                        className="w-9 h-9 flex items-center justify-center bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-lg transition-all motion-safe:active:scale-90">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {isLostLocalImage(imgOverlay) && (
                      <div className="space-y-3 p-3 rounded-lg border border-amber-300 bg-amber-50">
                        <p className="flex gap-2 text-[11px] text-amber-800">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          This image couldn&apos;t be loaded on this device, so it won&apos;t print. Re-upload it to keep its place, or delete it.
                        </p>
                        <label className="w-full h-9 flex items-center justify-center gap-2 rounded-lg bg-amber-600 text-white text-[11px] font-medium uppercase hover:bg-amber-700 transition-colors cursor-pointer">
                          <ImagePlus className="w-4 h-4" />
                          Re-upload image
                          <input type="file" accept={IMAGE_AND_PDF_ACCEPT_ATTR} className="hidden"
                            onChange={e => {
                              const picked = Array.from(e.target.files ?? []);
                              e.target.value = '';
                              if (picked.length) void replaceLostImage(picked);
                            }} />
                        </label>
                      </div>
                    )}
                    <OpacityControl value={imgOverlay.opacity} tone="rose" onChange={opacity => updateImage({ opacity })} />
                    <div className="space-y-1 pt-1 md:space-y-5 md:pt-5 border-t border-slate-100">
                      <RotationControl value={imgOverlay.rotation || 0}
                        onChange={v => updateImage({ rotation: v })} />
                      <ScaleControl width={imgOverlay.width} height={imgOverlay.height}
                        onScale={(w, h) => updateImage({ width: w, height: h })} />
                    </div>
                    {!isPhone && <div className="pt-5 border-t border-slate-100">{addPhotoBlock}</div>}
                  </div>
                );
              }
              return addPhotoBlock;
            })()}

          </div>
        </div>
        )}

        {isPhone && phoneView === 'layers' && layersPanel}
      </div>
      </div>

      {/* ── Layers Panel ────────────────────────────────────────────────── */}
      {!isPhone && (
      <div className="mt-auto px-5 py-1.5 border-t border-amber-300 bg-amber-100/95 backdrop-blur-md">
        {layersPanel}
      </div>
      )}

      {/* ── Save Button ─────────────────────────────────────────────────── */}
      {!isPhone && (
      <div className="px-4 py-3 bg-white border-t border-slate-100">
        <button onClick={handleSaveChanges}
          className="w-full h-12 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-lg font-medium uppercase text-[11px] hover:shadow-lg hover:shadow-indigo-100 motion-safe:active:scale-[0.98] transition-all flex items-center justify-center gap-2 group">
          <CheckCircle2 className="w-4 h-4 transition-transform motion-safe:group-hover:scale-110" />
          Save Changes
        </button>
      </div>
      )}
    </div>
  );
}
