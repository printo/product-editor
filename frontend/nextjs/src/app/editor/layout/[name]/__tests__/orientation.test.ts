/**
 * The dashboard's orientation toggle: what it shows, when it is locked, and
 * the address it opens. The server's side is services/layout_orientation.py.
 */
import {
  authoredOrientation, orientationLockedReason, orientationSwitchSearch, type OrientationReport,
} from '../orientation';

const report = (over: Partial<OrientationReport>): OrientationReport => ({
  requested: null, applied: false, reason: 'not_sent', orientation: 'landscape', blocked: null, ...over,
});

describe('authoredOrientation', () => {
  it('is what is served when nothing was turned', () => {
    expect(authoredOrientation(report({ orientation: 'landscape' }))).toBe('landscape');
  });
  it('is the other way round when the layout was turned', () => {
    expect(authoredOrientation(report({ applied: true, reason: null, requested: 'portrait', orientation: 'portrait' }))).toBe('landscape');
    expect(authoredOrientation(report({ applied: true, reason: null, requested: 'landscape', orientation: 'landscape' }))).toBe('portrait');
  });
  it('is null for a square layout or no report', () => {
    expect(authoredOrientation(report({ orientation: 'square' }))).toBeNull();
    expect(authoredOrientation(null)).toBeNull();
  });
});

describe('orientationLockedReason', () => {
  it.each(['not_rotatable', 'has_captions', 'has_overlays', 'svg_mask', 'square_layout'])('locks on %s', (blocked) => {
    expect(orientationLockedReason(report({ blocked }))).toEqual(expect.any(String));
  });
  it('stays open when the layout can be turned, whatever the request did', () => {
    expect(orientationLockedReason(report({ blocked: null, reason: 'not_sent' }))).toBeNull();
    expect(orientationLockedReason(report({ blocked: null, reason: 'already_that_orientation' }))).toBeNull();
    expect(orientationLockedReason(null)).toBeNull();
  });
});

describe('orientationSwitchSearch', () => {
  it('asks for the other orientation and starts a new order', () => {
    expect(orientationSwitchSearch('?order_id=PE-1&template=abc', 'portrait', 'landscape'))
      .toBe('?template=abc&orientation=portrait');
  });
  it('drops the param when going back to the layout\'s own orientation', () => {
    expect(orientationSwitchSearch('?order_id=PE-1&orientation=portrait', 'landscape', 'landscape')).toBe('');
  });
  it('leaves the open canvas editor behind', () => {
    expect(orientationSwitchSearch('?canvas=2&order_id=PE-1', 'portrait', 'landscape')).toBe('?orientation=portrait');
  });
});
