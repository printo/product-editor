/** Unit tests for the pinch-gesture math (Phase 3 — mobile). */
import {
  PINCH_MAX_SCALE,
  PINCH_MIN_SCALE,
  computePinch,
  pointerDistance,
  pointerMidpoint,
} from '../pinch-utils';

const start = {
  distance: 100,
  midpoint: { x: 200, y: 300 },
  frameScale: 1,
  frameOffset: { x: 10, y: -5 },
};

describe('computePinch', () => {
  it('scales by the finger-distance ratio', () => {
    const out = computePinch(start, { distance: 200, midpoint: start.midpoint }, 1);
    expect(out.scale).toBeCloseTo(2);
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(-5);
  });

  it('clamps scale to the allowed range', () => {
    expect(computePinch(start, { distance: 5000, midpoint: start.midpoint }, 1).scale).toBe(PINCH_MAX_SCALE);
    expect(computePinch(start, { distance: 1, midpoint: start.midpoint }, 1).scale).toBe(PINCH_MIN_SCALE);
  });

  it('midpoint drag pans, divided by the view zoom', () => {
    const out = computePinch(start, { distance: 100, midpoint: { x: 240, y: 280 } }, 2);
    expect(out.x).toBeCloseTo(10 + 40 / 2);
    expect(out.y).toBeCloseTo(-5 + -20 / 2);
  });

  it('zero start distance and zero zoom degrade safely', () => {
    const out = computePinch(
      { ...start, distance: 0 },
      { distance: 100, midpoint: start.midpoint },
      0,
    );
    expect(out.scale).toBe(1);
    expect(Number.isFinite(out.x)).toBe(true);
  });
});

describe('pointer helpers', () => {
  it('distance and midpoint', () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pointerMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});
