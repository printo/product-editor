import { isDestructiveOpsPath, requiresOpsTier } from '../ops-guard';

describe('isDestructiveOpsPath — DPDP purge stays ops-only', () => {
  it.each([
    'ops/orders/EXT-JOB-123/purge',
    'ops/orders/EXT-JOB-123/purge/',
    'ops/orders/a.b-c_1/purge',
  ])('gates %s', path => {
    expect(isDestructiveOpsPath(path)).toBe(true);
  });

  it('gates the purge path regardless of querystring-free order_id charset', () => {
    // order_id is server-validated as ^[A-Za-z0-9_.\-]{1,64}$ — every legal
    // shape must still be caught here.
    expect(isDestructiveOpsPath('ops/orders/ORDER.1_a-b/purge')).toBe(true);
  });
});

describe('isDestructiveOpsPath — template management stays open', () => {
  it.each([
    'ops/layouts',
    'ops/layouts/classic_5x7',
    'ops/calendar-styles/modern-genz',
    'ops/holidays/en-IN/2026',
    'layouts',
    'fonts',
    'editor/render',
  ])('does not gate %s', path => {
    expect(isDestructiveOpsPath(path)).toBe(false);
  });

  it('does not gate a hypothetical read endpoint under ops/orders', () => {
    // Matched on shape, not an `ops/orders/` prefix, so adding a read route
    // later does not silently become ops-only.
    expect(isDestructiveOpsPath('ops/orders/EXT-JOB-123')).toBe(false);
    expect(isDestructiveOpsPath('ops/orders/EXT-JOB-123/summary')).toBe(false);
  });

  it('does not gate a path that merely contains "purge" deeper down', () => {
    expect(isDestructiveOpsPath('ops/orders/EXT-JOB-123/purge/extra')).toBe(false);
    expect(isDestructiveOpsPath('layouts/purge')).toBe(false);
  });
});

describe('requiresOpsTier', () => {
  it('gates writes under the ops namespace', () => {
    expect(requiresOpsTier('ops/layouts', 'POST')).toBe(true);
    expect(requiresOpsTier('ops/layouts/classic_a4', 'PUT')).toBe(true);
    expect(requiresOpsTier('ops/layouts/classic_a4', 'DELETE')).toBe(true);
    expect(requiresOpsTier('ops/calendar-styles/modern-genz', 'PUT')).toBe(true);
    expect(requiresOpsTier('ops/holidays/en-IN/2026', 'PUT')).toBe(true);
  });

  it('gates the fonts write, which sits outside the ops namespace', () => {
    // The Fonts modal on /editor/layouts saves with PUT /api/fonts. A
    // namespace-only check left the whole font list writable by any
    // authenticated session while the layouts beside it were gated.
    expect(requiresOpsTier('fonts', 'PUT')).toBe(true);
  });

  it.each([
    ['calendar-styles/modern-genz', 'PUT'],
    ['calendar-styles/modern-genz', 'DELETE'],
    ['calendar-styles/', 'PUT'],
    ['holidays/en-IN/2026', 'PUT'],
    ['holidays/en-IN/2026', 'DELETE'],
    ['holidays/en-IN/2026', 'POST'],
  ])('gates %s %s — the non-ops alias of an ops-owned view', (path, method) => {
    // Django routes calendar-styles/<name> and holidays/<locale>/<year> to the
    // same views as their ops/ twins, and those views' write handlers never
    // look at which route they arrived on. Through this proxy the request is
    // presented with the ops-flagged service account, so Django's own check
    // passes — this gate is the only thing standing between an Editor-tier
    // session and ops config.
    expect(requiresOpsTier(path, method)).toBe(true);
  });

  it('leaves reads open, or the Editor tier cannot work at all', () => {
    // Listing templates and loading fonts is what the editor does on mount.
    expect(requiresOpsTier('ops/layouts', 'GET')).toBe(false);
    expect(requiresOpsTier('fonts', 'GET')).toBe(false);
    expect(requiresOpsTier('ops/layouts/classic_a4', 'HEAD')).toBe(false);
  });

  it('leaves calendar-style and holiday reads open — the editor loads them', () => {
    // editor/layout/[name]/page.tsx and the ops calendar page fetch these on
    // mount for Gen-Z palettes and auto-injected holidays.
    expect(requiresOpsTier('calendar-styles/', 'GET')).toBe(false);
    expect(requiresOpsTier('calendar-styles/modern-genz', 'GET')).toBe(false);
    expect(requiresOpsTier('holidays/en-IN/2026', 'GET')).toBe(false);
    expect(requiresOpsTier('holidays/en-IN/2026', 'HEAD')).toBe(false);
  });

  it('does not gate the editor and upload paths an Editor needs', () => {
    expect(requiresOpsTier('editor/render', 'POST')).toBe(false);
    expect(requiresOpsTier('canvas-state/ORDER-1', 'PUT')).toBe(false);
    expect(requiresOpsTier('upload/init', 'POST')).toBe(false);
    expect(requiresOpsTier('upload/abc/complete', 'POST')).toBe(false);
  });

  it('is not fooled by a path that merely starts with the letters ops', () => {
    expect(requiresOpsTier('opsomething', 'POST')).toBe(false);
  });

  it('matches the calendar aliases on whole segments only', () => {
    expect(requiresOpsTier('calendar-stylesheet', 'PUT')).toBe(false);
    expect(requiresOpsTier('holidaysx/en-IN/2026', 'PUT')).toBe(false);
  });
});
