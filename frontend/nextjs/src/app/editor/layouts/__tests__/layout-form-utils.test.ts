import {
  buildLayoutFormData, EMPTY_SLOT, framesFromData, framesOutOfBounds, gridFrames, mapFramesForSave,
  readUnitPref, round2, UNIT_PREF_KEY, WHOLE_CANVAS, type LayoutFormState,
} from '../layout-form-utils';

const BASE: LayoutFormState = {
  layoutId: 'classic_4x6', layoutName: '  Classic 4x6 ', layoutType: 'single', tagKeys: ['photo_prints'],
  frameCaptionsEnabled: false, orientationRotatable: true, surfaces: [],
  widthMm: 101.6, heightMm: 152.4, dpi: 300,
  frames: [{ id: 'a', xMm: 10, yMm: 10, widthMm: 81.6, heightMm: 60, bleedMm: 2, x: 0, y: 0, width: 0, height: 0 }],
  frameMask: EMPTY_SLOT, printSheet: WHOLE_CANVAS,
};

function entries(fd: FormData) {
  const out: Array<[string, string]> = [];
  fd.forEach((v, k) => out.push([k, typeof v === 'string' ? v : `file:${(v as File).name}`]));
  return out;
}

describe('round2', () => {
  it('rounds to two places, halves up', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(73.155)).toBe(73.16);
  });
});

describe('mapFramesForSave', () => {
  it('rounds mm and stores the area plus bleed as fractions of the canvas', () => {
    const [f] = mapFramesForSave(BASE.frames, 101.6, 152.4, 300);
    expect(f).toMatchObject({ xMm: 10, yMm: 10, widthMm: 81.6, heightMm: 60, bleedMm: 2, borderRadiusMm: 0 });
    // 8 mm → 94 px, 85.6 mm → 1011 px on a 1200 px wide canvas
    expect(f.x).toBeCloseTo(94 / 1200, 10);
    expect(f.width).toBeCloseTo(1011 / 1200, 10);
  });
});

describe('framesFromData', () => {
  it('keeps mm when saved and reads fractions when not, with fresh ids', () => {
    const frames = framesFromData(
      { frames: [{ id: 'old', x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, { id: 'mm', x: 0, y: 0, width: 1, height: 1, xMm: 3.333, yMm: 0, widthMm: 50, heightMm: 50, bleedMm: '1.5' }] },
      { width: 1200, height: 1800, dpi: 300 },
    );
    expect(frames[0]).toMatchObject({ xMm: 10.16, yMm: 30.48, widthMm: 50.8, heightMm: 38.1, bleedMm: 0 });
    expect(frames[1]).toMatchObject({ xMm: 3.33, widthMm: 50, bleedMm: 1.5 });
    expect(frames.map(f => f.id)).not.toContain('old');
  });

  it('a block without frames gives none', () => {
    expect(framesFromData({}, { width: 1, height: 1 })).toEqual([]);
  });
});

describe('gridFrames', () => {
  it('makes rows × cols equal areas with the padding around and between', () => {
    const g = gridFrames(101.6, 152.4, 2, 2, 2);
    expect(g.map(f => [f.xMm, f.yMm, f.widthMm, f.heightMm])).toEqual([
      [2, 2, 47.8, 73.2], [51.8, 2, 47.8, 73.2], [2, 77.2, 47.8, 73.2], [51.8, 77.2, 47.8, 73.2],
    ]);
    expect(new Set(g.map(f => f.id)).size).toBe(4);
  });
});

describe('framesOutOfBounds', () => {
  const at = (xMm: number, bleedMm = 0) => ({ f: { xMm, yMm: 10, widthMm: 50, heightMm: 50, bleedMm, x: 0, y: 0, width: 0, height: 0 }, w: 100, h: 100 });
  it('inside is fine, touching the edge is fine', () => {
    expect(framesOutOfBounds([at(10), at(50)])).toBe(false);
  });
  it('past the right edge, or pushed out by its bleed, is out', () => {
    expect(framesOutOfBounds([at(51)])).toBe(true);
    expect(framesOutOfBounds([at(1, 2)])).toBe(true);
  });
});

describe('buildLayoutFormData', () => {
  it('single canvas: name, trimmed display_name and the layout JSON, no files', () => {
    const fd = buildLayoutFormData(BASE);
    const e = entries(fd);
    expect(e.map(([k]) => k)).toEqual(['name', 'display_name', 'layout']);
    expect(e[1][1]).toBe('Classic 4x6');
    const layout = JSON.parse(e[2][1]);
    expect(layout).toMatchObject({
      name: 'classic_4x6', tagKeys: ['photo_prints'], canvas: { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4, dpi: 300 },
      frameMaskUrl: null, printSheet: { mode: 'canvas' }, frameCaptionsEnabled: false, orientationRotatable: true,
    });
    expect(layout.type).toBeUndefined();
  });

  it('single canvas with a new frame picture: the file goes first, as frame_mask', () => {
    const fd = buildLayoutFormData({ ...BASE, frameMask: { url: 'https://cdn/x.png', file: new File(['p'], 'wood.png') } });
    expect(entries(fd).map(([k, v]) => (k === 'layout' ? k : `${k}=${v}`))).toEqual(['frame_mask=file:wood.png', 'name=classic_4x6', 'display_name=Classic 4x6', 'layout']);
    expect(JSON.parse(fd.get('layout') as string).frameMaskUrl).toBe('https://cdn/x.png');
  });

  it('product: one block per side, each new mask under frame_mask_<key>', () => {
    const fd = buildLayoutFormData({
      ...BASE, layoutType: 'product',
      surfaces: [
        { key: 'front', label: 'Front', widthMm: 203.2, heightMm: 101.6, dpi: 300, frames: [], frameMask: EMPTY_SLOT, printSheet: WHOLE_CANVAS },
        { key: 'back', label: 'Back', widthMm: 101.6, heightMm: 101.6, dpi: 300, frames: [], frameMask: { url: null, file: new File(['p'], 'b.png') }, printSheet: { mode: 'bleed' } },
      ],
    });
    expect(entries(fd)[0]).toEqual(['frame_mask_back', 'file:b.png']);
    const layout = JSON.parse(fd.get('layout') as string);
    expect(layout.type).toBe('product');
    expect(layout.canvas).toBeUndefined();
    expect(layout.surfaces.map((s: { key: string; canvas: { width: number }; printSheet: unknown }) => [s.key, s.canvas.width, s.printSheet])).toEqual([
      ['front', 2400, { mode: 'canvas' }], ['back', 1200, { mode: 'bleed' }],
    ]);
  });
});

describe('readUnitPref', () => {
  afterEach(() => localStorage.clear());
  it('inches only when remembered as inches', () => {
    expect(readUnitPref()).toBe('mm');
    localStorage.setItem(UNIT_PREF_KEY, 'in');
    expect(readUnitPref()).toBe('in');
    localStorage.setItem(UNIT_PREF_KEY, 'cm');
    expect(readUnitPref()).toBe('mm');
  });
});
