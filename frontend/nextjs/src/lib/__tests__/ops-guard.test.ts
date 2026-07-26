import { isDestructiveOpsPath } from '../ops-guard';

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
    'sku-layouts',
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
