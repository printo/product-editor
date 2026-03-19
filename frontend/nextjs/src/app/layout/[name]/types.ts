import type { SurfaceDefinition } from '@/lib/layout-utils';

export type FitMode = 'contain' | 'cover';

export interface FrameState {
  id: string | number;
  originalFile: File;
  processedUrl: string | null;
  offset: { x: number; y: number };
  scale: number;
  rotation: number; // 0, 90, 180, 270
  fitMode: FitMode;
  isRemovingBg: boolean;
  isDetectingProduct: boolean;
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
  bgColor: string; // canvas background color, default '#ffffff'
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
