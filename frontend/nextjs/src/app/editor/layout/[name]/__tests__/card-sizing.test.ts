import { FEW_CARDS, canvasCardStyle, canvasCardWidthClass } from '../editor-utils';

describe('canvas card sizing', () => {
  it('gives a few cards a size of their own and many cards a share of the row', () => {
    expect(canvasCardWidthClass(1)).toContain('sm:w-[var(--card-w)]');
    expect(canvasCardWidthClass(FEW_CARDS)).toContain('sm:w-[var(--card-w)]');
    expect(canvasCardWidthClass(FEW_CARDS + 1)).toContain('2xl:w-[calc((100%-6*0.875rem)/7)]');
    expect(canvasCardWidthClass(FEW_CARDS + 1)).not.toContain('--card-w');
  });

  it('caps a portrait card by width and by 70% of the window height', () => {
    const w = String(canvasCardStyle(1200, 1800)['--card-w' as keyof ReturnType<typeof canvasCardStyle>]);
    expect(w).toContain('24rem');
    expect(w).toContain('70vh * 0.6667');
  });

  it('lets a landscape card be wider, and falls back for a missing size', () => {
    expect(String(canvasCardStyle(1800, 1200)['--card-w' as keyof ReturnType<typeof canvasCardStyle>])).toContain('34rem');
    expect(String(canvasCardStyle(0, 0)['--card-w' as keyof ReturnType<typeof canvasCardStyle>])).toContain('0.6667');
  });
});
