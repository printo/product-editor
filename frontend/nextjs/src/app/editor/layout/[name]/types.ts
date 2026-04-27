import type { SurfaceDefinition } from '@/lib/layout-utils';

export type FitMode = 'contain' | 'cover';

export interface FrameState {
  id: number;
  originalFile: File | null;
  /** UUID assigned when the File is first persisted to IndexedDB so the blob
   *  can be recovered after a page refresh. Persists in canvas_state JSON. */
  fileId?: string;
  offset: { x: number; y: number };
  scale: number;
  rotation: number; // 0, 90, 180, 270
  fitMode: FitMode;
}

export interface TextOverlay {
  id: string | number;
  text: string;
  x: number;      // percentage 0–100 from left
  y: number;      // percentage 0–100 from top
  fontSize: number; // px relative to canvas height
  color: string;
  fontFamily: string;
  textAlign: CanvasTextAlign;
  rotation: number; // degrees
}

export interface ShapeOverlay {
  id: string | number;
  shapeType: string;
  svgPath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface ImageOverlay {
  id: string | number;
  src: string;
  originalFile?: File;
  /** UUID for IndexedDB blob recovery (only set for `source === 'local'`). */
  fileId?: string;
  source: 'clipart' | 'icon' | 'local';
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
}

export type Overlay =
  | ({ type: 'text' } & TextOverlay)
  | ({ type: 'shape' } & ShapeOverlay)
  | ({ type: 'image' } & ImageOverlay);

export interface CanvasItem {
  id: number;
  frames: FrameState[];
  overlays: Overlay[];
  bgColor: string;    // bottom background layer colour (shows inside frame holes), default '#ffffff'
  paperColor: string; // mat / border overlay colour (the paper around frames), default '#ffffff'
  dataUrl: string | null;
}

export interface ImpositionSettings {
  preset: 'a4' | 'a3' | '12x18' | '13x19' | 'custom';
  widthIn: number;
  heightIn: number;
  marginMm: number;
  gutterMm: number;
  orientation: 'portrait' | 'landscape';
}

export interface PlacedItem {
  canvasIdx: number;
  x: number; y: number; w: number; h: number; rotated: boolean;
}

export interface SheetLayout { items: PlacedItem[] }

export interface SurfaceState {
  key: string;
  label: string;
  def: SurfaceDefinition;
  files: File[];
  canvases: CanvasItem[];
  globalFitMode: FitMode;
}
