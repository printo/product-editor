export interface ShapeDef {
  key: string;
  label: string;
  svgPath: string;       // path d attribute in a 0 0 100 100 viewBox
  category: 'basic' | 'arrows' | 'decorative';
  /** If set, FabricEditor uses native Fabric class instead of Path */
  fabricType?: 'rect' | 'circle' | 'ellipse' | 'triangle' | 'polygon';
  /** Points for polygon fabricType (normalized 0–100 coordinate space) */
  polygonPoints?: Array<{ x: number; y: number }>;
}

export const SHAPE_CATALOG: ShapeDef[] = [
  // ── Basic ──────────────────────────────────────────────────────────────────
  {
    key: 'rect',
    label: 'Rectangle',
    svgPath: 'M 5 5 H 95 V 95 H 5 Z',
    category: 'basic',
    fabricType: 'rect',
  },
  {
    key: 'rounded-rect',
    label: 'Rounded Rectangle',
    svgPath: 'M 15 5 H 85 Q 95 5 95 15 V 85 Q 95 95 85 95 H 15 Q 5 95 5 85 V 15 Q 5 5 15 5 Z',
    category: 'basic',
    fabricType: 'rect', // uses rx/ry for rounding
  },
  {
    key: 'circle',
    label: 'Circle',
    svgPath: 'M 50 5 A 45 45 0 1 1 50 95 A 45 45 0 1 1 50 5 Z',
    category: 'basic',
    fabricType: 'circle',
  },
  {
    key: 'ellipse',
    label: 'Ellipse',
    svgPath: 'M 50 15 A 45 35 0 1 1 50 85 A 45 35 0 1 1 50 15 Z',
    category: 'basic',
    fabricType: 'ellipse',
  },
  {
    key: 'triangle',
    label: 'Triangle',
    svgPath: 'M 50 5 L 95 95 L 5 95 Z',
    category: 'basic',
    fabricType: 'triangle',
  },
  {
    key: 'diamond',
    label: 'Diamond',
    svgPath: 'M 50 5 L 95 50 L 50 95 L 5 50 Z',
    category: 'basic',
    fabricType: 'polygon',
    polygonPoints: [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }],
  },
  {
    key: 'hexagon',
    label: 'Hexagon',
    svgPath: 'M 50 5 L 93 27.5 L 93 72.5 L 50 95 L 7 72.5 L 7 27.5 Z',
    category: 'basic',
    fabricType: 'polygon',
    polygonPoints: [{ x: 50, y: 0 }, { x: 93, y: 25 }, { x: 93, y: 75 }, { x: 50, y: 100 }, { x: 7, y: 75 }, { x: 7, y: 25 }],
  },
  {
    key: 'pentagon',
    label: 'Pentagon',
    svgPath: 'M 50 5 L 97 38 L 79 95 L 21 95 L 3 38 Z',
    category: 'basic',
    fabricType: 'polygon',
    polygonPoints: [{ x: 50, y: 0 }, { x: 100, y: 35 }, { x: 81, y: 100 }, { x: 19, y: 100 }, { x: 0, y: 35 }],
  },

  // ── Arrows ─────────────────────────────────────────────────────────────────
  {
    key: 'arrow-right',
    label: 'Arrow Right',
    svgPath: 'M 5 35 H 60 V 15 L 95 50 L 60 85 V 65 H 5 Z',
    category: 'arrows',
  },
  {
    key: 'arrow-left',
    label: 'Arrow Left',
    svgPath: 'M 95 35 H 40 V 15 L 5 50 L 40 85 V 65 H 95 Z',
    category: 'arrows',
  },
  {
    key: 'arrow-up',
    label: 'Arrow Up',
    svgPath: 'M 35 95 V 40 H 15 L 50 5 L 85 40 H 65 V 95 Z',
    category: 'arrows',
  },
  {
    key: 'arrow-down',
    label: 'Arrow Down',
    svgPath: 'M 35 5 V 60 H 15 L 50 95 L 85 60 H 65 V 5 Z',
    category: 'arrows',
  },
  {
    key: 'chevron-right',
    label: 'Chevron Right',
    svgPath: 'M 25 5 L 75 50 L 25 95 L 15 85 L 55 50 L 15 15 Z',
    category: 'arrows',
  },

  // ── Decorative ─────────────────────────────────────────────────────────────
  {
    key: 'star',
    label: 'Star',
    svgPath: 'M 50 5 L 61 38 L 97 38 L 68 60 L 79 93 L 50 72 L 21 93 L 32 60 L 3 38 L 39 38 Z',
    category: 'decorative',
  },
  {
    key: 'heart',
    label: 'Heart',
    svgPath: 'M 50 88 C 20 65 5 50 5 33 C 5 18 17 8 30 8 C 38 8 46 13 50 20 C 54 13 62 8 70 8 C 83 8 95 18 95 33 C 95 50 80 65 50 88 Z',
    category: 'decorative',
  },
  {
    key: 'cross',
    label: 'Cross',
    svgPath: 'M 35 5 H 65 V 35 H 95 V 65 H 65 V 95 H 35 V 65 H 5 V 35 H 35 Z',
    category: 'decorative',
  },
  {
    key: 'plus',
    label: 'Plus',
    svgPath: 'M 40 10 H 60 V 40 H 90 V 60 H 60 V 90 H 40 V 60 H 10 V 40 H 40 Z',
    category: 'decorative',
  },
  {
    key: 'badge',
    label: 'Badge',
    svgPath: 'M 50 5 L 62 15 L 78 10 L 80 27 L 95 37 L 88 52 L 95 67 L 80 77 L 78 94 L 62 89 L 50 99 L 38 89 L 22 94 L 20 77 L 5 67 L 12 52 L 5 37 L 20 27 L 22 10 L 38 15 Z',
    category: 'decorative',
  },
  {
    key: 'speech-bubble',
    label: 'Speech Bubble',
    svgPath: 'M 15 10 H 85 Q 95 10 95 20 V 60 Q 95 70 85 70 H 40 L 20 90 L 25 70 H 15 Q 5 70 5 60 V 20 Q 5 10 15 10 Z',
    category: 'decorative',
  },
  {
    key: 'cloud',
    label: 'Cloud',
    svgPath: 'M 25 80 C 10 80 5 68 10 58 C 5 48 12 38 24 38 C 24 22 40 15 52 22 C 58 12 75 10 82 22 C 95 22 100 35 92 48 C 100 58 95 72 82 75 C 80 82 65 85 55 80 Z',
    category: 'decorative',
  },
];

/** Get SVG path for a given shape key, or fallback to rect */
export function getShapePath(shapeType: string, svgPath?: string): string {
  if (svgPath) return svgPath;
  const def = SHAPE_CATALOG.find(s => s.key === shapeType);
  return def?.svgPath ?? SHAPE_CATALOG[0].svgPath;
}

/** Get shape definition for a given key */
export function getShapeDef(shapeType: string): ShapeDef | undefined {
  return SHAPE_CATALOG.find(s => s.key === shapeType);
}

