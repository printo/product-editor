/**
 * template-authoring.ts — what ops draw on a blank card becomes a template.
 */
import {
  authoredOnFor, blankCard, dataUrlToPngFile, decorationFromCards, groupBySize, ineligibleTicked, isEmptyDecoration, isTemplateId,
  localImageOverlays, nearMissLayouts, sameBoxLayouts, sizeLabel, slugFromName, withoutPhotos, type TemplateCandidate,
} from '../template-authoring';
import { surfaceGeometry } from '../layout-template';
import type { SurfaceDefinition } from '@/lib/layout-utils';
import type { CanvasItem, Overlay } from '../types';

const DEF: SurfaceDefinition = {
  key: 'default', label: 'Front', canvas: { width: 1800, height: 1200 }, maskUrl: null, maskOnExport: false,
  frameMaskUrl: null, artworkMaskUrl: null, printSheet: { mode: 'canvas' },
  frames: [{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, { x: 0, y: 0, width: 0.2, height: 0.2 }] as SurfaceDefinition['frames'],
};
const TEXT: Overlay = { type: 'text', id: 't1', templateId: 'old', templateEdited: true, text: 'Hi', x: 50, y: 10, fontSize: 60, color: '#000000', fontFamily: 'Inter', textAlign: 'center', rotation: 0 };
const photo = new File(['x'], 'sample.jpg', { type: 'image/jpeg' });

describe('ids', () => {
  it('derives a slug from the display name and validates it', () => {
    expect(slugFromName('Retro Birthday!')).toBe('retro-birthday');
    expect(slugFromName('  --Minimal__2026 ')).toBe('minimal-2026');
    expect(isTemplateId('retro-birthday')).toBe(true);
    expect(isTemplateId('Retro')).toBe(false);
    expect(isTemplateId('')).toBe(false);
  });
});

describe('blankCard / withoutPhotos', () => {
  it('builds one empty frame per layout frame, with the side’s decoration and an optional sample photo', () => {
    const bare = blankCard(DEF, null);
    expect(bare.frames.map(f => f.originalFile)).toEqual([null, null]);
    expect(bare).toMatchObject({ overlays: [], bgColor: '#ffffff', paperColor: '#ffffff', surfaceKey: 'default' });
    const decorated = blankCard(DEF, { surfaces: { default: { bgColor: '#fff4e6', overlays: [TEXT] } } }, photo);
    expect(decorated.frames.every(f => f.originalFile === photo && f.fillStyle === 'blur')).toBe(true);
    expect(decorated.overlays).toHaveLength(1);
    expect(decorated.overlays[0]).not.toBe(TEXT);
    expect(withoutPhotos(decorated).frames.every(f => f.originalFile === null)).toBe(true);
  });
});

describe('decorationFromCards', () => {
  const local: Overlay = { type: 'image', id: 'u1', source: 'local', src: 'blob:x', originalFile: photo, fileId: 'f-1', label: 'sample', x: 1, y: 1, width: 10, height: 10, rotation: 0, opacity: 1 };
  const icon: Overlay = { type: 'image', id: 'i1', source: 'icon', src: 'https://api.iconify.design/mdi/cake.svg', label: 'cake', x: 1, y: 1, width: 10, height: 10, rotation: 0, opacity: 1 };
  const card = (over: Partial<CanvasItem>): CanvasItem => ({ ...blankCard(DEF, null), ...over });

  it('keeps text, icons and uploaded stickers, drops the template tag and any customer-file fields', () => {
    const stickers = new Map([['default', new Map([[1, '/api/templates/assets/sticker_abc.png']])]]);
    const deco = decorationFromCards([{ key: 'default', card: card({ overlays: [TEXT, local, icon], bgColor: '#fff4e6' }) }], stickers);
    const side = deco.surfaces.default;
    expect(side.bgColor).toBe('#fff4e6');
    expect(side.paperColor).toBeUndefined();
    expect(side.overlays.map(o => o.type)).toEqual(['text', 'image', 'image']);
    expect('templateId' in side.overlays[0]).toBe(false);
    expect('templateEdited' in side.overlays[0]).toBe(false);
    expect(side.overlays[1]).toMatchObject({ source: 'clipart', src: '/api/templates/assets/sticker_abc.png' });
    expect('originalFile' in side.overlays[1]).toBe(false);
    expect('fileId' in side.overlays[1]).toBe(false);
    expect(side.overlays[2]).toMatchObject({ source: 'icon', src: icon.type === 'image' ? icon.src : '' });
  });

  it('leaves out a local image that was never uploaded, keeps blank sides, and knows an empty decoration', () => {
    expect(localImageOverlays(card({ overlays: [TEXT, local] }))).toEqual([{ index: 1, file: photo }]);
    const deco = decorationFromCards([
      { key: 'front', card: card({ overlays: [local] }) },
      { key: 'back', card: card({}) },
    ]);
    expect(deco.surfaces.front.overlays).toEqual([]);
    expect(deco.surfaces.back).toEqual({ overlays: [] });
    expect(isEmptyDecoration(deco)).toBe(true);
    expect(isEmptyDecoration(decorationFromCards([{ key: 'front', card: card({ paperColor: '#eeeeee' }) }]))).toBe(false);
  });
});

describe('sharing a template across layouts with the same print areas', () => {
  // Boxes in mm; keys are the server's (rounded to the mm, bleed included for `window`).
  const box = (wh: [number, number] | null) => (wh ? { xMm: 0, yMm: 0, widthMm: wh[0], heightMm: wh[1] } : null);
  const key = (wh: [number, number] | null) => (wh ? `${Math.round(wh[0])}x${Math.round(wh[1])}` : null);
  const cand = (name: string, displayName: string, win: [number, number] | null, area: [number, number] | null, bleedMm: number, templateCount = 0, surfaceKeys = ['default']): TemplateCandidate => ({
    name, displayName, bleedMm, templateCount, surfaceKeys,
    windowBox: box(win), windowKey: key(win), printAreaBox: box(area), printAreaKey: key(area),
  });
  const FOUR_BY_SIX: [number, number] = [101.6, 152.4];
  const candidates = [
    cand('frame_1in', 'Frame one-inch', [116.84, 167.64], FOUR_BY_SIX, 7.62, 1),
    cand('frame_half', 'Frame half-inch', [116.84, 167.64], FOUR_BY_SIX, 7.62),
    cand('thin', 'Thin bleed', [111.6, 162.4], FOUR_BY_SIX, 5),
    cand('print', 'Print 4x6', FOUR_BY_SIX, FOUR_BY_SIX, 0),
    cand('bare', 'Bare', null, null, 0),
    // Same size, but two sides: the decoration is drawn per side, so not a match.
    cand('card', 'Folded card', [116.84, 167.64], FOUR_BY_SIX, 7.62, 0, ['front', 'back']),
  ];

  it('labels a size in inches as the print areas plus their bleed, the bleed only when there is one', () => {
    expect(sizeLabel(candidates[0])).toBe('4 × 6 in, 0.3 in bleed');
    expect(sizeLabel(candidates[2])).toBe('4 × 6 in, 0.2 in bleed');
    expect(sizeLabel(candidates[3])).toBe('4 × 6 in');
    expect(sizeLabel(candidates[4])).toBe('no print areas');
  });

  it('groups layouts by size for the Create picker, smallest size first, no print areas last', () => {
    const groups = groupBySize(candidates);
    expect(groups.map(g => g.key)).toEqual(['102x152', '112x162', '117x168', 'none']);
    expect(groups[2].layouts.map(c => c.name)).toEqual(['card', 'frame_half', 'frame_1in']);
    expect(groups[0].label).toBe('4 × 6 in');
    expect(groups[1].label).toBe('4 × 6 in, 0.2 in bleed');
    expect(groups[2].label).toBe('4 × 6 in, 0.3 in bleed');
    expect(groups[3].label).toBe('No print areas');
  });

  it('offers the other layouts with the same size and sides, and names the near-misses that differ only in bleed', () => {
    expect(sameBoxLayouts(candidates, 'frame_1in').map(c => c.name)).toEqual(['frame_half']);
    expect(sameBoxLayouts(candidates, 'card')).toEqual([]);
    expect(sameBoxLayouts(candidates, 'bare')).toEqual([]);
    expect(sameBoxLayouts(candidates, 'missing')).toEqual([]);
    expect(nearMissLayouts(candidates, 'frame_1in').map(c => c.name)).toEqual(['print', 'thin']);
    expect(nearMissLayouts(candidates, 'bare')).toEqual([]);
  });

  it('keeps a ticked layout that was retired, resized or re-sided visible so it can be unticked', () => {
    const out = ineligibleTicked(candidates, 'frame_1in', ['frame_half', 'thin', 'gone', 'card', 'frame_1in']);
    expect(out).toEqual([
      { name: 'thin', displayName: 'Thin bleed', reason: 'size_changed', size: '4 × 6 in, 0.2 in bleed' },
      { name: 'gone', displayName: 'gone', reason: 'retired', size: '' },
      { name: 'card', displayName: 'Folded card', reason: 'sides_changed', size: '4 × 6 in, 0.3 in bleed' },
    ]);
    expect(ineligibleTicked(candidates, 'frame_1in', [])).toEqual([]);
  });

  it('describes the home layout the way the server stamps it, and places a draft on another layout', () => {
    const home = { ...DEF, canvas: { width: 1524, height: 2032, widthMm: 152.4, heightMm: 203.2 },
      frames: [{ x: 0.1166666667, y: 0.0875, width: 0.7666666667, height: 0.825, bleedMm: 7.62 }] as SurfaceDefinition['frames'] };
    const other = { ...DEF, canvas: { width: 1270, height: 1778, widthMm: 127, heightMm: 177.8 },
      frames: [{ x: 0.04, y: 0.0285714286, width: 0.92, height: 0.9428571429, bleedMm: 7.62 }] as SurfaceDefinition['frames'] };
    const stamp = authoredOnFor('frame_1in', [{ key: 'default', def: home }]);
    expect(stamp).toEqual({ layout: 'frame_1in', surfaces: { default: {
      canvas: { width: 1524, height: 2032, widthMm: 152.4, heightMm: 203.2 },
      windowBox: { xMm: 17.78, yMm: 17.78, widthMm: 116.84, heightMm: 167.64 },
    } } });
    const decoration = { surfaces: { default: { overlays: [{ ...TEXT, y: 8 }] } }, authoredOn: stamp };
    // On the home layout the draft is drawn as it is; on the other, placed from the box centre (8% of 203.2 mm → 2% of 177.8 mm).
    expect(blankCard(home, decoration, null, surfaceGeometry(home)).overlays[0]).toMatchObject({ y: 8 });
    expect(blankCard(other, decoration, null, surfaceGeometry(other)).overlays[0]).toMatchObject({ y: 2 });
    expect(blankCard(other, decoration).overlays[0]).toMatchObject({ y: 8 });
  });
});

describe('dataUrlToPngFile', () => {
  it('turns the rendered thumbnail into a PNG upload, and refuses anything else', () => {
    const file = dataUrlToPngFile('data:image/png;base64,iVBORw0KGgo=');
    expect(file).toMatchObject({ name: 'thumbnail.png', type: 'image/png' });
    expect(file?.size).toBe(8);
    expect(dataUrlToPngFile('data:image/jpeg;base64,xx')).toBeNull();
    expect(dataUrlToPngFile('')).toBeNull();
  });
});
