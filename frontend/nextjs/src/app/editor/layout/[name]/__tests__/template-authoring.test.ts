/**
 * template-authoring.ts — what ops draw on a blank card becomes a template.
 */
import {
  blankCard, dataUrlToPngFile, decorationFromCards, isEmptyDecoration, isTemplateId, localImageOverlays, slugFromName, withoutPhotos,
} from '../template-authoring';
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

describe('dataUrlToPngFile', () => {
  it('turns the rendered thumbnail into a PNG upload, and refuses anything else', () => {
    const file = dataUrlToPngFile('data:image/png;base64,iVBORw0KGgo=');
    expect(file).toMatchObject({ name: 'thumbnail.png', type: 'image/png' });
    expect(file?.size).toBe(8);
    expect(dataUrlToPngFile('data:image/jpeg;base64,xx')).toBeNull();
    expect(dataUrlToPngFile('')).toBeNull();
  });
});
