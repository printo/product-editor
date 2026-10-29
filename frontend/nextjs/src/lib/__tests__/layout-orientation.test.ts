/**
 * The dashboard card's Portrait / Landscape choice: when it is locked and the
 * address a card opens. The server's side is services/layout_orientation.py.
 */
import { layoutEditorHref, orientationLockedReason, templateCountFor, type OrientationInfo } from '../layout-orientation';

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

describe('templateCountFor', () => {
  const counts = { portrait: 2, landscape: 1 };
  it('shows the count for the chosen way, else the drawn way', () => {
    expect(templateCountFor(3, counts, null, portrait)).toBe(2);
    expect(templateCountFor(3, counts, 'portrait', portrait)).toBe(2);
    expect(templateCountFor(3, counts, 'landscape', portrait)).toBe(1);
    expect(templateCountFor(3, { portrait: 0 }, 'landscape', portrait)).toBe(3);
  });
  it('falls back to the total without per-orientation counts, or on a locked layout', () => {
    expect(templateCountFor(3, null, 'landscape', portrait)).toBe(3);
    expect(templateCountFor(3, counts, 'landscape', { orientation: 'portrait', blocked: 'has_captions' })).toBe(3);
    expect(templateCountFor(3, counts, null, undefined)).toBe(3);
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
