/**
 * Layout normalization utilities.
 *
 * Converts both legacy flat layouts (canvas/frames at root) and
 * multi-surface product layouts (surfaces[]) into a unified
 * NormalizedLayout shape so every consumer works with one type.
 */

import { resolveMaskSlots } from './mask-slots';
import { readPrintSheet, type PrintSheet } from './print-sheet';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CanvasSpec {
  width: number;
  height: number;
  widthMm?: number;
  heightMm?: number;
  dpi?: number;
}

export interface FrameSpec {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xMm?: number;
  yMm?: number;
  widthMm?: number;
  heightMm?: number;
  bleedMm?: number;
}

export interface SurfaceDefinition {
  key: string;
  label: string;
  canvas: CanvasSpec;
  frames: FrameSpec[];
  /** Derived legacy pair, kept for one release; read the slots below instead. */
  maskUrl: string | null;
  maskOnExport: boolean;
  /** Outside the bleed area: every preview and the mock, never the print. */
  frameMaskUrl: string | null;
  /** Inside the bleed area: previews, the mock and the print. */
  artworkMaskUrl: string | null;
  /** What the print file is: the whole canvas, or the bleed area. */
  printSheet: PrintSheet;
}

export interface NormalizedLayout {
  name: string;
  type: 'single' | 'product';
  surfaces: SurfaceDefinition[];
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string;
  updatedBy: string;
  metadata: any[];
  /** Pass-through of the raw layout for fields we don't normalize */
  _raw: any;
}

// ─── Normalize ───────────────────────────────────────────────────────────────

export function normalizeLayout(raw: any): NormalizedLayout {
  if (!raw) {
    return {
      name: '',
      type: 'single',
      surfaces: [],
      tags: [],
      createdAt: null,
      updatedAt: null,
      createdBy: '',
      updatedBy: '',
      metadata: [],
      _raw: raw,
    };
  }

  const isProduct = raw.type === 'product' && Array.isArray(raw.surfaces);

  const surfaces: SurfaceDefinition[] = isProduct
    ? raw.surfaces.map((s: any) => ({
        key: s.key || 'unknown',
        label: s.label || s.key || 'Unknown',
        canvas: s.canvas || { width: 0, height: 0 },
        frames: s.frames || [],
        maskUrl: s.maskUrl ?? null,
        maskOnExport: s.maskOnExport ?? false,
        ...resolveMaskSlots(s),
        printSheet: readPrintSheet(s.printSheet),
      }))
    : [
        {
          key: 'default',
          label: 'Canvas',
          canvas: raw.canvas || { width: 0, height: 0 },
          frames: raw.frames || [],
          maskUrl: raw.maskUrl ?? null,
          maskOnExport: raw.maskOnExport ?? false,
          ...resolveMaskSlots(raw),
          printSheet: readPrintSheet(raw.printSheet),
        },
      ];

  return {
    name: raw.name || '',
    type: isProduct ? 'product' : 'single',
    surfaces,
    tags: raw.tags || [],
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    createdBy: raw.createdBy || '',
    updatedBy: raw.updatedBy || '',
    metadata: raw.metadata || [],
    _raw: raw,
  };
}

// ─── Discriminated helpers (no `as any`) ────────────────────────────────────

/**
 * Get canvas dimensions from either layout shape:
 * - Single-canvas: `layoutDef.canvas`
 * - Multi-surface: `layoutDef.surfaces[0].canvas`
 */
export function getCanvasSpec(layoutDef: any): CanvasSpec | null {
  if (!layoutDef) return null;

  // Try single-canvas shape first
  if (layoutDef.canvas?.width) {
    return layoutDef.canvas;
  }

  // Fall back to multi-surface shape
  if (Array.isArray(layoutDef.surfaces) && layoutDef.surfaces[0]?.canvas) {
    return layoutDef.surfaces[0].canvas;
  }

  return null;
}

/**
 * Get frames from either layout shape:
 * - Single-canvas: `layoutDef.frames`
 * - Multi-surface: `layoutDef.surfaces[0].frames`
 */
export function getFrames(layoutDef: any): FrameSpec[] {
  if (!layoutDef) return [];

  // Try single-canvas shape first
  if (layoutDef.canvas?.width && Array.isArray(layoutDef.frames)) {
    return layoutDef.frames;
  }

  // Fall back to multi-surface shape
  if (Array.isArray(layoutDef.surfaces) && layoutDef.surfaces[0]?.frames) {
    return layoutDef.surfaces[0].frames;
  }

  return [];
}

// ─── Filter surfaces by key ──────────────────────────────────────────────────

export function filterSurfaces(
  layout: NormalizedLayout,
  keys: string[],
): NormalizedLayout {
  if (!keys.length) return layout;
  const lowerKeys = keys.map((k) => k.toLowerCase());
  return {
    ...layout,
    surfaces: layout.surfaces.filter((s) =>
      lowerKeys.includes(s.key.toLowerCase()),
    ),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a layout has multiple surfaces */
export function isMultiSurface(layout: NormalizedLayout): boolean {
  return layout.type === 'product' && layout.surfaces.length > 1;
}
