/**
 * The dashboard card's Portrait / Landscape choice: when it is locked and the
 * address a card opens. The server's side is services/layout_orientation.py.
 */
import { layoutEditorHref, orientationLockedReason, type OrientationInfo } from '../layout-orientation';

const portrait: OrientationInfo = { orientation: 'portrait', blocked: null };

describe('orientationLockedReason', () => {
  it.each(['not_rotatable', 'has_captions', 'has_overlays', 'svg_mask', 'square_layout'])('locks on %s', (blocked) => {
    expect(orientationLockedReason({ orientation: 'portrait', blocked })).toEqual(expect.any(String));
  });
  it('is open for a layout that can be turned', () => {
    expect(orientationLockedReason(portrait)).toBeNull();
  });
  it('is locked when the server said nothing (an older backend)', () => {
    expect(orientationLockedReason(undefined)).toEqual(expect.any(String));
    expect(orientationLockedReason({ orientation: null, blocked: null })).toEqual(expect.any(String));
  });
});

describe('layoutEditorHref', () => {
  it('opens the layout as drawn when nothing else is chosen', () => {
    expect(layoutEditorHref('classic_4x6', null, portrait)).toBe('/editor/layout/classic_4x6');
    expect(layoutEditorHref('classic_4x6', 'portrait', portrait)).toBe('/editor/layout/classic_4x6');
  });
  it('asks for the other orientation', () => {
    expect(layoutEditorHref('classic_4x6', 'landscape', portrait)).toBe('/editor/layout/classic_4x6?orientation=landscape');
  });
  it('never asks for one on a locked layout', () => {
    expect(layoutEditorHref('polaroid', 'landscape', { orientation: 'portrait', blocked: 'has_captions' })).toBe('/editor/layout/polaroid');
  });
});
