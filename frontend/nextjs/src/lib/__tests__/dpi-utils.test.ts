/**
 * Unit tests for the effective print-DPI estimation (Phase 2 item 4 —
 * low-resolution warning). The math mirrors fabric-renderer.ts and
 * engine.py _composite_canvas exactly; these tests pin the formula.
 */
import {
  DPI_WARN,
  collectLowDpiFrames,
  computeEffectiveDpi,
  frameSizePx,
  pxPerInchForLayout,
} from '@/lib/dpi-utils';

const BASE = {
  imgW: 1200, imgH: 1800,
  frameWpx: 1200, frameHpx: 1800,
  pxPerInch: 300, rotation: 0, scale: 1,
  fitMode: 'cover' as const,
};

describe('computeEffectiveDpi', () => {
  it('exact-fit source at 300ppi layout is exactly 300 DPI', () => {
    expect(computeEffectiveDpi(BASE)).toBeCloseTo(300, 5);
  });

  it('zoom divides the DPI linearly', () => {
    expect(computeEffectiveDpi({ ...BASE, scale: 2 })).toBeCloseTo(150, 5);
    expect(computeEffectiveDpi({ ...BASE, scale: 2.5 })).toBeCloseTo(120, 5);
    expect(computeEffectiveDpi({ ...BASE, scale: 3.1 })).toBeCloseTo(96.77, 1);
  });

  it('boundary: exactly 150 DPI must NOT be below the warn threshold', () => {
    const dpi = computeEffectiveDpi({ ...BASE, scale: 2 });
    expect(dpi < DPI_WARN).toBe(false);
  });

  it('cover crops harder than contain — contain DPI is always ≥ cover DPI', () => {
    const wide = { ...BASE, imgW: 4000, imgH: 2000 };
    const cover = computeEffectiveDpi({ ...wide, fitMode: 'cover' });
    const contain = computeEffectiveDpi({ ...wide, fitMode: 'contain' });
    // cover baseScale = max(1200/4000, 1800/2000) = 0.9 → ~333 DPI
    expect(cover).toBeCloseTo(300 / 0.9, 1);
    // contain baseScale = min(...) = 0.3 → 1000 DPI
    expect(contain).toBeCloseTo(1000, 1);
    expect(contain).toBeGreaterThanOrEqual(cover);
  });

  it('rotation swaps the effective bounding box', () => {
    const args = { ...BASE, imgW: 2000, imgH: 1000 };
    // 90°: effW=1000, effH=2000 → cover baseScale = max(1.2, 0.9) = 1.2 → 250
    expect(computeEffectiveDpi({ ...args, rotation: 90 })).toBeCloseTo(250, 1);
    expect(computeEffectiveDpi({ ...args, rotation: 270 }))
      .toBeCloseTo(computeEffectiveDpi({ ...args, rotation: 90 }), 5);
    expect(computeEffectiveDpi({ ...args, rotation: 180 }))
      .toBeCloseTo(computeEffectiveDpi({ ...args, rotation: 0 }), 5);
  });

  it('degenerate inputs return the safe 300 default (no warning)', () => {
    expect(computeEffectiveDpi({ ...BASE, imgW: 0 })).toBe(300);
    expect(computeEffectiveDpi({ ...BASE, frameWpx: 0 })).toBe(300);
  });
});

describe('pxPerInchForLayout', () => {
  it('derives from px + mm when both present (circle_48mm: 685px / 58mm)', () => {
    expect(pxPerInchForLayout({ width: 685, widthMm: 58 })).toBeCloseTo(300, 0);
  });

  it('falls back to declared dpi, then 300', () => {
    expect(pxPerInchForLayout({ width: 1200, dpi: 150 })).toBe(150);
    expect(pxPerInchForLayout({ width: 1200 })).toBe(300);
    expect(pxPerInchForLayout(undefined)).toBe(300);
  });
});

describe('frameSizePx', () => {
  it('scales fractional specs by the canvas', () => {
    expect(frameSizePx({ width: 0.5, height: 0.25 }, 1200, 1800)).toEqual({ w: 600, h: 450 });
  });

  it('passes absolute specs through', () => {
    expect(frameSizePx({ width: 300, height: 400 }, 1200, 1800)).toEqual({ w: 300, h: 400 });
  });

  it('missing spec covers the full canvas', () => {
    expect(frameSizePx(undefined, 1200, 1800)).toEqual({ w: 1200, h: 1800 });
  });
});

describe('collectLowDpiFrames', () => {
  const fakeFile = (name: string) => new File(['x'], name, { type: 'image/png' });
  const sizes = new Map<string, { width: number; height: number }>();
  const getSize = async (f: File) => {
    const s = sizes.get(f.name);
    if (!s) throw new Error('no size');
    return s;
  };

  const layoutDef = {
    canvas: { width: 2400, height: 3000, widthMm: 203.2 },  // 300 ppi
    frames: [{ width: 1, height: 1 }],
  };

  it('flags an under-DPI frame with severity tiers', async () => {
    sizes.set('small.png', { width: 640, height: 480 });
    const out = await collectLowDpiFrames(
      [{
        canvases: [{ frames: [{ originalFile: fakeFile('small.png'), scale: 1, rotation: 0, fitMode: 'cover' }] }],
        layoutDef,
        surfaceKey: null,
      }],
      getSize,
    );
    expect(out).toHaveLength(1);
    // cover baseScale = max(2400/640, 3000/480) = 6.25 → 48 DPI → critical
    expect(out[0].dpi).toBeCloseTo(48, 0);
    expect(out[0].severity).toBe('critical');
  });

  it('skips frames without a recovered File (lost-photo guard owns those)', async () => {
    const out = await collectLowDpiFrames(
      [{
        canvases: [{ frames: [{ originalFile: null, scale: 5, rotation: 0, fitMode: 'cover' }] }],
        layoutDef,
        surfaceKey: null,
      }],
      getSize,
    );
    expect(out).toHaveLength(0);
  });

  it('does not flag healthy frames and carries surface labels', async () => {
    sizes.set('big.png', { width: 6000, height: 8000 });
    sizes.set('small.png', { width: 640, height: 480 });
    const out = await collectLowDpiFrames(
      [{
        canvases: [
          { frames: [{ originalFile: fakeFile('big.png'), scale: 1, rotation: 0, fitMode: 'cover' }] },
          { frames: [{ originalFile: fakeFile('small.png'), scale: 1, rotation: 0, fitMode: 'cover' }] },
        ],
        layoutDef,
        surfaceKey: 'front',
        surfaceLabel: 'Front',
      }],
      getSize,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ canvasIdx: 1, frameIdx: 0, surfaceKey: 'front', surfaceLabel: 'Front' });
  });

  it('undecodable files are skipped, not thrown', async () => {
    const out = await collectLowDpiFrames(
      [{
        canvases: [{ frames: [{ originalFile: fakeFile('mystery.bin'), scale: 1, rotation: 0, fitMode: 'cover' }] }],
        layoutDef,
        surfaceKey: null,
      }],
      getSize,
    );
    expect(out).toHaveLength(0);
  });
});
