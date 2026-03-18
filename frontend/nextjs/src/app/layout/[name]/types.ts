import type { SurfaceDefinition } from '@/lib/layout-utils';

export type FitMode = 'contain' | 'cover';

export interface FrameState {
  id: number;
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
  id: number;
  text: string;
  x: number;      // percentage 0–100 from left
  y: number;      // percentage 0–100 from top
  fontSize: number; // px relative to canvas height (default ~4% of height)
  color: string;
  fontFamily: string;
  textAlign: CanvasTextAlign;
}

export interface ShapeOverlay {
  id: number;
  shapeType: string;       // 'rect' | 'circle' | 'star' | 'heart' | etc.
  svgPath?: string;        // custom SVG path d attribute (viewBox 0 0 100 100)
  x: number;               // percentage 0-100
  y: number;               // percentage 0-100
  width: number;           // percentage of canvas width
  height: number;          // percentage of canvas height
  rotation: number;        // degrees
  fill: string;            // hex color
  stroke: string;          // hex color
  strokeWidth: number;
  opacity: number;         // 0-1
}

export interface ImageOverlay {
  id: number;
  src: string;            // URL of the clipart/icon image (SVG or PNG)
  source: 'clipart' | 'icon'; // where it came from
  label: string;          // display name
  x: number;              // percentage 0-100
  y: number;              // percentage 0-100
  width: number;          // percentage of canvas width
  height: number;         // percentage of canvas height
  rotation: number;       // degrees
  opacity: number;        // 0-1
}

export interface CanvasItem {
  id: number;
  frames: FrameState[];
  textOverlays: TextOverlay[];
  shapeOverlays: ShapeOverlay[];
  imageOverlays: ImageOverlay[];
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
