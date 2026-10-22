import { FEW_CARDS, canvasCardStyle, canvasCardWidthClass } from '../editor-utils';

describe('canvas card sizing', () => {
  it('gives a few cards a size of their own and many cards a share of the row', () => {
    expect(canvasCardWidthClass(1)).toContain('sm:w-[var(--card-w)]');
    expect(canvasCardWidthClass(FEW_CARDS)).toContain('sm:w-[var(--card-w)]');
    expect(canvasCardWidthClass(FEW_CARDS + 1)).toContain('2xl:w-[calc((100%-6*0.875rem)/7)]');
    expect(canvasCardWidthClass(FEW_CARDS + 1)).not.toContain('--card-w');
  });

  const widthOf = (w: number, h: number) =>
    String(canvasCardStyle(w, h)['--card-w' as keyof ReturnType<typeof canvasCardStyle>]);

  it('caps a card at 70% of the window width and ~80% of its height', () => {
    const portrait = widthOf(1200, 1800);
    expect(portrait).toContain('70vw');
    expect(portrait).toContain('80vh * 0.6667');
    expect(widthOf(1800, 1200)).toContain('80vh * 1.5000');
  });

  it('falls back to a portrait shape for a missing size', () => {
    expect(widthOf(0, 0)).toContain('0.6667');
  });
});
