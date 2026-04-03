/**
 * Layout normalization utilities.
 *
 * Converts both legacy flat layouts (canvas/frames at root) and
 * multi-surface product layouts (surfaces[]) into a unified
 * NormalizedLayout shape so every consumer works with one type.
 */

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
  maskUrl: string | null;
  maskOnExport: boolean;
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
      }))
    : [
        {
          key: 'default',
          label: 'Canvas',
          canvas: raw.canvas || { width: 0, height: 0 },
          frames: raw.frames || [],
          maskUrl: raw.maskUrl ?? null,
          maskOnExport: raw.maskOnExport ?? false,
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

// ─── Denormalize (for saving) ────────────────────────────────────────────────

export function denormalizeLayout(normalized: NormalizedLayout): any {
  const base: any = {
    name: normalized.name,
    tags: normalized.tags,
    createdAt: normalized.createdAt,
    createdBy: normalized.createdBy,
    updatedAt: normalized.updatedAt,
    updatedBy: normalized.updatedBy,
    metadata: normalized.metadata,
  };

  if (normalized.type === 'single' && normalized.surfaces.length <= 1) {
    // Flat format — backward compatible
    const surface = normalized.surfaces[0];
    if (surface) {
      base.canvas = surface.canvas;
      base.frames = surface.frames;
      base.maskUrl = surface.maskUrl;
      base.maskOnExport = surface.maskOnExport;
    }
  } else {
    // Multi-surface format
    base.type = 'product';
    base.surfaces = normalized.surfaces.map((s) => ({
      key: s.key,
      label: s.label,
      canvas: s.canvas,
      frames: s.frames,
      maskUrl: s.maskUrl,
      maskOnExport: s.maskOnExport,
    }));
  }

  return base;
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

/** Get surface by key, or first surface as fallback */
export function getSurface(
  layout: NormalizedLayout,
  key?: string,
): SurfaceDefinition | undefined {
  if (key) {
    return layout.surfaces.find((s) => s.key === key) || layout.surfaces[0];
  }
  return layout.surfaces[0];
}
