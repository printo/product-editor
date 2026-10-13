/**
 * Reading an overlay's box back from the Fabric object the customer moved
 * (lib/overlay-geometry.ts, used by FabricEditor's object:modified handler).
 * Each shape is built differently by createShapeFromOverlay, and the box must
 * round-trip through a plain move without changing size or jumping.
 */
import {
  polygonBoxFraction,
  shapeBoxFromObject,
  shapeRepresentation,
  shapeScaleForBox,
  textBoxFromObject,
} from '@/lib/overlay-geometry';

const W = 1000;
const H = 2000;

describe('shapeRepresentation', () => {
  it('matches how createShapeFromOverlay builds each catalogue shape', () => {
    expect(shapeRepresentation('rect')).toBe('box');
    expect(shapeRepresentation('rounded-rect')).toBe('box');
    expect(shapeRepresentation('triangle')).toBe('box');
    expect(shapeRepresentation('circle')).toBe('centered');
    expect(shapeRepresentation('ellipse')).toBe('centered');
    expect(shapeRepresentation('hexagon')).toBe('polygon');
    expect(shapeRepresentation('star')).toBe('path');
    expect(shapeRepresentation('no-such-shape')).toBe('path');
  });
});

describe('shapeBoxFromObject', () => {
  it('reads a rect back as its top-left box, folding in corner-handle scale', () => {
    expect(shapeBoxFromObject({ left: 100, top: 400, width: 200, height: 100, scaleX: 1, scaleY: 1 }, 'rect', W, H))
      .toEqual({ x: 10, y: 20, width: 20, height: 5 });
    expect(shapeBoxFromObject({ left: 100, top: 400, width: 200, height: 100, scaleX: 2, scaleY: 1.5 }, 'rect', W, H))
      .toEqual({ x: 10, y: 20, width: 40, height: 7.5 });
  });

  it('converts a circle or ellipse centre back to the top-left box so a move does not jump it', () => {
    // A 30% x 10% box at (40%, 30%): createShapeFromOverlay puts the circle's
    // centre at (55%, 35%) with diameter min(300, 200) = 200 px.
    const circle = shapeBoxFromObject({ left: 550, top: 700, width: 200, height: 200, scaleX: 1, scaleY: 1 }, 'circle', W, H);
    expect(circle).toEqual({ x: 45, y: 30, width: 20, height: 10 });
    // Until 2026-10-13 x was read as 55 — the circle moved right by half its
    // size on every move.

    const ellipse = shapeBoxFromObject({ left: 550, top: 700, width: 300, height: 200, scaleX: 1, scaleY: 1 }, 'ellipse', W, H);
    expect(ellipse).toEqual({ x: 40, y: 30, width: 30, height: 10 });
  });

  it('keeps a path at its box size: the scale IS the box, not Fabric width x scale', () => {
    // A star in a 30% x 10% box is a Path scaled by (300/100, 200/100) whose
    // own bounds are 94 x 88 units. Reading width x scaleX would give 28.2%.
    const star = shapeBoxFromObject({ left: 400, top: 600, width: 94, height: 88, scaleX: 3, scaleY: 2 }, 'star', W, H);
    expect(star).toEqual({ x: 40, y: 30, width: 30, height: 10 });
  });

  it('reads a catalogue polygon back through its point bounds', () => {
    // The hexagon's points span x 7–93 and y 0–100 of its box.
    expect(polygonBoxFraction('hexagon')).toEqual({ w: 0.86, h: 1 });
    const hex = shapeBoxFromObject({ left: 400, top: 600, width: 258, height: 200, scaleX: 1, scaleY: 1 }, 'hexagon', W, H);
    expect(hex).toEqual({ x: 40, y: 30, width: 30, height: 10 });
    expect(polygonBoxFraction('rect')).toEqual({ w: 1, h: 1 });
  });
});

describe('shapeScaleForBox', () => {
  it('scales a path from its 100-unit space and a polygon from its point bounds', () => {
    expect(shapeScaleForBox('star', 94, 88, 300, 200)).toEqual({ scaleX: 3, scaleY: 2 });
    const hex = shapeScaleForBox('hexagon', 258, 200, 300, 200);
    expect(hex.scaleX).toBeCloseTo(1);
    expect(hex.scaleY).toBeCloseTo(1);
    expect(shapeScaleForBox('rect', 10, 10, 300, 200)).toEqual({ scaleX: 1, scaleY: 1 });
  });
});

describe('textBoxFromObject', () => {
  it('persists the wrap box width and position', () => {
    expect(textBoxFromObject({ left: 500, top: 1000, width: 600, height: 80, scaleX: 1, scaleY: 1, fontSize: 72 }, W, H))
      .toEqual({ x: 50, y: 50, width: 60, fontSize: 72 });
  });

  it('folds a corner-handle scale into fontSize and the box width', () => {
    expect(textBoxFromObject({ left: 500, top: 1000, width: 600, height: 80, scaleX: 1.5, scaleY: 1.5, fontSize: 72 }, W, H))
      .toEqual({ x: 50, y: 50, width: 90, fontSize: 108 });
  });
});
