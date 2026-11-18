import { Path } from 'fabric';
import type { FrameGeom } from './frame-fill';

/**
 * Preview-only dimming of the part of a frame's box that the finished product
 * does not include: the four corners outside a rounded, oval-ish or circular
 * photo window. The print file is always a rectangle, so without this a
 * customer sees a square with a shape drawn in it and cannot tell what is
 * cut away. Never drawn in an export, and never printed.
 *
 * Shared by the live editor (FabricEditor.tsx) and the thumbnail renderer
 * (fabric-renderer.ts) so the two cannot drift.
 */

export const CUT_AWAY_SHADE = 'rgba(68,68,65,0.45)';

const MIN_VISIBLE_RADIUS_PX = 0.5;

/**
 * SVG path in the frame's own coordinates (0,0 to fw,fh): the box minus the
 * rounded shape, to be filled with the even-odd rule. Null for a square
 * frame, where nothing is cut away.
 */
export function cutAwayPath(fw: number, fh: number, fr: number): string | null {
  const r = Math.min(fr, fw / 2, fh / 2);
  if (!(fw > 0) || !(fh > 0) || !(r > MIN_VISIBLE_RADIUS_PX)) return null;
  const box = `M 0 0 H ${fw} V ${fh} H 0 Z`;
  const shape =
    `M ${r} 0 H ${fw - r} A ${r} ${r} 0 0 1 ${fw} ${r} V ${fh - r} ` +
    `A ${r} ${r} 0 0 1 ${fw - r} ${fh} H ${r} A ${r} ${r} 0 0 1 0 ${fh - r} ` +
    `V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  return `${box} ${shape}`;
}

/** The dimming object for one frame, or null when its corners are square. */
export function makeCutAwayShade({ fx, fy, fw, fh, fr }: FrameGeom): Path | null {
  const d = cutAwayPath(fw, fh, fr);
  if (!d) return null;
  return new Path(d, {
    left: fx,
    top: fy,
    originX: 'left',
    originY: 'top',
    fill: CUT_AWAY_SHADE,
    fillRule: 'evenodd',
    strokeWidth: 0,
    selectable: false,
    evented: false,
  });
}
