import { loginHref, safeCallbackPath } from '../callback-url';

describe('safeCallbackPath', () => {
  it('keeps a same-site path with its query', () => {
    expect(safeCallbackPath('/dashboard?tag=photo_frame&q=gold')).toBe('/dashboard?tag=photo_frame&q=gold');
    expect(safeCallbackPath('/editor/layouts')).toBe('/editor/layouts');
  });

  it('falls back to the dashboard when absent', () => {
    expect(safeCallbackPath(null)).toBe('/dashboard');
    expect(safeCallbackPath('')).toBe('/dashboard');
  });

  it.each([
    'https://evil.example/dashboard',
    '//evil.example/dashboard',
    '/\\evil.example',
    'javascript:alert(1)',
    'dashboard',
  ])('refuses an off-site address: %s', (raw) => {
    expect(safeCallbackPath(raw)).toBe('/dashboard');
  });
});

describe('loginHref', () => {
  it('round-trips the page address through the login link', () => {
    const href = loginHref('/dashboard', '?tag=photo_frame&q=gold');
    const callback = new URL(href, 'http://x').searchParams.get('callbackUrl');
    expect(safeCallbackPath(callback)).toBe('/dashboard?tag=photo_frame&q=gold');
  });
});
