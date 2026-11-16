import { isSafeProxyPath } from '../proxy-path';
import { isPathAllowed } from '../../app/api/embed/proxy/[...path]/route';
import { isDestructiveOpsPath, requiresOpsTier } from '../ops-guard';

describe('isSafeProxyPath', () => {
  it.each([
    [['layouts']],
    [['layouts', 'classic_4x6']],
    [['canvas-state', 'JOB-1001']],
    [['fonts', 'file', 'Baloo 2']],
    [['photos', '0b9f7c3e-1111-4222-8333-444455556666', 'preview']],
    [['upload', 'init']],
    [[]],
  ])('allows %j', segments => {
    expect(isSafeProxyPath(segments)).toBe(true);
  });

  it.each([
    [['layouts', '..', 'ops', 'layouts', 'x']],
    [['layouts', '.', 'x']],
    [['layouts', '%2e%2e', 'ops']],
    [['layouts', '%2E%2E', 'ops']],
    [['layouts', '%252e%252e', 'ops']],
    [['layouts', '..%2fops%2flayouts%2fx']],
    [['layouts', '..\\ops']],
    [['fonts', '../ops/layouts']],
    [['layouts', 'a%00b']],
    [['layouts', 'a\0b']],
  ])('refuses %j', segments => {
    expect(isSafeProxyPath(segments)).toBe(false);
  });

  it('tolerates a stray percent sign', () => {
    expect(isSafeProxyPath(['fonts', '100%'])).toBe(true);
  });
});

describe('why the guard is needed: the checks above it judge the raw string', () => {
  it('the embed allowlist accepts a traversal path that resolves to ops/', () => {
    const raw = 'layouts/../ops/layouts/x';
    expect(isPathAllowed(raw, 'GET')).toBe(true);
    expect(new URL(`http://backend:8000/api/${raw}`).pathname).toBe('/api/ops/layouts/x');
  });

  it('the ops gate does not see a purge hidden behind a layouts prefix', () => {
    const raw = 'layouts/../ops/orders/X/purge';
    expect(isDestructiveOpsPath(raw)).toBe(false);
    expect(requiresOpsTier(raw, 'DELETE')).toBe(false);
    expect(new URL(`http://backend:8000/api/${raw}`).pathname).toBe('/api/ops/orders/X/purge');
    expect(isSafeProxyPath(raw.split('/'))).toBe(false);
  });
});
