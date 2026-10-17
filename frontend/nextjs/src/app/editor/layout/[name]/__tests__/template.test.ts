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
  markEditedTemplateOverlays, seedCard, templateColours, templateOverlays, templateSide, toSavedTemplate, type LayoutTemplate,
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
