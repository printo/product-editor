/**
 * Reading an export of the older online-canvas design tool: where each
 * object lands in millimetres, which pieces go under the photos and get a
 * hole, and the SVG documents built for them. The designs here are made up
 * with round numbers: the old canvas is 7 x 9 in drawn 177.8 units wide, so
 * one unit is one millimetre, and the 6 x 8 in print area starts 12.7 in.
 */
import {
  DesignImportError, HOLE_INSET_MM, base64ToBytes, buildPageArtwork, bytesToBase64, fontsUsed, frameOverlaySvg, hexColor, inlineSvgOf,
  layoutDefinitionFor, mmToImportPx, parseOnlineCanvasExport, placedDpi, rasterSize, readSvg, readingOrder, scopeSvg,
  sniffArtwork, suggestNames, textOverlayFor, withLayoutGeometry, withoutWindows, type ArtworkSource,
} from '../online-canvas-import';

type Obj = Record<string, unknown>;

const MARGIN = 12.7;
const at = (x: number, y: number) => ({ left: x + MARGIN, top: y + MARGIN });
const win = (x: number, y: number, w: number, h: number, more: Obj = {}): Obj =>
  ({ type: 'mask', element: 'rectangle', width: w, height: h, scaleX: 1, scaleY: 1, angle: 0, ...at(x, y), ...more });
const art = (src: string, x: number, y: number, w: number, h: number, more: Obj = {}): Obj =>
  ({ type: 'image', objType: src.endsWith('.svg') ? 'vectorImage' : 'rasterImage', src, width: w, height: h, scaleX: 1, scaleY: 1, angle: 0, opacity: 1, ...at(x, y), ...more });
const block = (colour: string, x: number, y: number, w: number, h: number): Obj => ({
  type: 'image', objType: 'vectorImage', fill: colour, width: w, height: h, scaleX: 1, scaleY: 1, angle: 0, opacity: 1, ...at(x, y),
  src: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10px" height="10px"  viewBox="0 0 10 10">\n    <rect data-custom-shape="rect" width="10" height="10" fill="${colour}"  stroke="#00FF00" stroke-width ="0" />\n  </svg>`,
});

function exportOf(objects: Obj[], design: Obj = {}, canvas: Obj = {}): string {
  return JSON.stringify([
    {
      design_mode: 'online_canvas',
      customized_locations_map: {
        '40': {
          customization_data: JSON.stringify({ clockwise_rotation_degree: 0, widthPixels: 177.8, heightPixels: 228.6, objects, printableAreaFill: '#f599a6', ...design }),
          design_canvas_id: 565,
        },
      },
    },
    {
      '565': {
        measuring_unit: 'inch', canvas_width: 7, canvas_height: 9, name: 'Photo Frame | 6 x 8 in',
        overlay_image_url: 'https://files.example/frame.svg',
        objects: [{ behavior_type: 'printable_area', shape: 'rectangle', width: 6, height: 8, left_margin: 0.5, top_margin: 0.5, has_bleed_area: false }],
        ...canvas,
      },
    },
  ]);
}

const HEART = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50"><defs><style>.cls-1{fill:#f05773;}</style></defs><path id="heart" class="cls-1" d="M0 0h100v50z"/><use xlink:href="#heart"/></svg>';
const svg = (text: string): ArtworkSource => ({ kind: 'svg', text });
const pngHeader = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpegHeader = (w: number, h: number): Uint8Array =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);

describe('reading the export', () => {
  it('places objects in millimetres from the print area, by width x scale x fit factor', () => {
    const d = parseOnlineCanvasExport(exportOf([
      win(10, 20, 50, 40),
      art('https://files.example/a.svg', 5, 100, 200, 100, { scaleX: 0.5, scaleY: 0.5, scalingFactorToBringImageIntoPrintableArea: 0.5 }),
    ]));
    expect(d.printMm).toEqual({ width: 152.4, height: 203.2 });
    expect(d.canvasPx).toEqual({ width: 1800, height: 2400 });
    expect(d.oldCanvasMm).toMatchObject({ width: 177.8, height: 228.6 });
    expect(d.oldCanvasMm.marginLeft).toBeCloseTo(12.7);
    expect(d.windows[0].box.x).toBeCloseTo(10);
    expect(d.windows[0].box.y).toBeCloseTo(20);
    expect(d.windows[0].box).toMatchObject({ w: 50, h: 40 });
    expect(d.pieces[0].box.x).toBeCloseTo(5);
    expect(d.pieces[0].box).toMatchObject({ w: 50, h: 25 });
    expect(d.paperColor).toBe('#f599a6');
    expect(d.facing).toBe('portrait');
    expect(d.productName).toBe('Photo Frame | 6 x 8 in');
    expect(d.overlayUrl).toBe('https://files.example/frame.svg');
    expect(d.blocked).toEqual([]);
  });

  it('reads an opacity written as text, and a missing page colour as none', () => {
    const d = parseOnlineCanvasExport(exportOf([win(10, 10, 20, 20), art('https://f.example/a.svg', 0, 0, 10, 10, { opacity: '0.42' })], { printableAreaFill: undefined }));
    expect(d.pieces[0].opacity).toBeCloseTo(0.42);
    expect(d.paperColor).toBeNull();
  });

  it('puts every picture into the page artwork, with a hole for each window listed after it', () => {
    const d = parseOnlineCanvasExport(exportOf([
      art('https://f.example/pattern.svg', 0, 0, 152.4, 203.2),   // 0: under both windows
      block('#ffffff', 8, 18, 54, 44),                             // 1: under the first window only
      art('https://f.example/corner.png', 140, 190, 10, 10),       // 2: under nothing, but below the block's level? no: listed before a later under-piece
      block('#d32f2f', 78, 98, 44, 44),                            // 3: under the second window
      win(10, 20, 50, 40),                                         // 4
      win(80, 100, 40, 40),                                        // 5
      art('https://f.example/bear.png', 50, 50, 20, 20),           // 6: over the first window
    ]));
    expect(d.pieces.map(p => [p.index, p.layer, p.holes])).toEqual([
      [0, 'artwork', [4, 5]],
      [1, 'artwork', [4]],
      [2, 'artwork', []],
      [3, 'artwork', [5]],
      [6, 'artwork', []],
    ]);
    expect(d.pieces.map(p => p.kind)).toEqual(['vector', 'shape', 'raster', 'shape', 'raster']);
  });

  it('keeps a picture listed after a window whole: it is drawn over the photo, inside the same artwork', () => {
    const d = parseOnlineCanvasExport(exportOf([win(10, 10, 30, 30), art('https://f.example/a.svg', 0, 0, 152.4, 203.2, { locked: true })]));
    expect(d.pieces[0]).toMatchObject({ layer: 'artwork', holes: [] });
    expect(d.notes.some(n => /locked/.test(n.text))).toBe(false);
  });

  it('marks artwork that runs off the print area and leaves out what is wholly outside', () => {
    const d = parseOnlineCanvasExport(exportOf([
      win(10, 10, 30, 30),
      art('https://f.example/big.svg', -20, 150, 200, 100),
      art('https://f.example/gone.svg', -50, -50, 20, 20),
    ]));
    expect(d.pieces).toHaveLength(1);
    expect(d.pieces[0].overflows).toBe(true);
    expect(d.pieces[0].visible.x).toBeCloseTo(0);
    expect(d.pieces[0].visible.w).toBeCloseTo(152.4);
    expect(d.pieces[0].visible.h).toBeCloseTo(53.2);
    expect(d.notes.some(n => /1 hidden or empty object was left out/.test(n.text))).toBe(true);
  });

  it('turns a text box into a text with its size in print pixels', () => {
    const d = parseOnlineCanvasExport(exportOf([
      win(10, 40, 50, 40),
      { type: 'textbox', text: 'November 17, Saturday', fontFamily: 'Marck Script', fontSize: 8.4667, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left', lineHeight: 1.3, fill: 'rgb(48, 42, 24)', width: 100, height: 10, scaleX: 1, scaleY: 1, angle: 0, ...at(15, 12) },
    ]));
    const piece = d.pieces[0];
    expect(piece).toMatchObject({ kind: 'text', layer: 'overlay' });
    expect(piece.text).toMatchObject({ text: 'November 17, Saturday', fontFamily: 'Marck Script', color: '#302a18', align: 'left' });
    expect(piece.text?.fontSizePx).toBeCloseTo(100, 0);   // 8.4667 mm is 100 px at 300 dpi
    expect(fontsUsed(d)).toEqual(['Marck Script']);
    const overlay = textOverlayFor(d, piece);
    expect(overlay).toMatchObject({ textAlign: 'left', fontFamily: 'Marck Script', color: '#302a18', rotation: 0 });
    expect(overlay?.x).toBeCloseTo((15 / 152.4) * 100, 2);          // the left edge, for left-aligned text
    expect(overlay?.y).toBeCloseTo((17 / 203.2) * 100, 2);          // the box's middle
    expect(overlay?.width).toBeCloseTo((100 / 152.4) * 100, 2);
  });

  it('anchors centred text on its middle and says when a style is not carried over', () => {
    const d = parseOnlineCanvasExport(exportOf([
      win(10, 40, 50, 40),
      { type: 'textbox', text: 'Hello', fontFamily: 'Inter', fontSize: 5, fontWeight: 'bold', textAlign: 'center', fill: '#000', width: 60, height: 6, ...at(20, 10) },
    ]));
    expect(textOverlayFor(d, d.pieces[0])?.x).toBeCloseTo((50 / 152.4) * 100, 2);
    expect(d.notes.some(n => /bold or italic/.test(n.text))).toBe(true);
  });

  it('brings a tilted window in upright, at the same centre and size, and says so once', () => {
    // A quarter turn about the corner at (60, 10): the 30 x 30 box then lies to its left, centred on (45, 25).
    const d = parseOnlineCanvasExport(exportOf([
      win(60, 10, 30, 30, { angle: 90 }),
      win(50, 100, 40, 20, { angle: 30, originX: 'center', originY: 'center' }),   // placed by its centre
      win(10, 150, 30, 30),
    ]));
    expect(d.blocked).toEqual([]);
    const [turned, centred, plain] = [...d.windows].sort((a, b) => a.index - b.index);
    expect(turned.box.x).toBeCloseTo(30);
    expect(turned.box.y).toBeCloseTo(10);
    expect(turned.box).toMatchObject({ w: 30, h: 30 });
    expect(centred.box.x).toBeCloseTo(30);
    expect(centred.box.y).toBeCloseTo(90);
    expect(centred.box).toMatchObject({ w: 40, h: 20 });
    expect(plain.box.x).toBeCloseTo(10);
    const said = d.notes.filter(n => /tilted in the old design/.test(n.text));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ level: 'warning' });
    expect(said[0].text).toMatch(/^2 photo windows were tilted.*they come in straight, at the same centre and size/);
    const one = parseOnlineCanvasExport(exportOf([win(60, 10, 30, 30, { angle: 12 })]));
    expect(one.notes[0].text).toMatch(/^1 photo window was tilted.*it comes in straight/);
  });

  it('refuses what it cannot place rather than guessing', () => {
    const round = parseOnlineCanvasExport(exportOf([win(10, 10, 30, 30, { element: 'circle' })]));
    expect(round.blocked[0]).toMatch(/circle-shaped/);
    const none = parseOnlineCanvasExport(exportOf([art('https://f.example/a.svg', 0, 0, 10, 10)]));
    expect(none.blocked[0]).toMatch(/no photo window/);
    const turned = parseOnlineCanvasExport(exportOf([win(10, 10, 30, 30)], { clockwise_rotation_degree: 90 }));
    expect(turned.blocked[0]).toMatch(/turned canvas/);
  });

  it('leaves out rotated or mirrored artwork and unknown objects, and says so', () => {
    const d = parseOnlineCanvasExport(exportOf([
      win(10, 10, 30, 30),
      art('https://f.example/20200730_113904593323_4a09c4_Asset_9.svg', 50, 50, 20, 20, { angle: 30 }),
      art('https://f.example/flip.png', 50, 80, 20, 20, { flipX: true }),
      { type: 'path', width: 10, height: 10, ...at(0, 0) },
    ]));
    expect(d.pieces).toHaveLength(0);
    expect(d.notes.map(n => n.text).join('\n')).toMatch(/Asset_9\.svg was tilted[\s\S]*flip\.png was mirrored[\s\S]*'path'/);
  });

  it('says plainly when the text is not an export', () => {
    expect(() => parseOnlineCanvasExport('not json')).toThrow(DesignImportError);
    expect(() => parseOnlineCanvasExport('{"a":1}')).toThrow(/does not look like an export/);
    const twoSides = JSON.parse(exportOf([win(10, 10, 30, 30)]));
    twoSides[0].customized_locations_map['41'] = twoSides[0].customized_locations_map['40'];
    expect(() => parseOnlineCanvasExport(JSON.stringify(twoSides))).toThrow(/2 sides/);
  });
});

describe('the order photos fill the windows', () => {
  const box = (x: number, y: number, w = 30, h = 40) => ({ box: { x, y, w, h } });
  it('goes by rows from the top, left to right, whatever order they were drawn in', () => {
    const drawn = [box(100, 11), box(10, 75), box(55, 10.5), box(10, 10.9), box(10, 135)];
    expect(readingOrder(drawn).map(w => [w.box.x, w.box.y])).toEqual([[10, 10.9], [55, 10.5], [100, 11], [10, 75], [10, 135]]);
  });
  it('lets a tall window share a row with the short one beside it', () => {
    const drawn = [box(55, 72, 88, 124), box(10, 73, 41, 59), box(10, 134, 41, 59)];
    expect(readingOrder(drawn).map(w => w.box.x + w.box.y)).toEqual([83, 127, 144]);
  });
});

describe('the layout', () => {
  it('is the print area as the canvas with one print area per window, in reading order', () => {
    const d = parseOnlineCanvasExport(exportOf([win(80, 100, 40, 40), win(10, 20, 50, 40)]));
    const layout = layoutDefinitionFor(d, 'photo_frame_6x8_2_photos') as { canvas: Obj; frames: Obj[]; printSheet: Obj; name: string };
    expect(layout.name).toBe('photo_frame_6x8_2_photos');
    expect(layout.canvas).toEqual({ width: 1800, height: 2400, widthMm: 152.4, heightMm: 203.2, dpi: 300 });
    expect(layout.printSheet).toEqual({ mode: 'canvas' });
    expect(layout.frames.map(f => [f.xMm, f.yMm, f.widthMm, f.heightMm, f.bleedMm])).toEqual([[10, 20, 50, 40, 0], [80, 100, 40, 40, 0]]);
    expect(layout.frames[0].x as number).toBeCloseTo(10 / 152.4, 6);
    expect(layout.frames[0].height as number).toBeCloseTo(40 / 203.2, 6);
    expect(new Set(layout.frames.map(f => f.id)).size).toBe(2);
  });
  it('suggests a name from the product, its size and the number of photos', () => {
    const d = parseOnlineCanvasExport(exportOf([win(10, 20, 50, 40), win(80, 100, 40, 40), win(80, 20, 40, 40)]));
    expect(suggestNames(d)).toEqual({ name: 'photo_frame_6x8_3_photos', displayName: 'Photo Frame 6 x 8 in, 3 photos' });
  });
});

describe('reading an SVG file', () => {
  it('takes the viewBox, the root attributes and the inside, leaving the prolog and DOCTYPE behind', () => {
    const parts = readSvg('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "x" "y"><!-- <svg nope> --><svg id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 349.55 229.75" style="enable-background:new" width="10"><path d="M0 0"/></svg>');
    expect(parts?.viewBox).toEqual([0, 0, 349.55, 229.75]);
    expect(parts?.attrs).toEqual([['style', 'enable-background:new']]);
    expect(parts?.namespaces).toEqual([['xmlns:xlink', 'http://www.w3.org/1999/xlink']]);
    expect(parts?.inner).toBe('<path d="M0 0"/>');
  });
  it('falls back to width and height, and gives up without a size', () => {
    expect(readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="395px" height="200"><rect/></svg>')?.viewBox).toEqual([0, 0, 395, 200]);
    expect(readSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBeNull();
    expect(readSvg('<div/>')).toBeNull();
  });
});

describe('keeping two drawings apart in one document', () => {
  it('prefixes ids and classes everywhere they are used, and nothing else', () => {
    const out = scopeSvg('<svg><defs><style>.cls-1{fill:#f05773;opacity:0.25}#grad{x:1}</style><linearGradient id="grad"/></defs><path class="cls-1 b" fill="url(#grad)"/><use xlink:href="#grad"/><rect fill="#fad"/></svg>', 'p3');
    expect(out).toContain('.p3-cls-1{fill:#f05773;opacity:0.25}');
    expect(out).toContain('#p3-grad{x:1}');
    expect(out).toContain('id="p3-grad"');
    expect(out).toContain('class="p3-cls-1 p3-b"');
    expect(out).toContain('fill="url(#p3-grad)"');
    expect(out).toContain('xlink:href="#p3-grad"');
    expect(out).toContain('fill="#fad"');
  });
  it('leaves markup without ids or classes alone', () => {
    expect(scopeSvg('<rect fill="#fff"/>', 'p1')).toBe('<rect fill="#fff"/>');
  });
});

describe('the page artwork', () => {
  const design = () => parseOnlineCanvasExport(exportOf([
    art('https://f.example/pattern.svg', -10, -10, 172.4, 223.2, { opacity: 0.5 }),   // 0: runs off every side
    block('#ffffff', 8, 18, 54, 44),                                                    // 1
    art('https://f.example/tree.png', 0, 100, 152.4, 103.2),                            // 2
    win(10, 20, 50, 40),                                                                // 3
    win(80, 120, 40, 40),                                                               // 4
    art('https://f.example/bear.png', 50, 50, 20, 20),                                  // 5
  ]));

  it('stacks every piece that was under a window on one sheet, each with its holes', () => {
    const d = design();
    const sources = new Map<number, ArtworkSource>([[0, svg(HEART)], [2, { kind: 'png', bytes: pngHeader(640, 624) }], [5, { kind: 'png', bytes: pngHeader(162, 167) }]]);
    const { svg: doc, missing } = buildPageArtwork(d, sources);
    expect(missing).toEqual([]);
    expect(doc).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink" viewBox="0 0 1800 2400" width="1800" height="2400">/);
    // The pattern: clipped around both windows, at half strength, placed where it was (off the sheet's edge).
    const inset = mmToImportPx(HOLE_INSET_MM);
    const hole = `M${Math.round((mmToImportPx(10) + inset) * 1000) / 1000} ${Math.round((mmToImportPx(20) + inset) * 1000) / 1000}h`;
    expect(doc).toContain(`<clipPath id="pe-holes-0"><path clip-rule="evenodd" d="M0 0H1800V2400H0Z${hole}`);
    expect(doc).toContain('<g clip-path="url(#pe-holes-0)" opacity="0.5"><svg x="-118.11" y="-118.11"');
    expect(doc).toContain('viewBox="0 0 100 50" preserveAspectRatio="none"');
    // The colour block: its own rectangle, with one hole.
    expect(doc).toContain('<g clip-path="url(#pe-holes-1)"><svg');
    expect(doc).toContain('data-custom-shape="rect"');
    // The raster: carried inside the document, clipped around the second window only.
    expect(doc).toContain('<g clip-path="url(#pe-holes-2)"><image');
    expect(doc).toContain('href="data:image/png;base64,iVBORw0KGgo');
    expect((doc?.match(/<clipPath /g) ?? []).length).toBe(3);
    // The bear sat above the photos: in the same sheet, last, with no hole.
    expect(doc).not.toContain('pe-holes-5');
    expect(doc).toMatch(/<g><image [^>]*\/><\/g><\/svg>$/);
  });

  it('keeps two vector files from restyling each other', () => {
    const d = parseOnlineCanvasExport(exportOf([
      art('https://f.example/a.svg', 0, 0, 152.4, 203.2),
      art('https://f.example/b.svg', 0, 0, 152.4, 203.2),
      win(10, 20, 50, 40),
    ]));
    const { svg: doc } = buildPageArtwork(d, new Map<number, ArtworkSource>([[0, svg(HEART)], [1, svg(HEART)]]));
    expect(doc).toContain('.p0-cls-1{fill:#f05773;}');
    expect(doc).toContain('.p1-cls-1{fill:#f05773;}');
    expect(doc).toContain('xlink:href="#p1-heart"');
  });

  it('reports a piece whose file could not be read and builds the rest', () => {
    const d = design();
    const { svg: doc, missing } = buildPageArtwork(d, new Map<number, ArtworkSource>([[0, svg('<div/>')]]));
    expect(missing.map(p => p.index)).toEqual([0, 2, 5]);
    expect(doc).toContain('data-custom-shape="rect"');
  });

  it('draws a picture that sat over a photo with no hole', () => {
    const d = parseOnlineCanvasExport(exportOf([win(10, 20, 50, 40), art('https://f.example/hearts.svg', 0, 0, 152.4, 203.2)]));
    const { svg: doc } = buildPageArtwork(d, new Map([[1, svg(HEART)]]));
    expect(doc).toContain('<g><svg x="0" y="0"');
    expect(doc).not.toContain('clipPath');
  });

  it('is nothing when the design has no picture', () => {
    const d = parseOnlineCanvasExport(exportOf([win(10, 20, 50, 40)]));
    expect(buildPageArtwork(d, new Map())).toEqual({ svg: null, missing: [] });
  });
});

describe('the design re-cut to the layout as saved', () => {
  const read = () => parseOnlineCanvasExport(exportOf([
    block('#ffffff', 8, 18, 54, 44),                         // 0: under the window
    win(10, 20, 50, 40),                                     // 1
    art('https://f.example/hearts.svg', 0, 0, 152.4, 203.2), // 2: over it
  ]));
  const frame = (x: number, y: number, w: number, h: number, W = 152.4, H = 203.2) => ({ x: x / W, y: y / H, width: w / W, height: h / H });

  it('moves the hole with the print area and keeps the old stacking', () => {
    const d = withLayoutGeometry(read(), { canvas: { widthMm: 152.4, heightMm: 203.2 }, frames: [frame(12, 22, 46, 36)] });
    expect(d.windows).toHaveLength(1);
    expect(d.windows[0].index).toBe(1);
    expect(d.windows[0].box.x).toBeCloseTo(12);
    expect(d.windows[0].box.w).toBeCloseTo(46);
    expect(d.pieces.map(p => [p.index, p.holes])).toEqual([[0, [1]], [2, []]]);
    const { svg: doc } = buildPageArtwork(d, new Map([[2, svg(HEART)]]));
    const inset = mmToImportPx(HOLE_INSET_MM);
    expect(doc).toContain(`M${Math.round((mmToImportPx(12) + inset) * 1000) / 1000} ${Math.round((mmToImportPx(22) + inset) * 1000) / 1000}h`);
  });

  it('cuts a print area added in the layout editor out of every picture it touches', () => {
    const d = withLayoutGeometry(read(), { canvas: { widthMm: 152.4, heightMm: 203.2 }, frames: [frame(10, 20, 50, 40), frame(80, 100, 40, 40)] });
    expect(d.pieces.map(p => p.holes)).toEqual([[1], [1_000_001]]);
  });

  it('follows a resized canvas: pieces keep their place from the top-left corner and are cropped to it', () => {
    const d = withLayoutGeometry(read(), { canvas: { widthMm: 100, heightMm: 150 }, frames: [frame(10, 20, 50, 40, 100, 150)] });
    expect(d.printMm).toEqual({ width: 100, height: 150 });
    expect(d.canvasPx).toEqual({ width: 1181, height: 1772 });
    expect(d.pieces[1].visible).toMatchObject({ x: 0, y: 0, w: 100, h: 150 });
    expect(d.pieces[1].overflows).toBe(true);
    expect(d.blocked).toEqual([]);
  });

  it('refuses a layout left with no print area', () => {
    const d = withLayoutGeometry(read(), { canvas: { widthMm: 152.4, heightMm: 203.2 }, frames: [] });
    expect(d.blocked).toEqual(['The layout has no print area, so there is nothing to cut the artwork to.']);
  });

  it('gives the guide picture: every picture whole', () => {
    const { svg: doc } = buildPageArtwork(withoutWindows(read()), new Map([[2, svg(HEART)]]));
    expect(doc).toContain('data-custom-shape="rect"');
    expect(doc).not.toContain('clipPath');
  });
});

describe('the frame overlay', () => {
  it('shows the middle of the old canvas that is the print area', () => {
    const d = parseOnlineCanvasExport(exportOf([win(10, 20, 50, 40)]));
    const doc = frameOverlaySvg(d, svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 468 612"><rect width="54" height="612"/></svg>'));
    expect(doc).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1800 2400" width="1800" height="2400">/);
    expect(doc).toContain('<svg x="-150" y="-150" width="2100" height="2700" viewBox="0 0 468 612" preserveAspectRatio="none">');
  });
});

describe('small helpers', () => {
  it('reads colours', () => {
    expect(hexColor('#FFF')).toBe('#ffffff');
    expect(hexColor('#0C1D31')).toBe('#0c1d31');
    expect(hexColor('rgb(0,0,0)')).toBe('#000000');
    expect(hexColor('rgba(255, 220, 220, 0.5)')).toBe('#ffdcdc');
    expect(hexColor('red')).toBeNull();
    expect(hexColor(undefined)).toBeNull();
  });
  it('turns bytes into base64 and back', () => {
    for (const len of [0, 1, 2, 3, 4, 255]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37) % 256);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });
  it('reads an inline SVG however it was stored', () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="100%"/></svg>';
    expect(inlineSvgOf(`data:image/svg+xml;utf8,${markup}`)).toBe(markup);
    expect(inlineSvgOf(`data:image/svg+xml,${encodeURIComponent(markup)}`)).toBe(markup);
    expect(inlineSvgOf(`data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(markup))}`)).toBe(markup);
    expect(inlineSvgOf('https://f.example/a.svg')).toBeNull();
  });
  it('tells what a file is and how big a raster is', () => {
    expect(sniffArtwork(pngHeader(1, 1))).toBe('png');
    expect(sniffArtwork(jpegHeader(1, 1))).toBe('jpeg');
    expect(sniffArtwork(new TextEncoder().encode('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'))).toBe('svg');
    expect(sniffArtwork(new TextEncoder().encode('<html>'))).toBeNull();
    expect(rasterSize(pngHeader(640, 624))).toEqual({ width: 640, height: 624 });
    expect(rasterSize(jpegHeader(800, 600))).toEqual({ width: 800, height: 600 });
    expect(rasterSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it('works out the dots per inch of a raster at its placed size', () => {
    expect(placedDpi(640, 202.3)).toBe(80);
    expect(placedDpi(1800, 152.4)).toBe(300);
    expect(placedDpi(100, 0)).toBe(0);
  });
});
