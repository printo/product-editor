/**
 * The wrap box both previews give a text overlay (lib/overlay-text.ts). The
 * print applies the same rule in services/overlay_renderer.py
 * (DEFAULT_TEXT_BOX_WIDTH_PCT), so the default here is load-bearing: change
 * it on one side only and a legacy overlay wraps differently in the print.
 */
import { DEFAULT_TEXT_BOX_WIDTH_PCT, textBoxWidthPx, textOriginX } from '@/lib/overlay-text';

describe('textBoxWidthPx', () => {
  it('uses the saved width as a percentage of the canvas', () => {
    expect(textBoxWidthPx({ width: 50 }, 1200)).toBe(600);
    expect(textBoxWidthPx({ width: 12.5 }, 800)).toBe(100);
  });

  it('defaults a legacy overlay (no width) to 80% of the canvas, as the editor always did', () => {
    expect(DEFAULT_TEXT_BOX_WIDTH_PCT).toBe(80);
    expect(textBoxWidthPx({}, 1200)).toBe(960);
    expect(textBoxWidthPx({ width: undefined }, 1200)).toBe(960);
  });

  it('treats a zero or negative width as absent rather than collapsing the box', () => {
    expect(textBoxWidthPx({ width: 0 }, 1200)).toBe(960);
    expect(textBoxWidthPx({ width: -5 }, 1200)).toBe(960);
  });

  it('scales with the canvas, so a thumbnail at a multiplier keeps the same proportions', () => {
    const full = textBoxWidthPx({ width: 40 }, 1800);
    const thumb = textBoxWidthPx({ width: 40 }, 1800 * 0.25);
    expect(thumb).toBeCloseTo(full * 0.25);
  });
});

describe('textOriginX', () => {
  it('anchors left and right text at that edge and everything else at the centre', () => {
    expect(textOriginX('left')).toBe('left');
    expect(textOriginX('right')).toBe('right');
    expect(textOriginX('center')).toBe('center');
    expect(textOriginX(undefined)).toBe('center');
    expect(textOriginX('start')).toBe('center');
  });
});
