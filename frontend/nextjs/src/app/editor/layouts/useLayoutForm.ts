/**
 * The ops layout editor's form: every field (identity, canvas, print areas,
 * sides, frame picture, print file, Can rotate, captions), the values of the
 * side being edited, and filling or clearing the form for Edit, Duplicate and
 * Create. Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md,
 * step 5); the save request stays in the page with the toasts and the list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasTransparentPixels } from '@/lib/image-utils';
import { layoutTagKeys } from '@/lib/layout-tags';
import { mmToUnit, unitToMm, type LengthUnit } from '@/lib/units';
import type { MaskSlotSource } from './LayoutFabricPreview';
import {
  EMPTY_SLOT, WHOLE_CANVAS, UNIT_PREF_KEY, frameSlotFromData, framesFromData, gridFrames,
  printSheetJson, printSheetStateFrom, pxToMm, readUnitPref, round2,
  type LayoutFrame, type PrintSheetState, type SurfaceEditorState,
} from './layout-form-utils';

export function useLayoutForm() {
  // Form State
  const [isEditMode, setIsEditMode] = useState(false);
  const [layoutName, setLayoutName] = useState('');
  // Layout name (identifier) — independently typed, matching Calendar/Book's
  // editors (2026-09-16). Frozen once a layout exists (`name` is immutable);
  // free-typed on create, same as the other two editors' "Layout name" field.
  const [layoutId, setLayoutId] = useState('untitled_layout');
  // Tag keys (several per layout); names come from the ops-managed list.
  const [tagKeys, setTagKeys] = useState<string[]>([]);

  const [dpi, setDpi] = useState(300);
  const [widthMm, setWidthMm] = useState(101.6);
  const [heightMm, setHeightMm] = useState(152.4);
  // Per-template opt-in for per-frame captions. When on, the customer editor
  // shows a caption box per print area (gated on layout.frameCaptionsEnabled).
  const [frameCaptionsEnabled, setFrameCaptionsEnabled] = useState(false);
  // Whether the layout may be turned to the other orientation when the
  // embedding site asks for one. On unless ops switch it off; captions,
  // overlays and SVG masks keep a layout as authored regardless.
  const [orientationRotatable, setOrientationRotatable] = useState(true);

  // Custom frames
  const [frames, setFrames] = useState<LayoutFrame[]>([]);

  // The frame picture and the print sheet (single-canvas state; a product
  // keeps them per surface). The frame picture sits outside the bleed area
  // and only previews. Artwork belongs to a template, never to a layout.
  const [frameMask, setFrameMask] = useState<MaskSlotSource>(EMPTY_SLOT);
  const [printSheet, setPrintSheet] = useState<PrintSheetState>(WHOLE_CANVAS);
  const frameMaskInputRef = useRef<HTMLInputElement>(null);
  // Set after scanning a freshly-picked mask File for transparency (see
  // hasTransparentPixels) — warns before save, not enforced server-side.
  const [maskWarning, setMaskWarning] = useState<string | undefined>(undefined);

  // Multi-surface state
  const [layoutType, setLayoutType] = useState<'single' | 'product'>('single');
  const [surfaces, setSurfaces] = useState<SurfaceEditorState[]>([]);
  const [activeSurfaceIdx, setActiveSurfaceIdx] = useState(0);
  // Each surface has its own masks — a stale warning from surface A must not
  // linger over surface B's card after switching tabs.
  // Kept as an effect exactly as it was in page.tsx, where the compiler lint
  // did not reach it; changing it is out of scope for a move.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMaskWarning(undefined); }, [activeSurfaceIdx]);

  const [snapGrid, setSnapGrid] = useState(true);
  const [zoom, setZoom] = useState(1);

  // Every length on this page is held and saved in mm; `unit` only changes
  // what the fields show and how typed values are read back.
  const [unit, setUnitState] = useState<LengthUnit>(readUnitPref);
  const setUnit = (next: LengthUnit) => {
    setUnitState(next);
    try { window.localStorage.setItem(UNIT_PREF_KEY, next); } catch { /* preference is optional */ }
  };
  const lengthStep = unit === 'in' ? '0.001' : '0.01';
  // Frame fields keep the raw typed string in mm mode, as before.
  const showLength = (mm: number | string | undefined) => (unit === 'mm' ? (mm ?? 0) : mmToUnit(Number(mm || 0), 'in'));
  const readLength = (raw: string) => (unit === 'mm' || raw === '' ? raw : String(unitToMm(Number(raw), 'in')));

  // Grid generator helper state
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [padding, setPadding] = useState(2); // padding in mm natively
  const [showGridGen, setShowGridGen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Resolve active frames/dimensions based on layout type
  const activeFrames = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].frames : frames;
  const activeWidthMm = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].widthMm : widthMm;
  const activeHeightMm = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].heightMm : heightMm;
  const activeDpi = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].dpi : dpi;
  const activeFrameMask = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].frameMask : frameMask;
  const activePrintSheet = layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].printSheet : printSheet;
  // The preview re-reads the sheet by identity, so give it one object per state change.
  const activePrintSheetJson = useMemo(() => printSheetJson(activePrintSheet), [activePrintSheet]);
  const setActiveFrameMask = (next: MaskSlotSource) => {
    if (layoutType === 'product') {
      setSurfaces(prev => prev.map((p, i) => i === activeSurfaceIdx ? { ...p, frameMask: next } : p));
    } else {
      setFrameMask(next);
    }
  };
  const setActivePrintSheet = (updater: (prev: PrintSheetState) => PrintSheetState) => {
    if (layoutType === 'product') {
      setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, printSheet: updater(s.printSheet) } : s));
    } else {
      setPrintSheet(updater);
    }
  };
  const removeActiveMask = () => {
    setActiveFrameMask(EMPTY_SLOT);
    setMaskWarning(undefined);
    if (frameMaskInputRef.current) frameMaskInputRef.current.value = '';
  };

  const setActiveFrames = useCallback((updater: LayoutFrame[] | ((prev: LayoutFrame[]) => LayoutFrame[])) => {
    if (layoutType === 'product') {
      setSurfaces(prev => prev.map((s, i) => {
        if (i !== activeSurfaceIdx) return s;
        const newFrames = typeof updater === 'function' ? updater(s.frames) : updater;
        return { ...s, frames: newFrames };
      }));
    } else {
      if (typeof updater === 'function') {
        setFrames(updater);
      } else {
        setFrames(updater);
      }
    }
  }, [layoutType, activeSurfaceIdx]);
  const handleGenerateGrid = () => {
    setFrames(gridFrames(widthMm, heightMm, rows, cols, padding));
    setShowGridGen(false);
  };

  /** Fill the form from a saved layout, to edit it. */
  const loadForEdit = (name: string, data: any) => {
    // Prefer the real, ops-curated displayName (2026-09-16); only a layout
    // that predates the field falls back to a mechanical prettification.
    setLayoutName(data.displayName || data.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()));
    setLayoutId(name);
    setTagKeys(layoutTagKeys(data));
    setFrameCaptionsEnabled(Boolean(data.frameCaptionsEnabled));
    setOrientationRotatable(data.orientationRotatable !== false);
    setMaskWarning(undefined);

    // Multi-surface product layout
    if (data.type === 'product' && Array.isArray(data.surfaces)) {
      setLayoutType('product');
      const loadedSurfaces: SurfaceEditorState[] = data.surfaces.map((s: any) => {
        const sDpi = s.canvas?.dpi || 300;
        return {
          key: s.key || 'unknown',
          label: s.label || s.key || 'Unknown',
          widthMm: round2(s.canvas?.widthMm || pxToMm(s.canvas?.width || 0, sDpi)),
          heightMm: round2(s.canvas?.heightMm || pxToMm(s.canvas?.height || 0, sDpi)),
          dpi: sDpi,
          frames: framesFromData(s, s.canvas || {}),
          frameMask: frameSlotFromData(s),
          printSheet: printSheetStateFrom(s.printSheet),
        };
      });
      setSurfaces(loadedSurfaces);
      setActiveSurfaceIdx(0);
      // Also set flat state from first surface as fallback
      if (loadedSurfaces.length > 0) {
        setDpi(loadedSurfaces[0].dpi);
        setWidthMm(loadedSurfaces[0].widthMm);
        setHeightMm(loadedSurfaces[0].heightMm);
        setFrames(loadedSurfaces[0].frames);
      }
    } else {
      // Single-surface layout
      setLayoutType('single');
      setSurfaces([]);
      const displayDpi = data.canvas?.dpi || 300;
      setDpi(displayDpi);
      setWidthMm(round2(data.canvas?.widthMm || pxToMm(data.canvas?.width || 0, displayDpi)));
      setHeightMm(round2(data.canvas?.heightMm || pxToMm(data.canvas?.height || 0, displayDpi)));

      const loadedFrames = framesFromData(data, data.canvas || {});
      if (loadedFrames.length > 0) {
        setFrames(loadedFrames);
      } else if (data.grid) {
        setRows(data.grid.rows || 2);
        setCols(data.grid.cols || 2);
        const paddMm = data.grid.padding ? pxToMm(data.grid.padding, displayDpi) : 2;
        setPadding(paddMm);
        const cW = (data.canvas?.widthMm || pxToMm(data.canvas?.width || 0, displayDpi));
        const cH = (data.canvas?.heightMm || pxToMm(data.canvas?.height || 0, displayDpi));
        const cellW = (cW - (data.grid.cols + 1) * paddMm) / data.grid.cols;
        const cellH = (cH - (data.grid.rows + 1) * paddMm) / data.grid.rows;
        const fallbackFrames: any[] = [];
        for (let r = 0; r < data.grid.rows; r++) {
          for (let c = 0; c < data.grid.cols; c++) {
            fallbackFrames.push({
              id: Math.random().toString(36).slice(2, 11),
              xMm: Number((paddMm + c * (cellW + paddMm)).toFixed(2)),
              yMm: Number((paddMm + r * (cellH + paddMm)).toFixed(2)),
              widthMm: Number(cellW.toFixed(2)),
              heightMm: Number(cellH.toFixed(2)),
              x: 0, y: 0, width: 0, height: 0
            });
          }
        }
        setFrames(fallbackFrames);
      }

      setFrameMask(frameSlotFromData(data));
      setPrintSheet(printSheetStateFrom(data.printSheet));
    }

    setIsEditMode(true);
  };

  /** Fill the form from a saved layout as a new copy of it. */
  const loadForCopy = (name: string, data: any) => {
    setMaskWarning(undefined);
    const displayDpi = data.canvas.dpi || 300;
    setDpi(displayDpi);
    setWidthMm(round2(data.canvas.widthMm || pxToMm(data.canvas.width, displayDpi)));
    setHeightMm(round2(data.canvas.heightMm || pxToMm(data.canvas.height, displayDpi)));
    // Pre-fill from the original's displayName where available, so the
    // copy's seed text reads like a real product name, not a raw slug.
    const copyName = `copy ${(data.displayName || name.replace(/_/g, ' '))}`;
    setLayoutName(copyName);
    // A copy is a brand-new layout — reset the identifier to the same
    // untyped default as Create, rather than colliding with the source.
    setLayoutId('untitled_layout');
    setTagKeys(layoutTagKeys(data));
    if (data.frames) {
      const loadedFrames = data.frames.map((f: any) => ({
        ...f,
        id: Math.random().toString(36).slice(2, 11),
        xMm: round2(f.xMm ?? pxToMm(f.x * data.canvas.width, displayDpi)),
        yMm: round2(f.yMm ?? pxToMm(f.y * data.canvas.height, displayDpi)),
        widthMm: round2(f.widthMm ?? pxToMm(f.width * data.canvas.width, displayDpi)),
        heightMm: round2(f.heightMm ?? pxToMm(f.height * data.canvas.height, displayDpi)),
        bleedMm: round2(Number(f.bleedMm || 0))
      }));
      setFrames(loadedFrames);
    }
    setFrameMask(frameSlotFromData(data));
    setPrintSheet(printSheetStateFrom(data.printSheet));
    setFrameCaptionsEnabled(Boolean(data.frameCaptionsEnabled));
    setOrientationRotatable(data.orientationRotatable !== false);
    setIsEditMode(false); // Treat as new creation so it won't conflict
  };

  // Every way into a new layout starts from the same blank form. The Create card
  // used to reset only part of it and kept the last edited layout's identifier,
  // so saving the "new" layout replaced that one.
  const resetForCreate = () => {
    setIsEditMode(false);
    setLayoutName('');
    setLayoutId('untitled_layout');
    setTagKeys([]);
    setWidthMm(101.6);
    setHeightMm(152.4);
    setDpi(300);
    setFrames([]);
    setFrameMask(EMPTY_SLOT);
    setPrintSheet(WHOLE_CANVAS);
    setMaskWarning(undefined);
    setLayoutType('single');
    setSurfaces([]);
    setActiveSurfaceIdx(0);
    setFrameCaptionsEnabled(false);
    setOrientationRotatable(true);
  };

  // Warn (never block) if a freshly-picked mask PNG has no transparent
  // window — see hasTransparentPixels for why this matters.
  const checkMaskTransparency = (file: File) => {
    setMaskWarning(undefined);
    hasTransparentPixels(file).then(transparent => {
      if (!transparent) setMaskWarning('This mask has no transparent pixels — the photo will be fully covered instead of showing through a window. Add a transparent cutout before saving.');
    });
  };

  const updateFrame = (id: string, field: string, value: string) => {
    const cW = activeWidthMm;
    const cH = activeHeightMm;
    setActiveFrames(prev => prev.map(f => {
      if (f.id !== id) return f;

      const newFrame = { ...f, [field]: value };
      const bleed = round2(Number(newFrame.bleedMm || 0));
      const xVal = Number(newFrame.xMm || 0);
      const yVal = Number(newFrame.yMm || 0);
      const wVal = Number(newFrame.widthMm || 0);
      const hVal = Number(newFrame.heightMm || 0);

      let hasError = false;
      let msg = "";

      if (round2(xVal - bleed) < 0) {
        msg = `Area #${prev.indexOf(f) + 1}: Out of bounds (Left). Move it further right or reduce Bleed.`;
        hasError = true;
      } else if (round2(wVal + (bleed * 2)) > cW) {
        msg = `Area #${prev.indexOf(f) + 1}: Total width (including bleed) exceeds canvas width. Reduce Width or Bleed.`;
        hasError = true;
      } else if (round2(xVal + wVal + bleed) > cW) {
        msg = `Area #${prev.indexOf(f) + 1}: Out of bounds (Right). Move it left or reduce Width/Bleed.`;
        hasError = true;
      } else if (round2(yVal - bleed) < 0) {
        msg = `Area #${prev.indexOf(f) + 1}: Out of bounds (Top). Move it down or reduce Bleed.`;
        hasError = true;
      } else if (round2(hVal + (bleed * 2)) > cH) {
        msg = `Area #${prev.indexOf(f) + 1}: Total height (including bleed) exceeds canvas height. Reduce Height or Bleed.`;
        hasError = true;
      } else if (round2(yVal + hVal + bleed) > cH) {
        msg = `Area #${prev.indexOf(f) + 1}: Out of bounds (Bottom). Move it up or reduce Height/Bleed.`;
        hasError = true;
      }

      if (hasError) {
        setValidationError(msg);
        setTimeout(() => setValidationError(null), 3000);
      }

      return newFrame;
    }));
  };

  const centerFrame = (id: string, axis: 'h' | 'v') => {
    const cW = activeWidthMm;
    const cH = activeHeightMm;
    setActiveFrames(prev => prev.map(f => {
      if (f.id !== id) return f;
      const w = Number(f.widthMm || 0);
      const h = Number(f.heightMm || 0);

      if (axis === 'h') {
        return { ...f, xMm: round2((cW - w) / 2) };
      } else {
        return { ...f, yMm: round2((cH - h) / 2) };
      }
    }));
  };

  return {
    isEditMode,
    setIsEditMode,
    layoutName,
    setLayoutName,
    layoutId,
    setLayoutId,
    tagKeys,
    setTagKeys,
    dpi,
    setDpi,
    widthMm,
    setWidthMm,
    heightMm,
    setHeightMm,
    frameCaptionsEnabled,
    setFrameCaptionsEnabled,
    orientationRotatable,
    setOrientationRotatable,
    frames,
    setFrames,
    frameMask,
    setFrameMask,
    printSheet,
    setPrintSheet,
    frameMaskInputRef,
    maskWarning,
    setMaskWarning,
    layoutType,
    setLayoutType,
    surfaces,
    setSurfaces,
    activeSurfaceIdx,
    setActiveSurfaceIdx,
    snapGrid,
    setSnapGrid,
    zoom,
    setZoom,
    unit,
    setUnit,
    lengthStep,
    showLength,
    readLength,
    rows,
    setRows,
    cols,
    setCols,
    padding,
    setPadding,
    showGridGen,
    setShowGridGen,
    validationError,
    setValidationError,
    activeFrames,
    activeWidthMm,
    activeHeightMm,
    activeDpi,
    activeFrameMask,
    activePrintSheet,
    activePrintSheetJson,
    setActiveFrameMask,
    setActivePrintSheet,
    removeActiveMask,
    setActiveFrames,
    handleGenerateGrid,
    loadForEdit,
    loadForCopy,
    resetForCreate,
    checkMaskTransparency,
    updateFrame,
    centerFrame,
  };
}
