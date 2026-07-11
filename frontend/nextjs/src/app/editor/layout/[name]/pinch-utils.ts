/**
 * Pure pinch-gesture math for the canvas editor (Phase 3 — mobile).
 * Kept DOM-free so the arithmetic is unit-testable.
 */

export interface Point { x: number; y: number }

export const PINCH_MIN_SCALE = 0.2;
export const PINCH_MAX_SCALE = 5;

export function pointerDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointerMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface PinchStart {
  distance: number;
  midpoint: Point;
  frameScale: number;
  frameOffset: Point;
}

export interface PinchResult {
  scale: number;
  x: number;
  y: number;
}

/**
 * Map the current two-finger state onto a frame transform:
 *   - scale multiplies by the finger-distance ratio (clamped);
 *   - the midpoint drag pans the photo, converted from screen px into
 *     canvas px by the editor's view zoom.
 */
export function computePinch(
  start: PinchStart,
  current: { distance: number; midpoint: Point },
  viewZoom: number,
): PinchResult {
  const ratio = start.distance > 0 ? current.distance / start.distance : 1;
  const scale = Math.min(PINCH_MAX_SCALE, Math.max(PINCH_MIN_SCALE, start.frameScale * ratio));
  const z = viewZoom > 0 ? viewZoom : 1;
  return {
    scale,
    x: start.frameOffset.x + (current.midpoint.x - start.midpoint.x) / z,
    y: start.frameOffset.y + (current.midpoint.y - start.midpoint.y) / z,
  };
}
