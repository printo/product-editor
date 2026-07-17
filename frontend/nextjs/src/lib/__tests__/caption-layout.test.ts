import {
  resolveCaptionBox,
  hasCaptionPlacement,
  DEFAULT_CAPTION_COLOR,
} from '../caption-layout';

// Frame rect used across cases: top-left (100,200), 400×300.
const FX = 100, FY = 200, FW = 400, FH = 300;

describe('hasCaptionPlacement', () => {
  it('is false for null/empty overrides (legacy captions)', () => {
    expect(hasCaptionPlacement(null)).toBe(false);
    expect(hasCaptionPlacement(undefined)).toBe(false);
    expect(hasCaptionPlacement({})).toBe(false);
    expect(hasCaptionPlacement({ xPx: null, color: null })).toBe(false);
  });
  it('is true when any field is set', () => {
    expect(hasCaptionPlacement({ xPx: 10 })).toBe(true);
    expect(hasCaptionPlacement({ color: '#fff' })).toBe(true);
    expect(hasCaptionPlacement({ align: 'left' })).toBe(true);
  });
});

describe('resolveCaptionBox defaults (legacy bottom-centre)', () => {
  const r = resolveCaptionBox(FX, FY, FW, FH);
  it('width = 80% of frame width', () => {
    expect(r.w).toBe(FW * 0.8); // 320
  });
  it('font = 4% of frame height', () => {
    expect(r.fontPx).toBeCloseTo(FH * 0.04); // 12
  });
  it('is horizontally centred', () => {
    expect(r.x).toBe(FX + (FW - FW * 0.8) / 2); // 100 + 40 = 140
  });
  it('sits near the bottom (8% up, lifted half the font)', () => {
    expect(r.y).toBeCloseTo(FY + FH - FH * 0.08 - (FH * 0.04) / 2); // 200+300-24-6 = 470
  });
  it('defaults to centre align + dark grey', () => {
    expect(r.align).toBe('center');
    expect(r.color).toBe(DEFAULT_CAPTION_COLOR);
  });
});

describe('resolveCaptionBox explicit overrides', () => {
  it('uses every provided field verbatim', () => {
    const r = resolveCaptionBox(FX, FY, FW, FH, {
      xPx: 10, yPx: 20, wPx: 150, fontPx: 30, align: 'right', color: '#ff0000',
    });
    expect(r).toEqual({ x: 10, y: 20, w: 150, fontPx: 30, align: 'right', color: '#ff0000' });
  });

  it('falls back per-field: explicit width recenters the default x', () => {
    const r = resolveCaptionBox(FX, FY, FW, FH, { wPx: 200 });
    expect(r.w).toBe(200);
    // x default recomputes against the explicit width
    expect(r.x).toBe(FX + (FW - 200) / 2); // 100 + 100 = 200
  });

  it('treats explicit 0 as a real value, not a fallback', () => {
    const r = resolveCaptionBox(FX, FY, FW, FH, { xPx: 0, yPx: 0 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});
