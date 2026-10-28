/**
 * template.ts — copying a layout template's decoration onto cards.
 *
 * Pins: a card starts with the template's side for its surface; every copied
 * overlay carries the template tag, a fresh id and an absolute sticker
 * address; applying a template to existing cards replaces only template
 * overlays and keeps photos and the customer's own work; template
 * decoration never counts as an edit the re-pick confirm must protect,
 * until the customer changes it in the canvas editor.
 */
import {
  applyTemplateToCard, applyTemplateToCards, customerDecoration, isLayoutTemplate, isTemplateOverlay,
  markEditedTemplateOverlays, placeOverlay, seedCard, surfaceGeometry, templateColours, templateOverlays, templateSide,
  toSavedTemplate, type LayoutTemplate,
} from '../layout-template';
import { canvasHasRealEdits, countCanvasesLosingEdits } from '../canvas-merge';
import type { CanvasItem, Overlay } from '../types';

const TEXT: Overlay = { type: 'text', id: 't1', text: 'Happy Birthday', x: 50, y: 8, fontSize: 72, color: '#64318E', fontFamily: 'Lobster', textAlign: 'center', rotation: 0 };
const STICKER: Overlay = { type: 'image', id: 's1', source: 'clipart', src: '/api/templates/assets/sticker_abc.png', label: 'balloon', x: 5, y: 80, width: 15, height: 15, rotation: 0, opacity: 1 };

const TEMPLATE: LayoutTemplate = {
  id: 'retro-birthday', layoutName: 'classic_4x6', displayName: 'Retro Birthday', thumbnailUrl: null,
  decoration: { surfaces: {
    default: { bgColor: '#fff4e6', overlays: [TEXT, STICKER] },
    back: { overlays: [] },
  } },
};

const photo = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
const card = (over: Partial<CanvasItem> = {}): CanvasItem => ({
  id: 0, frames: [{ id: 0, originalFile: photo, offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover' }],
  overlays: [], bgColor: '#ffffff', paperColor: '#ffffff', dataUrl: 'data:old', ...over,
});

describe('templateSide', () => {
  it('finds the side by surface key, then default, then the only side', () => {
    expect(templateSide(TEMPLATE.decoration, 'back')?.overlays).toEqual([]);
    expect(templateSide(TEMPLATE.decoration, 'front')?.bgColor).toBe('#fff4e6');
    expect(templateSide({ surfaces: { only: { overlays: [TEXT] } } }, 'front')?.overlays).toEqual([TEXT]);
    expect(templateSide({ surfaces: { a: { overlays: [] }, b: { overlays: [] } } }, 'c')).toBeNull();
    expect(templateSide(null, 'default')).toBeNull();
  });
});

describe('templateOverlays / seedCard', () => {
  it('copies the side with the template tag, fresh ids and absolute sticker addresses', () => {
    const copies = templateOverlays(TEMPLATE, 'default');
    expect(copies).toHaveLength(2);
    expect(copies.every(isTemplateOverlay)).toBe(true);
    expect(copies.map(o => o.templateId)).toEqual(['retro-birthday', 'retro-birthday']);
    expect(copies[0].id).not.toBe(TEXT.id);
    const again = templateOverlays(TEMPLATE, 'default');
    expect(again[0].id).not.toBe(copies[0].id);
    const sticker = copies[1];
    expect(sticker.type === 'image' && sticker.src).toBe(`${window.location.origin}/api/templates/assets/sticker_abc.png`);
    // Deep copies: editing a card's overlay never touches the template.
    (copies[0] as { text: string }).text = 'changed';
    expect(TEXT.text).toBe('Happy Birthday');
  });

  it('seeds a new card with the template colours and overlays, white where the template is silent', () => {
    expect(seedCard(TEMPLATE, 'default')).toMatchObject({ bgColor: '#fff4e6', paperColor: '#ffffff' });
    expect(seedCard(TEMPLATE, 'default').overlays).toHaveLength(2);
    expect(seedCard(TEMPLATE, 'back')).toEqual({ overlays: [], bgColor: '#ffffff', paperColor: '#ffffff' });
    expect(seedCard(null, 'default')).toEqual({ overlays: [], bgColor: '#ffffff', paperColor: '#ffffff' });
    expect(templateColours(undefined, 'default')).toEqual({ bgColor: '#ffffff', paperColor: '#ffffff' });
  });
});

describe('applyTemplateToCard(s)', () => {
  const own: Overlay = { type: 'text', id: 'mine', text: 'Love, Mum', x: 50, y: 90, fontSize: 40, color: '#000000', fontFamily: 'Inter', textAlign: 'center', rotation: 0 };

  it('replaces previous template overlays, keeps the photo and the customer’s own work, and drops the stale preview', () => {
    const old = applyTemplateToCard(card(), TEMPLATE, 'default');
    const withOwn = { ...old, overlays: [...old.overlays, own] };
    const other: LayoutTemplate = { ...TEMPLATE, id: 'minimal', decoration: { surfaces: { default: { overlays: [TEXT], paperColor: '#eeeeee' } } } };
    const next = applyTemplateToCard(withOwn, other, 'default');
    expect(next.frames).toBe(withOwn.frames);
    expect(next.overlays.map(o => o.templateId ?? 'own')).toEqual(['minimal', 'own']);
    expect(next.overlays[1]).toBe(own);
    expect(next).toMatchObject({ bgColor: '#ffffff', paperColor: '#eeeeee', dataUrl: null });
  });

  it('with null strips the template and returns the card to white', () => {
    const decorated = { ...applyTemplateToCard(card(), TEMPLATE, 'default'), overlays: [...templateOverlays(TEMPLATE, 'default'), own] };
    const bare = applyTemplateToCards([decorated], null, 'default')[0];
    expect(bare.overlays).toEqual([own]);
    expect(bare).toMatchObject({ bgColor: '#ffffff', paperColor: '#ffffff' });
  });
});

describe('template decoration is not a customer edit', () => {
  it('canvasHasRealEdits ignores template overlays and template colours, but not the customer’s', () => {
    const decorated = applyTemplateToCard(card(), TEMPLATE, 'default');
    expect(canvasHasRealEdits(decorated, TEMPLATE, 'default')).toBe(false);
    // Without the template in hand the same card reads as edited, as before.
    expect(canvasHasRealEdits(decorated)).toBe(true);
    expect(canvasHasRealEdits({ ...decorated, bgColor: '#000000' }, TEMPLATE, 'default')).toBe(true);
    const own: Overlay = { type: 'text', id: 'mine', text: 'x', x: 1, y: 1, fontSize: 10, color: '#000000', fontFamily: 'Inter', textAlign: 'left', rotation: 0 };
    expect(canvasHasRealEdits({ ...decorated, overlays: [...decorated.overlays, own] }, TEMPLATE, 'default')).toBe(true);
    expect(customerDecoration(decorated, TEMPLATE, 'default')).toEqual({ overlays: [], bgChanged: false, paperChanged: false });
  });

  it('countCanvasesLosingEdits does not warn about a card that only carries its template', () => {
    const decorated = applyTemplateToCard(card(), TEMPLATE, 'default');
    const other = new File(['y'], 'b.jpg', { type: 'image/jpeg' });
    expect(countCanvasesLosingEdits([decorated], [other], TEMPLATE, 'default')).toBe(0);
    expect(countCanvasesLosingEdits([decorated], [other])).toBe(1);
  });
});

describe('a template overlay the customer changed is their work', () => {
  const textOf = (c: CanvasItem) => c.overlays.find(o => o.type === 'text') as Extract<Overlay, { type: 'text' }>;
  const withText = (c: CanvasItem, patch: Record<string, unknown>): CanvasItem => ({
    ...c, overlays: c.overlays.map(o => (o.type === 'text' ? { ...o, ...patch } as Overlay : o)),
  });

  it('marks only the template overlays that differ from when the editor opened', () => {
    const decorated = applyTemplateToCard(card(), TEMPLATE, 'default');
    const edited = withText(decorated, { text: 'Happy Birthday Riya' });
    const out = markEditedTemplateOverlays(decorated.overlays, edited.overlays);
    expect(out.find(o => o.type === 'text')?.templateEdited).toBe(true);
    expect(out.find(o => o.type === 'image')?.templateEdited).toBeUndefined();
    // Still template decoration: the tag stays, so a re-apply replaces it.
    expect(out.every(isTemplateOverlay)).toBe(true);
  });

  it('ignores the rounding the canvas editor does when it writes a position back', () => {
    const decorated = applyTemplateToCard(card(), TEMPLATE, 'default');
    const nudged = withText(decorated, { x: textOf(decorated).x + 0.04 });
    expect(markEditedTemplateOverlays(decorated.overlays, nudged.overlays).some(o => o.templateEdited)).toBe(false);
    const moved = withText(decorated, { x: textOf(decorated).x + 3 });
    expect(markEditedTemplateOverlays(decorated.overlays, moved.overlays).some(o => o.templateEdited)).toBe(true);
  });

  it('leaves the customer’s own overlays and an unchanged card alone', () => {
    const decorated = applyTemplateToCard(card(), TEMPLATE, 'default');
    const own: Overlay = { type: 'text', id: 'mine', text: 'x', x: 1, y: 1, fontSize: 10, color: '#000000', fontFamily: 'Inter', textAlign: 'left', rotation: 0 };
    const out = markEditedTemplateOverlays(decorated.overlays, [...decorated.overlays, own]);
    expect(out.some(o => o.templateEdited)).toBe(false);
    expect(out.at(-1)).toBe(own);
  });

  it('the re-pick confirm protects an edited template overlay; a re-apply still replaces it', () => {
    const decorated = applyTemplateToCard(card(), TEMPLATE, 'default');
    const edited = { ...decorated, overlays: markEditedTemplateOverlays(decorated.overlays, withText(decorated, { text: 'Happy Birthday Riya' }).overlays) };
    expect(canvasHasRealEdits(edited, TEMPLATE, 'default')).toBe(true);
    const other = new File(['y'], 'b.jpg', { type: 'image/jpeg' });
    expect(countCanvasesLosingEdits([edited], [other], TEMPLATE, 'default')).toBe(1);
    const reapplied = applyTemplateToCard(edited, TEMPLATE, 'default');
    expect(reapplied.overlays.filter(o => o.type === 'text')).toHaveLength(1);
    expect(textOf(reapplied).text).toBe('Happy Birthday');
    expect(textOf(reapplied).templateEdited).toBeUndefined();
  });
});

describe('shape guards', () => {
  it('recognises a served template and reduces it to what the autosave keeps', () => {
    expect(isLayoutTemplate(TEMPLATE)).toBe(true);
    expect(isLayoutTemplate({ id: 'x', displayName: 'x' })).toBe(false);
    expect(isLayoutTemplate(null)).toBe(false);
    expect(toSavedTemplate(TEMPLATE)).toEqual({ id: 'retro-birthday', displayName: 'Retro Birthday', decoration: TEMPLATE.decoration });
  });
});

describe('placing a shared template on another layout with the same window box', () => {
  // A 4x6 window with 0.3 in bleed (116.84 x 167.64 mm) centred in a 6x8
  // canvas (a 1-inch frame picture) and in a 5x7 canvas (a half-inch one),
  // both at 10 px/mm. Same numbers as the parity fixture.
  const oneInch = {
    canvas: { width: 1524, height: 2032, widthMm: 152.4, heightMm: 203.2 },
    frames: [{ x: 0.1166666667, y: 0.0875, width: 0.7666666667, height: 0.825, bleedMm: 7.62 }],
  };
  const halfInch = {
    canvas: { width: 1270, height: 1778, widthMm: 127, heightMm: 177.8 },
    frames: [{ x: 0.04, y: 0.0285714286, width: 0.92, height: 0.9428571429, bleedMm: 7.62 }],
  };
  const home = surfaceGeometry(oneInch)!;
  const target = surfaceGeometry(halfInch)!;
  const shared: LayoutTemplate = {
    ...TEMPLATE, id: 'shared', layoutName: 'frame_1in', alsoOn: ['frame_half'],
    decoration: { ...TEMPLATE.decoration, authoredOn: { layout: 'frame_1in', surfaces: { default: home } } },
  };

  it('reads a side\'s geometry the way the server stamps it', () => {
    expect(home).toEqual({
      canvas: { width: 1524, height: 2032, widthMm: 152.4, heightMm: 203.2 },
      windowBox: { xMm: 17.78, yMm: 17.78, widthMm: 116.84, heightMm: 167.64 },
    });
    expect(surfaceGeometry({ canvas: { width: 100, height: 100 }, frames: [] })?.windowBox).toBeNull();
    expect(surfaceGeometry(null)).toBeNull();
  });

  it('keeps the same millimetres from the window box centre, so the art lands in the same place on both frames', () => {
    const text = placeOverlay(TEXT, home, target);
    // 8% of 203.2 mm is 16.256 mm from the top: 85.344 mm above the centre; on the 177.8 mm canvas that is 2%.
    expect(text).toMatchObject({ x: 50, y: 2, fontSize: 72 });
    const sticker = placeOverlay(STICKER, home, target);
    // 15% of 152.4 mm = 22.86 mm wide, which is 18% of 127 mm.
    expect(sticker).toMatchObject({ width: 18, height: 17.143 });
    // 5% of 152.4 = 7.62 mm from the left: 68.58 mm left of centre; on 127 mm that is 63.5 - 68.58 = -5.08 mm → -4%.
    expect(sticker.x).toBe(-4);
    // Round trip: placing back onto the home geometry restores the original numbers.
    expect(placeOverlay(sticker, target, home)).toMatchObject({ x: 5, y: 80, width: 15, height: 15 });
  });

  it('is the identity on the home layout, and leaves an overlay alone without a usable geometry', () => {
    expect(placeOverlay(STICKER, home, home)).toEqual(STICKER);
    expect(placeOverlay(STICKER, home, null)).toBe(STICKER);
    expect(placeOverlay(STICKER, null, target)).toBe(STICKER);
    const noMm = { canvas: { width: 1000, height: 1000, widthMm: 0, heightMm: 0 }, windowBox: null };
    expect(placeOverlay(STICKER, home, noMm)).toBe(STICKER);
  });

  it('splits a fraction-of-a-millimetre size difference evenly to both edges', () => {
    // Two boxes that key the same (117x168) but differ by 0.16 mm in width.
    const wider = { ...target, windowBox: { xMm: 5, yMm: 5, widthMm: 117, heightMm: 168 } };
    const atLeftEdge: Overlay = { ...STICKER, x: (17.78 / 152.4) * 100, width: 1 };
    const placed = placeOverlay(atLeftEdge, home, wider);
    const leftMm = (placed.x / 100) * 127;
    expect(leftMm).toBeCloseTo(5.08, 2);   // 0.08 mm in from the box edge at 5 mm …
    const atRightEdge: Overlay = { ...STICKER, x: ((17.78 + 116.84) / 152.4) * 100, width: 1 };
    const rightMm = (placeOverlay(atRightEdge, home, wider).x / 100) * 127;
    expect(rightMm).toBeCloseTo(122 - 0.08, 2);   // … and 0.08 mm in from the other edge at 122 mm.
  });

  it('scales print-pixel sizes when the layouts differ in pixels per millimetre', () => {
    const denser = { ...target, canvas: { ...target.canvas, width: 1500, height: 2100 } }; // ≈11.81 px/mm
    const text = placeOverlay({ ...TEXT, width: 80 }, home, denser) as Extract<Overlay, { type: 'text' }>;
    expect(text.fontSize).toBeCloseTo(72 * (1500 / 127) / 10, 2);
    expect(text.width).toBe(96);   // 80% of 152.4 mm is 121.92 mm: 96% of 127 mm
    const shape: Overlay = { type: 'shape', id: 'sh', shapeType: 'rect', x: 10, y: 10, width: 20, height: 20, rotation: 0, fill: '#ff0000', stroke: '#000000', strokeWidth: 10, opacity: 1 };
    expect((placeOverlay(shape, home, denser) as Extract<Overlay, { type: 'shape' }>).strokeWidth).toBeCloseTo(11.811, 2);
  });

  it('places template overlays and seeds a card for the layout the customer is on', () => {
    const placed = templateOverlays(shared, 'default', target);
    expect(placed.map(o => o.y)).toEqual([2, placeOverlay(STICKER, home, target).y]);
    expect(placed.every(isTemplateOverlay)).toBe(true);
    expect(seedCard(shared, 'default', target).overlays[0]).toMatchObject({ y: 2 });
    // Without a target, or on a template saved before sharing (no stamp), the numbers are as stored.
    expect(templateOverlays(shared, 'default')[0]).toMatchObject({ y: 8 });
    expect(templateOverlays(TEMPLATE, 'default', target)[0]).toMatchObject({ y: 8 });
    expect(applyTemplateToCards([card()], shared, 'default', target)[0].overlays[0]).toMatchObject({ y: 2 });
  });
});
