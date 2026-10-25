import { mmToPx, pxToMm, mmToUnit, unitToMm } from '../units';

describe('mmToPx / pxToMm', () => {
  it('converts at the given DPI', () => {
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(pxToMm(300, 300)).toBe(25.4);
    expect(mmToPx(0, 300)).toBe(0);
  });

  it('matches, bit for bit, the inline copies it replaced', () => {
    // LayoutSVG's closure and the layouts page's rounded helpers were
    // `(mm / 25.4) * dpi` and `(px / dpi) * 25.4`; the page now rounds the
    // shared result instead, which must not move a single template pixel.
    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
    for (const dpi of [72, 96, 150, 254, 300, 600]) {
      for (let mm = 0; mm <= 420; mm += 0.1) {
        expect(mmToPx(mm, dpi)).toBe((mm / 25.4) * dpi);
        expect(Math.round(mmToPx(mm, dpi))).toBe(Math.round((mm / 25.4) * dpi));
      }
      for (let px = 0; px <= 5000; px += 7) {
        expect(pxToMm(px, dpi)).toBe((px / dpi) * 25.4);
        expect(round2(pxToMm(px, dpi))).toBe(round2((px / dpi) * 25.4));
      }
    }
  });
});

describe('mmToUnit / unitToMm', () => {
  it('passes millimetres through untouched', () => {
    expect(mmToUnit(101.6, 'mm')).toBe(101.6);
    expect(unitToMm(101.6, 'mm')).toBe(101.6);
  });

  it('shows inches at 3 decimals', () => {
    expect(mmToUnit(101.6, 'in')).toBe(4);
    expect(mmToUnit(152.4, 'in')).toBe(6);
    expect(mmToUnit(2, 'in')).toBe(0.079);
  });

  it('round-trips an inch value through the 2-dp millimetres we save', () => {
    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
    for (let thou = 0; thou <= 20000; thou += 1) {
      const inches = thou / 1000;
      expect(mmToUnit(round2(unitToMm(inches, 'in')), 'in')).toBe(inches);
    }
  });
});
