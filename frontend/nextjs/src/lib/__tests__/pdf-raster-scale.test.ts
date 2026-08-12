import {
  computeRasterScale,
  computeThumbnailScale,
  PDF_MAX_OUTPUT_DIMENSION_PX,
  PDF_RASTER_DPI,
} from '@/lib/pdf-raster-scale';

describe('computeRasterScale', () => {
  it('scales an unclamped Letter page at scale = targetDpi / 72, no clamping', () => {
    // US Letter: 612 x 792 pt
    const result = computeRasterScale(612, 792, PDF_RASTER_DPI, PDF_MAX_OUTPUT_DIMENSION_PX);
    const expectedScale = PDF_RASTER_DPI / 72;
    expect(result.scale).toBeCloseTo(expectedScale, 5);
    expect(result.outputWidthPx).toBeCloseTo(612 * expectedScale, 3);
    expect(result.outputHeightPx).toBeCloseTo(792 * expectedScale, 3);
    // Sanity: well under the cap, so no clamping should have kicked in.
    expect(result.outputHeightPx).toBeLessThan(PDF_MAX_OUTPUT_DIMENSION_PX);
  });

  it('clamps a poster-sized page proportionally to the max dimension', () => {
    // 24in x 36in poster in points (24*72=1728, 36*72=2592).
    const result = computeRasterScale(1728, 2592, PDF_RASTER_DPI, 6000);
    expect(result.outputHeightPx).toBeCloseTo(6000, 3);
    expect(result.outputWidthPx).toBeLessThan(6000);
    // Aspect ratio preserved: width/height must match the source ratio.
    expect(result.outputWidthPx / result.outputHeightPx).toBeCloseTo(1728 / 2592, 5);
  });

  it('clamps whichever side is longer, not always height', () => {
    // Landscape poster: wide side (3456pt) must hit the cap.
    const result = computeRasterScale(3456, 864, PDF_RASTER_DPI, 6000);
    expect(result.outputWidthPx).toBeCloseTo(6000, 3);
    expect(result.outputHeightPx).toBeLessThan(6000);
  });

  it('returns an all-zero result for degenerate page sizes', () => {
    expect(computeRasterScale(0, 792, 200, 6000)).toEqual({ scale: 0, outputWidthPx: 0, outputHeightPx: 0 });
    expect(computeRasterScale(612, -1, 200, 6000)).toEqual({ scale: 0, outputWidthPx: 0, outputHeightPx: 0 });
    expect(computeRasterScale(NaN, 792, 200, 6000)).toEqual({ scale: 0, outputWidthPx: 0, outputHeightPx: 0 });
  });
});

describe('computeThumbnailScale', () => {
  it('targets the longer edge for a portrait page', () => {
    const scale = computeThumbnailScale(612, 792, 240);
    expect(scale).toBeCloseTo(240 / 792, 5);
    expect(792 * scale).toBeCloseTo(240, 3);
    expect(612 * scale).toBeLessThan(240);
  });

  it('targets the longer edge for a landscape page', () => {
    const scale = computeThumbnailScale(792, 612, 240);
    expect(scale).toBeCloseTo(240 / 792, 5);
    expect(792 * scale).toBeCloseTo(240, 3);
    expect(612 * scale).toBeLessThan(240);
  });

  it('returns 0 for a degenerate page size', () => {
    expect(computeThumbnailScale(0, 792, 240)).toBe(0);
    expect(computeThumbnailScale(612, -5, 240)).toBe(0);
  });
});
