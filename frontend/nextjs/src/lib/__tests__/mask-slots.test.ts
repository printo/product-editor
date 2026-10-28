/**
 * The two mask slots and how the legacy `maskUrl` + `maskOnExport` pair maps
 * onto them. The server's side is services/print_sheet.py.
 */
import { resolveMaskSlots } from '../mask-slots';

describe('resolveMaskSlots', () => {
  it('reads the two slots', () => {
    expect(resolveMaskSlots({ frameMaskUrl: '/f.png', artworkMaskUrl: '/a.png' }))
      .toEqual({ frameMaskUrl: '/f.png', artworkMaskUrl: '/a.png' });
    expect(resolveMaskSlots({ frameMaskUrl: '/f.png' })).toEqual({ frameMaskUrl: '/f.png', artworkMaskUrl: null });
  });

  it('puts a legacy printed mask in the artwork slot and a preview-only one in the frame slot', () => {
    expect(resolveMaskSlots({ maskUrl: '/m.png', maskOnExport: true })).toEqual({ frameMaskUrl: null, artworkMaskUrl: '/m.png' });
    expect(resolveMaskSlots({ maskUrl: '/m.png', maskOnExport: false })).toEqual({ frameMaskUrl: '/m.png', artworkMaskUrl: null });
    expect(resolveMaskSlots({ maskUrl: '/m.png' })).toEqual({ frameMaskUrl: '/m.png', artworkMaskUrl: null });
  });

  it('never lets two empty new keys hide a legacy mask', () => {
    expect(resolveMaskSlots({ frameMaskUrl: null, artworkMaskUrl: null, maskUrl: '/m.png', maskOnExport: true }))
      .toEqual({ frameMaskUrl: null, artworkMaskUrl: '/m.png' });
  });

  it('is empty for nothing, blanks and non-objects', () => {
    const none = { frameMaskUrl: null, artworkMaskUrl: null };
    expect(resolveMaskSlots({})).toEqual(none);
    expect(resolveMaskSlots({ maskUrl: '  ', frameMaskUrl: '' })).toEqual(none);
    expect(resolveMaskSlots(null)).toEqual(none);
    expect(resolveMaskSlots('x')).toEqual(none);
  });
});
