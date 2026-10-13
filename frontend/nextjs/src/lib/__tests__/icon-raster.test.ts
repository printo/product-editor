import {
  MAX_RASTER_PX, MIN_RASTER_PX, needsRasterForPrint, overlayRasterSize, rasterFileName, rasterizeSvgUrl, svgForRaster,
} from '../icon-raster';

const ICONIFY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1.02em" height="1em" viewBox="0 0 256 250"><path fill="#4285F4" d="M0 0h256v250H0z"/></svg>';

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

describe('needsRasterForPrint', () => {
  it('is true only for an overlay the print has no file for and can only reach by URL', () => {
    expect(needsRasterForPrint({ source: 'icon', src: 'https://api.iconify.design/logos/facebook.svg' })).toBe(true);
    expect(needsRasterForPrint({ source: 'clipart', src: 'http://example.com/star.svg' })).toBe(true);
    expect(needsRasterForPrint({ source: 'local', src: 'https://x/y.png' })).toBe(false);
    expect(needsRasterForPrint({ source: 'icon', src: 'https://x/y.svg', originalFile: new File(['x'], 'y.png') })).toBe(false);
    expect(needsRasterForPrint({ source: 'clipart', src: '/clipart/star.svg' })).toBe(false);
    expect(needsRasterForPrint({ source: 'icon', src: 'blob:abc' })).toBe(false);
  });
});

describe('overlayRasterSize', () => {
  it('is the overlay’s share of the print canvas, rounded down as the print rounds it', () => {
    // overlay_renderer: w_px = int(width * cw / 100) → 12.5% of 1801 = 225.125
    expect(overlayRasterSize({ width: 12.5, height: 10 }, { width: 1801, height: 2700 })).toEqual({ width: 225, height: 270 });
  });

  it('never goes below what the upload accepts, nor above what a phone can draw', () => {
    expect(overlayRasterSize({ width: 1, height: 200 }, { width: 1200, height: 9000 })).toEqual({ width: MIN_RASTER_PX, height: MAX_RASTER_PX });
    expect(overlayRasterSize({ width: 0, height: 0 }, { width: 1200, height: 1800 })).toEqual({ width: MIN_RASTER_PX, height: MIN_RASTER_PX });
  });

  it('falls back to a fixed size when the canvas size is unknown', () => {
    expect(overlayRasterSize({ width: 12, height: 12 }, null)).toEqual({ width: 1024, height: 1024 });
  });
});

describe('svgForRaster', () => {
  it('gives the SVG an exact pixel size that it fills edge to edge, keeping its viewBox', () => {
    const svg = parse(svgForRaster(ICONIFY_SVG, 640, 480));
    expect(svg.getAttribute('width')).toBe('640');
    expect(svg.getAttribute('height')).toBe('480');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 250');
    expect(svg.getElementsByTagName('path')).toHaveLength(1);
  });

  it('derives a viewBox from a plain pixel size so resizing scales the drawing', () => {
    const svg = parse(svgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="48px" height="24"><rect width="48" height="24"/></svg>', 96, 48));
    expect(svg.getAttribute('viewBox')).toBe('0 0 48 24');
    expect(svg.getAttribute('width')).toBe('96');
  });

  it('refuses something that is not an SVG', () => {
    expect(() => svgForRaster('<html><body>Not found</body></html>', 10, 10)).toThrow();
  });
});

describe('rasterFileName', () => {
  it('turns a label into a PNG name the upload accepts', () => {
    expect(rasterFileName('flat-color-icons:like')).toBe('icon-flat-color-icons-like.png');
    expect(rasterFileName(' / ')).toBe('icon-image.png');
    expect(rasterFileName(undefined)).toBe('icon-image.png');
  });
});

describe('rasterizeSvgUrl', () => {
  const realImage = global.Image;
  let drawn: unknown[][];
  let svgBlobs: Blob[];

  beforeEach(() => {
    drawn = [];
    svgBlobs = [];
    // happy-dom decodes no images and has no 2D canvas: stand both in.
    global.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) { queueMicrotask(() => this.onload?.()); }
      decode() { return Promise.resolve(); }
    } as unknown as typeof Image;
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage: (...args: unknown[]) => drawn.push([this.width, this.height, ...args.slice(1)]) } as never;
    });
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) { cb(new Blob(['png'], { type: 'image/png' })); };
    URL.createObjectURL = jest.fn((b: Blob) => { svgBlobs.push(b); return 'blob:svg'; });
    URL.revokeObjectURL = jest.fn();
  });
  afterEach(() => {
    global.Image = realImage;
    jest.restoreAllMocks();
  });

  it('draws the fetched SVG at exactly the requested size and returns it as a PNG file', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => ICONIFY_SVG })) as unknown as typeof fetch;
    const file = await rasterizeSvgUrl('https://api.iconify.design/logos/google-icon.svg', 300, 200, 'icon-logos-google-icon.png');
    expect(global.fetch).toHaveBeenCalledWith('https://api.iconify.design/logos/google-icon.svg');
    expect(file).toMatchObject({ name: 'icon-logos-google-icon.png', type: 'image/png' });
    expect(drawn).toEqual([[300, 200, 0, 0, 300, 200]]);
    const sized = parse(await svgBlobs[0].text());
    expect([sized.getAttribute('width'), sized.getAttribute('height')]).toEqual(['300', '200']);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg');
  });

  it('draws a PNG sticker straight from its bytes, stretched to the requested size', async () => {
    const png = new Blob(['\x89PNG'], { type: 'image/png' });
    global.fetch = jest.fn(async () => ({
      ok: true, headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) }, blob: async () => png,
    })) as unknown as typeof fetch;
    const file = await rasterizeSvgUrl('https://product-editor.printo.in/api/templates/assets/sticker_abc.png', 240, 180, 'icon-balloon.png');
    expect(file).toMatchObject({ name: 'icon-balloon.png', type: 'image/png' });
    expect(drawn).toEqual([[240, 180, 0, 0, 240, 180]]);
    // The PNG itself went to the canvas; nothing was parsed as SVG.
    expect(svgBlobs).toEqual([png]);
  });

  it('fails, rather than returning a blank file, when the icon can’t be downloaded', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as unknown as typeof fetch;
    await expect(rasterizeSvgUrl('https://api.iconify.design/x/gone.svg', 64, 64, 'icon-x.png')).rejects.toThrow(/404/);
    expect(drawn).toEqual([]);
  });
});
