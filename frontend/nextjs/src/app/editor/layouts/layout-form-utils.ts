/**
 * The ops layout editor's form: its types and the pure helpers that read a
 * saved layout into the form, check it, and build the save request.
 * Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 1).
 */
import { mmToPx as mmToPxExact, pxToMm as pxToMmExact, type LengthUnit } from '@/lib/units';
import { resolveMaskSlots } from '@/lib/mask-slots';
import { readPrintSheet, type PrintSheet, type PrintSheetMode } from '@/lib/print-sheet';
import type { MaskSlotSource } from './LayoutFabricPreview';

export interface LayoutFrame {
  id?: string;
  x: number; // percentage (Area + Bleed)
  y: number; // percentage (Area + Bleed)
  width: number; // percentage (Area + Bleed)
  height: number; // percentage (Area + Bleed)
  xMm?: number | string; // Print Area X
  yMm?: number | string; // Print Area Y
  widthMm?: number | string; // Print Area Width
  heightMm?: number | string; // Print Area Height
  bleedMm?: number | string; // Margin for Bleed
  borderRadiusMm?: number | string; // Corner Radius
  caption?: string; // Default caption text (customer can override in the editor)
  captionEnabled?: boolean; // Show this area's caption in the output
  // Free caption placement/style (canvas-absolute mm). Unset → legacy bottom-centre.
  captionXMm?: number | string;
  captionYMm?: number | string;
  captionWidthMm?: number | string;
  captionFontMm?: number | string;
  captionAlign?: 'left' | 'center' | 'right';
  captionColor?: string;
}

export interface LayoutConfig {
  name: string;
  canvas: {
    width: number;
    height: number;
    widthMm?: number;
    heightMm?: number;
    dpi?: number;
  };
  productType?: string;
  grid?: {
    rows: number;
    cols: number;
    padding: number;
  };
  frames?: LayoutFrame[];
  tags?: string[];
  tagKeys?: string[];
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
  version?: number;
  metadata?: {
    key: string;
    label: string;
    value: any;
  }[];
  /** Derived legacy pair, still served for one release; the slots below are what is stored. */
  maskUrl?: string;
  maskOnExport?: boolean;
  frameMaskUrl?: string | null;
  printSheet?: PrintSheet;
  frameCaptionsEnabled?: boolean;
  orientationRotatable?: boolean;
}

/** The "Print file" choice as the form holds it. */
export interface PrintSheetState {
  mode: PrintSheetMode;
}

export interface SurfaceEditorState {
  key: string;
  label: string;
  widthMm: number;
  heightMm: number;
  dpi: number;
  frames: LayoutFrame[];
  frameMask: MaskSlotSource;
  printSheet: PrintSheetState;
}

// Template authoring works in whole pixels and 2-dp millimetres, so these
// round the shared conversions. Module scope keeps them stable across renders.
export const round2 = (val: number) => Math.round((val + Number.EPSILON) * 100) / 100;
export const mmToPx = (mm: number, dpiVal: number) => Math.round(mmToPxExact(mm, dpiVal));
export const pxToMm = (px: number, dpiVal: number) => round2(pxToMmExact(px, dpiVal));

// The display unit is a per-viewer preference; storage can be blocked
// (privacy modes), in which case the page simply starts in millimetres.
export const UNIT_PREF_KEY = 'pe:layout-editor:unit';
export const readUnitPref = (): LengthUnit => {
  if (typeof window === 'undefined') return 'mm';
  try {
    return window.localStorage.getItem(UNIT_PREF_KEY) === 'in' ? 'in' : 'mm';
  } catch {
    return 'mm';
  }
};

/** A random id for a new print area. */
export const newFrameId = () => Math.random().toString(36).slice(2, 11);

/** Print areas as saved: mm rounded to 2 dp, plus the area+bleed box as fractions of the canvas. */
export const mapFramesForSave = (frameList: LayoutFrame[], wMmVal: number, hMmVal: number, dpiVal: number) => {
  const canvasW = mmToPx(wMmVal, dpiVal);
  const canvasH = mmToPx(hMmVal, dpiVal);
  return frameList.map(f => {
    const bleed = round2(Number(f.bleedMm || 0));
    const xMm = round2(Number(f.xMm || 0));
    const yMm = round2(Number(f.yMm || 0));
    const wMm = round2(Number(f.widthMm || 0));
    const hMm = round2(Number(f.heightMm || 0));
    const radiusMm = round2(Number(f.borderRadiusMm || 0));
    const pxX = mmToPx(xMm - bleed, dpiVal);
    const pxY = mmToPx(yMm - bleed, dpiVal);
    const pxW = mmToPx(wMm + (bleed * 2), dpiVal);
    const pxH = mmToPx(hMm + (bleed * 2), dpiVal);
    return {
      ...f,
      xMm, yMm, widthMm: wMm, heightMm: hMm, bleedMm: bleed, borderRadiusMm: radiusMm,
      x: pxX / canvasW,
      y: pxY / canvasH,
      width: pxW / canvasW,
      height: pxH / canvasH,
    };
  });
};

/** A saved block's print areas in form shape (mm, fresh ids); a frame without mm is read from its fractions. */
export const framesFromData = (data: any, canvas: any): LayoutFrame[] => {
  const displayDpi = canvas.dpi || 300;
  if (data.frames) {
    return data.frames.map((f: any) => ({
      ...f,
      id: newFrameId(),
      xMm: round2(f.xMm ?? pxToMm(f.x * canvas.width, displayDpi)),
      yMm: round2(f.yMm ?? pxToMm(f.y * canvas.height, displayDpi)),
      widthMm: round2(f.widthMm ?? pxToMm(f.width * canvas.width, displayDpi)),
      heightMm: round2(f.heightMm ?? pxToMm(f.height * canvas.height, displayDpi)),
      bleedMm: round2(Number(f.bleedMm || 0))
    }));
  }
  return [];
};

/** The grid generator: rows × cols equal print areas with `padding` mm around and between them. */
export const gridFrames = (widthMm: number, heightMm: number, rows: number, cols: number, padding: number): LayoutFrame[] => {
  const newFrames: LayoutFrame[] = [];
  const cellW = (widthMm - (cols + 1) * padding) / cols;
  const cellH = (heightMm - (rows + 1) * padding) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = padding + c * (cellW + padding);
      const y = padding + r * (cellH + padding);
      newFrames.push({
        id: newFrameId(),
        xMm: round2(x),
        yMm: round2(y),
        widthMm: round2(cellW),
        heightMm: round2(cellH),
        bleedMm: 0,
        x: 0, y: 0, width: 0, height: 0
      });
    }
  }
  return newFrames;
};

/** True when any print area, with its bleed, leaves its canvas. */
export const framesOutOfBounds = (framesToCheck: Array<{ f: LayoutFrame; w: number; h: number }>): boolean =>
  framesToCheck.some(({ f, w, h }) => {
    const bleed = round2(Number(f.bleedMm || 0));
    const xVal = Number(f.xMm || 0);
    const yVal = Number(f.yMm || 0);
    const wVal = Number(f.widthMm || 0);
    const hVal = Number(f.heightMm || 0);
    return (
      round2(xVal - bleed) < 0 ||
      round2(wVal + (bleed * 2)) > w ||
      round2(xVal + wVal + bleed) > w ||
      round2(yVal - bleed) < 0 ||
      round2(hVal + (bleed * 2)) > h ||
      round2(yVal + hVal + bleed) > h
    );
  });

export const EMPTY_SLOT: MaskSlotSource = { url: null, file: null };
export const WHOLE_CANVAS: PrintSheetState = { mode: 'canvas' };

/** One slot from a saved layout (or surface), reading a legacy mask into the right slot. */
export const frameSlotFromData = (block: unknown): MaskSlotSource => ({
  url: resolveMaskSlots(block).frameMaskUrl,
  file: null,
});

export const printSheetStateFrom = (raw: unknown): PrintSheetState => ({ mode: readPrintSheet(raw).mode });

export const printSheetJson = (s: PrintSheetState): PrintSheet => ({ mode: s.mode });

/** Everything the save needs from the form. */
export interface LayoutFormState {
  layoutId: string;
  layoutName: string;
  layoutType: 'single' | 'product';
  tagKeys: string[];
  frameCaptionsEnabled: boolean;
  orientationRotatable: boolean;
  surfaces: SurfaceEditorState[];
  widthMm: number;
  heightMm: number;
  dpi: number;
  frames: LayoutFrame[];
  frameMask: MaskSlotSource;
  printSheet: PrintSheetState;
}

/** The multipart body of POST ops/layouts: mask files first, then name, display_name and the layout JSON. */
export const buildLayoutFormData = (s: LayoutFormState): FormData => {
  let layoutData: any;
  const formData = new FormData();

  if (s.layoutType === 'product') {
    // Multi-surface product layout
    const surfacesData = s.surfaces.map(sf => ({
      key: sf.key,
      label: sf.label,
      canvas: {
        width: mmToPx(sf.widthMm, sf.dpi),
        height: mmToPx(sf.heightMm, sf.dpi),
        widthMm: round2(sf.widthMm),
        heightMm: round2(sf.heightMm),
        dpi: sf.dpi,
      },
      frames: mapFramesForSave(sf.frames, sf.widthMm, sf.heightMm, sf.dpi),
      frameMaskUrl: sf.frameMask.url || null,
      printSheet: printSheetJson(sf.printSheet),
    }));

    layoutData = {
      name: s.layoutId,
      type: 'product',
      tagKeys: s.tagKeys,
      frameCaptionsEnabled: s.frameCaptionsEnabled,
      orientationRotatable: s.orientationRotatable,
      surfaces: surfacesData,
    };

    // Append per-surface mask files, one field per slot
    s.surfaces.forEach(sf => {
      if (sf.frameMask.file) formData.append(`frame_mask_${sf.key}`, sf.frameMask.file);
    });
  } else {
    // Single-surface layout (existing format)
    const canvasW = mmToPx(s.widthMm, s.dpi);
    const canvasH = mmToPx(s.heightMm, s.dpi);

    layoutData = {
      name: s.layoutId,
      tagKeys: s.tagKeys,
      canvas: {
        width: canvasW,
        height: canvasH,
        widthMm: round2(s.widthMm),
        heightMm: round2(s.heightMm),
        dpi: s.dpi,
      },
      frames: mapFramesForSave(s.frames, s.widthMm, s.heightMm, s.dpi),
      frameMaskUrl: s.frameMask.url || null,
      printSheet: printSheetJson(s.printSheet),
      frameCaptionsEnabled: s.frameCaptionsEnabled,
      orientationRotatable: s.orientationRotatable,
    };

    if (s.frameMask.file) formData.append('frame_mask', s.frameMask.file);
  }

  formData.append('name', s.layoutId);
  // The dedicated, ops-editable customer-facing name (2026-09-16) — layoutId
  // above is frozen once a layout exists, so this is the only thing editing
  // an existing layout can still change about how it's identified to a human.
  formData.append('display_name', s.layoutName.trim());
  formData.append('layout', JSON.stringify(layoutData));
  return formData;
};
