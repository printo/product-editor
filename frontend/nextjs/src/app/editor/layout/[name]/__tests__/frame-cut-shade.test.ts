import { cutAwayPath, makeCutAwayShade, CUT_AWAY_SHADE } from '../frame-cut-shade';

describe('cutAwayPath', () => {
  it('is null for a square frame', () => {
    expect(cutAwayPath(100, 100, 0)).toBeNull();
    expect(cutAwayPath(100, 100, 0.2)).toBeNull();
  });

  it('is null for a frame with no size', () => {
    expect(cutAwayPath(0, 100, 10)).toBeNull();
    expect(cutAwayPath(100, 0, 10)).toBeNull();
  });

  it('draws the box and a rounded shape for a rounded rectangle', () => {
    const d = cutAwayPath(200, 100, 20)!;
    expect(d.startsWith('M 0 0 H 200 V 100 H 0 Z')).toBe(true);
    expect(d).toContain('A 20 20 0 0 1 200 20');
  });

  it('caps the radius at half the shorter side, which makes a circle', () => {
    const d = cutAwayPath(100, 100, 9999)!;
    expect(d).toContain('A 50 50 0 0 1 100 50');
  });
});

describe('makeCutAwayShade', () => {
  it('is null for a square frame', () => {
    expect(makeCutAwayShade({ fx: 0, fy: 0, fw: 100, fh: 100, fr: 0 })).toBeNull();
  });

  it('is placed at the frame, filled even-odd, and not interactive', () => {
    const s = makeCutAwayShade({ fx: 30, fy: 40, fw: 100, fh: 100, fr: 50 })!;
    expect(s.left).toBe(30);
    expect(s.top).toBe(40);
    expect(s.fill).toBe(CUT_AWAY_SHADE);
    expect((s as unknown as { fillRule: string }).fillRule).toBe('evenodd');
    expect(s.selectable).toBe(false);
    expect(s.evented).toBe(false);
  });
});
