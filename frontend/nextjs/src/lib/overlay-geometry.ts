/**
 * Reading an overlay's box back out of the Fabric object the customer just
 * moved, scaled or resized (FabricEditor's `object:modified` handler), and
 * the inverse: the scale to put on an existing object so it shows a box.
 *
 * `createShapeFromOverlay` (lib/fabric-utils.ts) gives each shape a
 * different Fabric representation, and each has to be inverted its own way:
 *
 *   rect / triangle       left/top is the box's top-left; width/height are
 *                         the box, times any corner-handle scale
 *   circle / ellipse      left/top is the box's CENTRE (originX/Y 'center');
 *                         Fabric's width/height are the diameter(s)
 *   catalogue polygon     width/height are the points' bounding box, which
 *                         is smaller than the overlay box for a hexagon or
 *                         pentagon (7–93%), so the box is read back through
 *                         that fraction
 *   path (everything else) drawn at scale (box / 100), so the box IS the
 *                         scale
 *
 * Until 2026-10-13 the handler read every shape as `x = left, width =
 * width * scaleX`: a circle jumped by half its size on every move, and a
 * star or hexagon shrank a little each time it was touched.
 */

import { getShapeDef } from '@/lib/shape-catalog';

export interface ModifiedObjectGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

export interface OverlayBox {
  x: number;      // % of canvas width
  y: number;      // % of canvas height
  width: number;  // % of canvas width
  height: number; // % of canvas height
}

const pct1 = (v: number) => Math.round(v * 10) / 10;

/** Fraction of the overlay box that a catalogue polygon's points span (1 for a path/rect). */
export function polygonBoxFraction(shapeType: string): { w: number; h: number } {
  const def = getShapeDef(shapeType);
  if (def?.fabricType !== 'polygon' || !def.polygonPoints?.length) return { w: 1, h: 1 };
  const xs = def.polygonPoints.map(p => p.x);
  const ys = def.polygonPoints.map(p => p.y);
  return {
    w: (Math.max(...xs) - Math.min(...xs)) / 100,
    h: (Math.max(...ys) - Math.min(...ys)) / 100,
  };
}

/** How `createShapeFromOverlay` represents a shape, which decides how to read it back. */
export function shapeRepresentation(shapeType: string): 'box' | 'centered' | 'polygon' | 'path' {
  const def = getShapeDef(shapeType);
  switch (def?.fabricType) {
    case 'rect':
    case 'triangle':
      return 'box';
    case 'circle':
    case 'ellipse':
      return 'centered';
    case 'polygon':
      return def.polygonPoints?.length ? 'polygon' : 'path';
    default:
      return 'path';
  }
}

/** The overlay box (percent) a modified Fabric shape object now occupies. */
export function shapeBoxFromObject(
  g: ModifiedObjectGeometry,
  shapeType: string,
  canvasW: number,
  canvasH: number,
): OverlayBox {
  const rep = shapeRepresentation(shapeType);
  let wPx = g.width * g.scaleX;
  let hPx = g.height * g.scaleY;
  let leftPx = g.left;
  let topPx = g.top;

  if (rep === 'path') {
    wPx = g.scaleX * 100;
    hPx = g.scaleY * 100;
  } else if (rep === 'polygon') {
    const frac = polygonBoxFraction(shapeType);
    wPx = (g.width * g.scaleX) / frac.w;
    hPx = (g.height * g.scaleY) / frac.h;
  } else if (rep === 'centered') {
    leftPx = g.left - wPx / 2;
    topPx = g.top - hPx / 2;
  }

  return {
    x: pct1((leftPx / canvasW) * 100),
    y: pct1((topPx / canvasH) * 100),
    width: pct1((wPx / canvasW) * 100),
    height: pct1((hPx / canvasH) * 100),
  };
}

/**
 * The scale to set on an existing path or polygon object so it fills a box
 * of (boxWpx, boxHpx). A path is scaled from its 100-unit space; a polygon
 * from its current (unscaled) point bounds.
 */
export function shapeScaleForBox(
  shapeType: string,
  unscaledWidth: number,
  unscaledHeight: number,
  boxWpx: number,
  boxHpx: number,
): { scaleX: number; scaleY: number } {
  const rep = shapeRepresentation(shapeType);
  if (rep === 'path') return { scaleX: boxWpx / 100, scaleY: boxHpx / 100 };
  if (rep === 'polygon') {
    const frac = polygonBoxFraction(shapeType);
    return {
      scaleX: (boxWpx * frac.w) / (unscaledWidth || 1),
      scaleY: (boxHpx * frac.h) / (unscaledHeight || 1),
    };
  }
  return { scaleX: 1, scaleY: 1 };
}

/**
 * The text overlay fields a modified Textbox now has. A corner-handle drag
 * scales the object rather than changing fontSize, so the scale is folded
 * into fontSize and the box width and the object is expected to be reset to
 * scale 1 (the in-place update does that).
 */
export function textBoxFromObject(
  g: ModifiedObjectGeometry & { fontSize: number },
  canvasW: number,
  canvasH: number,
): { x: number; y: number; width: number; fontSize: number } {
  const scale = g.scaleX || 1;
  return {
    x: pct1((g.left / canvasW) * 100),
    y: pct1((g.top / canvasH) * 100),
    width: pct1(((g.width * scale) / canvasW) * 100),
    fontSize: Math.max(1, Math.round(g.fontSize * scale)),
  };
}
