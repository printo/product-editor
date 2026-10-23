import { FEW_CARDS, canvasCardStyle, canvasCardWidthClass, surfaceCardStyle } from '../editor-utils';

describe('canvas card sizing', () => {
  it('gives a few cards a size of their own and many cards a share of the row', () => {
    expect(canvasCardWidthClass(1)).toContain('sm:w-[var(--card-w)]');
    expect(canvasCardWidthClass(FEW_CARDS)).toContain('sm:w-[var(--card-w)]');
    expect(canvasCardWidthClass(FEW_CARDS + 1)).toContain('2xl:w-[calc((100%-6*0.875rem)/7)]');
    expect(canvasCardWidthClass(FEW_CARDS + 1)).not.toContain('--card-w');
  });

  const widthOf = (w: number, h: number) =>
    String(canvasCardStyle(w, h)['--card-w' as keyof ReturnType<typeof canvasCardStyle>]);

  it('caps a card at 70% of the window width and ~75% of its height', () => {
    const portrait = widthOf(1200, 1800);
    expect(portrait).toContain('70vw');
    expect(portrait).toContain('min(75vh, 100vh - 15.5rem) * 0.6667');
    expect(widthOf(1800, 1200)).toContain('min(75vh, 100vh - 15.5rem) * 1.5000');
  });

  it('falls back to a portrait shape for a missing size', () => {
    expect(widthOf(0, 0)).toContain('0.6667');
  });

  it('lets the sides of a front/back product share 70% of the window, each ~70% tall at most', () => {
    const two = String(surfaceCardStyle(1200, 1800, 2)['--card-w' as keyof ReturnType<typeof surfaceCardStyle>]);
    expect(two).toContain('(70vw - 1.50rem) / 2');
    expect(two).toContain('min(70vh, 100vh - 16.5rem) * 0.6667');
    expect(two).toContain('max(280px');
    expect(String(surfaceCardStyle(1800, 1200, 2)['--card-w' as keyof ReturnType<typeof surfaceCardStyle>])).toContain('max(400px');
    const three = String(surfaceCardStyle(1200, 1800, 3)['--card-w' as keyof ReturnType<typeof surfaceCardStyle>]);
    expect(three).toContain('(70vw - 3.00rem) / 3');
  });
});
