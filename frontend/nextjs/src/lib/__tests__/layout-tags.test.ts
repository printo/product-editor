import { isTagKey, keyForName, layoutTagKeys, tagName, type LayoutTagInfo } from '../layout-tags';

// Same cases as services/tests/test_layout_tags.py: the browser's key check
// must agree with the server's or the Tags page would offer keys the API refuses.
describe('tag keys', () => {
  it('accepts lowercase words joined by single underscores', () => {
    for (const ok of ['photo_prints', 'a', 'x2', 'year_2026']) expect(isTagKey(ok)).toBe(true);
    for (const bad of ['', 'Photo', 'photo prints', 'photo__prints', '_x', 'x_', 'a-b', 'a'.repeat(51)]) {
      expect(isTagKey(bad)).toBe(false);
    }
  });

  it('suggests a key from a name', () => {
    expect(keyForName('Photo Prints')).toBe('photo_prints');
    expect(keyForName('  Mugs & Cups 11oz ')).toBe('mugs_cups_11oz');
    expect(keyForName('!!!')).toBe('');
  });
});

describe('layout tag helpers', () => {
  const tags: LayoutTagInfo[] = [{ key: 'mugs', name: 'Mugs & Cups', isActive: true, layoutCount: 2 }];

  it('reads tagKeys defensively', () => {
    expect(layoutTagKeys({ tagKeys: ['mugs', 3, 'gifts'] })).toEqual(['mugs', 'gifts']);
    expect(layoutTagKeys({})).toEqual([]);
  });

  it('names a key, falling back to the key', () => {
    expect(tagName(tags, 'mugs')).toBe('Mugs & Cups');
    expect(tagName(tags, 'ghost')).toBe('ghost');
  });
});
