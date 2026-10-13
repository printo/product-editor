import { DEFAULT_OVERLAY_FONT, isGenericFont, overlayFontFamily, pickerFonts } from '../overlay-fonts';

describe('overlay fonts are Google Fonts only', () => {
  it('draws a missing or generic family in the default, like the print', () => {
    expect(DEFAULT_OVERLAY_FONT).toBe('Inter');
    for (const f of [undefined, null, '', '  ', 'sans-serif', 'Serif', 'cursive', 'monospace', 'system-ui']) {
      expect(overlayFontFamily(f)).toBe('Inter');
    }
  });

  it('keeps a Google family as chosen', () => {
    expect(overlayFontFamily('Great Vibes')).toBe('Great Vibes');
    expect(isGenericFont('Great Vibes')).toBe(false);
  });

  it('drops generics from the picker and never leaves it empty', () => {
    expect(pickerFonts(['sans-serif', 'Lobster', 'serif', 'Pacifico'])).toEqual(['Lobster', 'Pacifico']);
    expect(pickerFonts(['sans-serif', 'serif', 'monospace'])).toEqual(['Inter']);
    expect(pickerFonts([])).toEqual(['Inter']);
  });
});
