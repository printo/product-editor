import { alignFrames, nudgeFrames, type AlignFrame } from '../frame-align';

// Three frames at different positions/sizes to exercise the bounding-box maths.
const make = (): AlignFrame[] => [
  { id: 'a', xMm: 10, yMm: 10, widthMm: 40, heightMm: 20 },
  { id: 'b', xMm: 30, yMm: 50, widthMm: 60, heightMm: 30 },
  { id: 'c', xMm: 5, yMm: 80, widthMm: 20, heightMm: 40 },
];

describe('alignFrames', () => {
  it('aligns selected frames to the left edge of their bounding box', () => {
    const out = alignFrames(make(), ['a', 'b'], 'left');
    // bbox left = min(a.x=10, b.x=30) = 10
    expect(out[0].xMm).toBe(10);
    expect(out[1].xMm).toBe(10);
    // c not selected → untouched
    expect(out[2].xMm).toBe(5);
  });

  it('aligns to the right edge (right = max of x+w), offsetting by each width', () => {
    const out = alignFrames(make(), ['a', 'b'], 'right');
    const right = Math.max(10 + 40, 30 + 60); // 90
    expect(out[0].xMm).toBe(right - 40); // 50
    expect(out[1].xMm).toBe(right - 60); // 30
  });

  it('centers horizontally around the bounding-box centre', () => {
    const out = alignFrames(make(), ['a', 'b'], 'centerH');
    const cx = (10 + 90) / 2; // 50
    expect(out[0].xMm).toBe(cx - 40 / 2); // 30
    expect(out[1].xMm).toBe(cx - 60 / 2); // 20
  });

  it('aligns to the top edge', () => {
    const out = alignFrames(make(), ['a', 'c'], 'top');
    expect(out[0].yMm).toBe(10);
    expect(out[2].yMm).toBe(10);
  });

  it('aligns to the bottom edge (offset by each height)', () => {
    const out = alignFrames(make(), ['a', 'c'], 'bottom');
    const bottom = Math.max(10 + 20, 80 + 40); // 120
    expect(out[0].yMm).toBe(bottom - 20); // 100
    expect(out[2].yMm).toBe(bottom - 40); // 80
  });

  it('is a no-op when fewer than 2 frames are selected', () => {
    const input = make();
    expect(alignFrames(input, ['a'], 'left')).toBe(input);
    expect(alignFrames(input, [], 'left')).toBe(input);
  });

  it('never mutates non-selected frames', () => {
    const out = alignFrames(make(), ['a', 'b'], 'left');
    expect(out[2]).toEqual({ id: 'c', xMm: 5, yMm: 80, widthMm: 20, heightMm: 40 });
  });

  it('preserves unrelated frame fields (e.g. caption/bleed)', () => {
    interface RichFrame extends AlignFrame { bleedMm?: number; caption?: string }
    const frames: RichFrame[] = [
      { id: 'a', xMm: 10, yMm: 10, widthMm: 40, heightMm: 20, bleedMm: 3, caption: 'hi' },
      { id: 'b', xMm: 30, yMm: 50, widthMm: 60, heightMm: 30 },
    ];
    const out = alignFrames(frames, ['a', 'b'], 'left');
    expect(out[0].bleedMm).toBe(3);
    expect(out[0].caption).toBe('hi');
  });
});

describe('nudgeFrames', () => {
  it('moves selected frames by the delta', () => {
    const out = nudgeFrames(make(), ['a'], 5, -3, 200, 200);
    expect(out[0].xMm).toBe(15);
    expect(out[0].yMm).toBe(7);
    expect(out[1].xMm).toBe(30); // untouched
  });

  it('clamps the printable rect inside the canvas (right/bottom)', () => {
    // frame a is 40×20 on a 100×100 canvas → max x = 60, max y = 80
    const out = nudgeFrames(make(), ['a'], 1000, 1000, 100, 100);
    expect(out[0].xMm).toBe(60);
    expect(out[0].yMm).toBe(80);
  });

  it('clamps to zero at the top/left', () => {
    const out = nudgeFrames(make(), ['a'], -1000, -1000, 200, 200);
    expect(out[0].xMm).toBe(0);
    expect(out[0].yMm).toBe(0);
  });

  it('moves multiple selected frames together', () => {
    const out = nudgeFrames(make(), ['a', 'b'], 2, 2, 500, 500);
    expect(out[0].xMm).toBe(12);
    expect(out[1].xMm).toBe(32);
  });

  it('rounds to 2 decimals', () => {
    const out = nudgeFrames([{ id: 'a', xMm: 0.1, yMm: 0, widthMm: 10, heightMm: 10 }], ['a'], 0.005, 0, 200, 200);
    expect(out[0].xMm).toBe(0.11);
  });
});
