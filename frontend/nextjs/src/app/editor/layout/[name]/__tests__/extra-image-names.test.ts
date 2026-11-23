import { extraImageName, mainPhotoName } from '../editor-utils';
import type { Overlay } from '../types';

const image = (id: string, source: 'local' | 'icon' | 'clipart' = 'local') =>
  ({ id, type: 'image', source, src: 'x', label: id, x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1 }) as Overlay;
const text = { id: 't', type: 'text', text: 'Hi', x: 0, y: 0, fontSize: 20, color: '#000', fontFamily: 'Inter', rotation: 0 } as Overlay;

describe('extraImageName', () => {
  it('numbers the added images in stack order, first added is 1', () => {
    const overlays = [image('a'), image('b'), image('c')];
    expect(overlays.map((_, i) => extraImageName(overlays, i))).toEqual(['Extra image 1', 'Extra image 2', 'Extra image 3']);
  });

  it('does not count or name text, icons, stickers or shapes', () => {
    const overlays = [text, image('a'), image('icon', 'icon'), image('sticker', 'clipart'), image('b')];
    expect(overlays.map((_, i) => extraImageName(overlays, i))).toEqual([null, 'Extra image 1', null, null, 'Extra image 2']);
  });

  it('closes the gap when one is deleted', () => {
    const overlays = [image('a'), image('c')];
    expect(extraImageName(overlays, 1)).toBe('Extra image 2');
  });

  it('is null for an index that is not there', () => {
    expect(extraImageName([], 0)).toBeNull();
  });
});

describe('mainPhotoName', () => {
  it('is "Main photo" for one print area and numbered for several', () => {
    expect(mainPhotoName(0, 1)).toBe('Main photo');
    expect(mainPhotoName(0, 3)).toBe('Main photo 1');
    expect(mainPhotoName(2, 3)).toBe('Main photo 3');
  });
});
