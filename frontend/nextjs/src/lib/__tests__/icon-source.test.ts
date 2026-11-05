/**
 * lib/icon-source — an icon is loaded from our server, whatever address the
 * design stores for it.
 */
import { iconifyUrl, ownIconUrl, ownIconUrlFor } from '../icon-source';

const origin = window.location.origin;

describe('icon addresses', () => {
  it('stores Iconify’s address, as every saved design already does', () => {
    expect(iconifyUrl('mdi', 'heart')).toBe('https://api.iconify.design/mdi/heart.svg');
  });

  it('loads an Iconify icon from our own server', () => {
    expect(ownIconUrl('https://api.iconify.design/mdi/heart.svg')).toBe(`${origin}/api/icons/mdi/heart.svg`);
    expect(ownIconUrl('https://api.iconify.design/flat-color-icons/fine-print.svg')).toBe(`${origin}/api/icons/flat-color-icons/fine-print.svg`);
    expect(ownIconUrlFor('MDI', 'Heart')).toBe(`${origin}/api/icons/mdi/heart.svg`);
  });

  it('does the same for Iconify’s backup hosts and for a size or colour query', () => {
    expect(ownIconUrl('https://api.simplesvg.com/mdi/heart.svg')).toBe(`${origin}/api/icons/mdi/heart.svg`);
    expect(ownIconUrl('https://api.unisvg.com/mdi/heart.svg?color=red')).toBe(`${origin}/api/icons/mdi/heart.svg`);
  });

  it.each([
    'blob:https://product-editor.printo.in/3f2a',
    'data:image/png;base64,AAAA',
    'https://product-editor.printo.in/api/templates/assets/sticker_0123abcd.png',
    'https://cdn-product-editor.printo.in/masks/x.png',
    'https://api.iconify.design/search?query=love',
    'https://api.iconify.design/mdi.json?icons=heart',
    'https://evil.example/api.iconify.design/mdi/heart.svg',
    'http://api.iconify.design/mdi/heart.svg',
    '',
  ])('leaves %s alone', (src) => {
    expect(ownIconUrl(src)).toBe(src);
  });

  it('passes a missing address through', () => {
    expect(ownIconUrl(null)).toBeNull();
    expect(ownIconUrl(undefined)).toBeUndefined();
  });
});
