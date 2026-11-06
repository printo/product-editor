import {
  BLANK_FONT, DEFAULT_OVERLAY_FONT, canvasText, configurePrintFonts, fontOptionLabel, isGenericFont, loadBlankFont, loadOverlayFonts,
  overlayFontFamily, overlayFontsReady, overlayFontStack, pickerFonts, printFontName,
} from '../overlay-fonts';

describe('fontOptionLabel', () => {
  it('names the language beside a font that has one, and leaves the rest alone', () => {
    const languages = { 'Hind Madurai': ['Tamil'] };
    expect(fontOptionLabel('Hind Madurai', languages)).toBe('Hind Madurai · Tamil');
    expect(fontOptionLabel('Lobster', languages)).toBe('Lobster');
    expect(fontOptionLabel('Hind Madurai')).toBe('Hind Madurai');
    expect(fontOptionLabel('Odd', { Odd: [] })).toBe('Odd');
  });
});

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

describe('the canvas draws text as the print does', () => {
  type Face = { family: string; status: string };
  const realFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  const realFontFace = (globalThis as { FontFace?: unknown }).FontFace;
  const realFetch = global.fetch;

  /** A stand-in for the browser's font set. */
  function fakeFonts(faces: Face[]) {
    const set = {
      forEach: (fn: (f: Face) => void) => faces.forEach(fn),
      add: jest.fn((face: Face) => { faces.push(face); }),
    };
    Object.defineProperty(document, 'fonts', { configurable: true, value: set });
    return set;
  }

  /** A stand-in for FontFace whose load() succeeds or fails. */
  function fakeFontFace(ok = true) {
    const made: { family: string; source: unknown; descriptors: unknown }[] = [];
    (globalThis as { FontFace?: unknown }).FontFace = class {
      status = 'unloaded';
      constructor(public family: string, source: unknown, descriptors?: unknown) { made.push({ family, source, descriptors }); }
      load() {
        if (!ok) return Promise.reject(new Error('blocked'));
        this.status = 'loaded';
        return Promise.resolve(this);
      }
    };
    return made;
  }

  function fakeFetch(status = 200) {
    const mock = jest.fn().mockResolvedValue({ ok: status < 400, status, arrayBuffer: async () => new ArrayBuffer(8) });
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  const loaded = (family: string): Face => ({ family, status: 'loaded' });
  const source = { apiBase: '/api/embed/proxy', getAuthHeaders: () => ({ 'X-Embed-Token': 't' }) };

  afterEach(() => {
    if (realFonts) Object.defineProperty(document, 'fonts', realFonts);
    else delete (document as unknown as { fonts?: unknown }).fonts;
    (globalThis as { FontFace?: unknown }).FontFace = realFontFace;
    global.fetch = realFetch;
    configurePrintFonts(null);
    jest.restoreAllMocks();
  });

  it('drops the hidden selector that asks for a colour emoji, and nothing else', () => {
    expect(canvasText('I \u2764\uFE0F you \u263A\uFE0E')).toBe('I \u2764 you \u263A');
    expect(canvasText('Won the argument\n\u{1F57A} \u{1F3B6}')).toBe('Won the argument\n\u{1F57A} \u{1F3B6}');
  });

  it('draws with the print’s font file and then the blank font, once both are loaded', () => {
    fakeFonts([loaded('Pacifico (print)'), loaded('"Josefin Sans (print)"'), loaded(BLANK_FONT)]);
    expect(printFontName('Pacifico')).toBe('Pacifico (print)');
    expect(overlayFontStack('Pacifico')).toBe('"Pacifico (print)", "PE Blank"');
    expect(overlayFontStack('Josefin Sans')).toBe('"Josefin Sans (print)", "PE Blank"');
  });

  it('does the same for the default, for a missing or generic family', () => {
    fakeFonts([loaded('Inter (print)'), loaded(BLANK_FONT)]);
    expect(overlayFontStack(undefined)).toBe('"Inter (print)", "PE Blank"');
    expect(overlayFontStack('cursive')).toBe('"Inter (print)", "PE Blank"');
  });

  it('draws with Google’s copy, as before, until the print’s file is loaded: the blank font alone would hide every letter', () => {
    fakeFonts([loaded('Pacifico'), { family: 'Pacifico (print)', status: 'loading' }, loaded(BLANK_FONT)]);
    expect(overlayFontsReady('Pacifico')).toBe(false);
    expect(overlayFontStack('Pacifico')).toBe('"Pacifico"');
  });

  it('draws with Google’s copy when the blank font is missing, so nothing changes from before', () => {
    fakeFonts([loaded('Pacifico (print)')]);
    expect(overlayFontStack('Pacifico')).toBe('"Pacifico"');
  });

  it('is not ready where the browser cannot report fonts at all', () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
    expect(overlayFontsReady('Inter')).toBe(false);
    expect(overlayFontStack('Inter')).toBe('"Inter"');
  });

  it('fetches each family’s print file once through the page’s proxy, and the blank font', async () => {
    const fonts = fakeFonts([]);
    const made = fakeFontFace();
    const fetched = fakeFetch();
    configurePrintFonts(source);
    await loadOverlayFonts([{ fontFamily: 'Josefin Sans' }, { fontFamily: 'Josefin Sans' }, { fontFamily: null }]);
    expect(fetched.mock.calls.map(c => c[0]).sort()).toEqual([
      '/api/embed/proxy/fonts/file/Inter', '/api/embed/proxy/fonts/file/Josefin%20Sans',
    ]);
    expect(fetched.mock.calls[0][1]).toEqual({ headers: { 'X-Embed-Token': 't' } });
    expect(made.map(m => m.family).sort()).toEqual(['Inter (print)', 'Josefin Sans (print)', 'PE Blank']);
    expect(made.find(m => m.family === 'PE Blank')?.source).toBe('url(/fonts/pe-blank.ttf)');
    expect(made.find(m => m.family === 'Inter (print)')?.descriptors).toMatchObject({ variationSettings: '"opsz" 14' });
    expect(fonts.add).toHaveBeenCalledTimes(3);
    expect(overlayFontStack('Josefin Sans')).toBe('"Josefin Sans (print)", "PE Blank"');
    await loadOverlayFonts([{ fontFamily: 'Josefin Sans' }]);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('fetches nothing until the page says where the files are', async () => {
    fakeFonts([loaded(BLANK_FONT)]);
    fakeFontFace();
    const fetched = fakeFetch();
    await loadOverlayFonts([{ fontFamily: 'Lobster' }]);
    expect(fetched).not.toHaveBeenCalled();
    expect(overlayFontStack('Lobster')).toBe('"Lobster"');
  });

  it('gives up quietly on a font the server cannot serve, and does not ask again straight away', async () => {
    const fonts = fakeFonts([loaded(BLANK_FONT)]);
    fakeFontFace();
    const fetched = fakeFetch(503);
    configurePrintFonts(source);
    await expect(loadOverlayFonts([{ fontFamily: 'Oswald' }])).resolves.toBeUndefined();
    await loadOverlayFonts([{ fontFamily: 'Oswald' }]);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fonts.add).not.toHaveBeenCalled();
    expect(overlayFontStack('Oswald')).toBe('"Oswald"');
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await loadOverlayFonts([{ fontFamily: 'Oswald' }]);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('resolves when the blank font cannot be loaded', async () => {
    const fonts = fakeFonts([]);
    fakeFontFace(false);
    await expect(loadBlankFont()).resolves.toBeUndefined();
    expect(fonts.add).not.toHaveBeenCalled();
  });
});
