/**
 * Embed-proxy allowlist: paths AND methods.
 *
 * The method half is the point. The allowlist was prefix-only, so "GET only"
 * was a comment rather than a rule — and the proxy injects the session's REAL
 * api_key. With an ops-flagged key behind the session, an embed token (which
 * lives in a URL in the customer's browser) could reach the ops write on
 * holidays / calendar-styles / fonts. Backend `_gate_ops` was the only guard,
 * and it passes for an ops key.
 */
import { isPathAllowed } from '../[...path]/route';

describe('isPathAllowed — customer flows keep working', () => {
  it.each([
    ['layouts/classic_4x6', 'GET'],
    ['editor/init', 'GET'],
    ['editor/render', 'POST'],
    ['canvas-state/PE-1234/', 'GET'],
    ['canvas-state/PE-1234/', 'PUT'],
    ['upload/init', 'POST'],
    ['upload/abc/chunk', 'PUT'],
    ['upload/abc/complete', 'POST'],
    ['render-status/abc/', 'GET'],
    ['jobs/abc/download/', 'GET'],
    ['orientation/detect', 'POST'],
    ['heic/convert', 'POST'],
    ['config', 'GET'],
    ['fonts', 'GET'],
    ['holidays/en-IN/2026', 'GET'],
    ['calendar-styles/modern-genz', 'GET'],
    ['sku-layouts/', 'GET'],
  ])('allows %s %s', (path, method) => {
    expect(isPathAllowed(path, method)).toBe(true);
  });
});

describe('isPathAllowed — ops writes are not reachable with an embed token', () => {
  it.each([
    ['holidays/en-IN/2026', 'PUT'],
    ['holidays/en-IN/2026', 'DELETE'],
    ['calendar-styles/modern-genz', 'PUT'],
    ['fonts', 'PUT'],
    ['sku-layouts/', 'PUT'],
    ['sku-layouts/SKU-1/', 'PATCH'],
    ['sku-layouts/SKU-1/', 'DELETE'],
    ['layouts/classic_4x6', 'DELETE'],
  ])('rejects %s %s', (path, method) => {
    expect(isPathAllowed(path, method)).toBe(false);
  });

  it('still rejects ops and admin paths outright', () => {
    for (const p of ['ops/layouts', 'ops/orders/X/purge', 'django-admin', 'celery/monitor/']) {
      for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect(isPathAllowed(p, m)).toBe(false);
      }
    }
  });

  it('does not let a prefix match leak past a path boundary', () => {
    expect(isPathAllowed('fontsomething', 'GET')).toBe(false);
    expect(isPathAllowed('jobsomething', 'GET')).toBe(false);
  });

  it('treats HEAD as GET', () => {
    expect(isPathAllowed('layouts/x', 'HEAD')).toBe(true);
    expect(isPathAllowed('editor/render', 'HEAD')).toBe(false);
  });

  it('empty path is never allowed', () => {
    expect(isPathAllowed('', 'GET')).toBe(false);
  });
});
