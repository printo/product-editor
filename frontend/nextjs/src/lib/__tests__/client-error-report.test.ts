import {
  CLIENT_ERROR_ENDPOINT,
  MAX_PER_PAGE,
  isNoise,
  reportClientError,
  reportUnhandledRejection,
  reportWindowError,
  resetClientErrorReports,
  withoutQuery,
} from '@/lib/client-error-report';

describe('client error reports', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    resetClientErrorReports();
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.history.replaceState(null, '', '/editor/layout/circle_48mm?token=secret-token&order_id=PE-1');
  });

  const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  it('posts an error to the backend without the address query', () => {
    reportClientError({
      kind: 'error',
      message: 'TypeError: boom',
      stack: 'at f (https://product-editor.printo.in/_next/static/chunks/a.js?v=3:1:2)',
      source: 'https://product-editor.printo.in/_next/static/chunks/a.js?v=3',
      line: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CLIENT_ERROR_ENDPOINT);
    expect(init.keepalive).toBe(true);
    const body = sentBodies()[0];
    expect(body.page).toBe('/editor/layout/circle_48mm');
    expect(body.embed).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(body.source).toBe('https://product-editor.printo.in/_next/static/chunks/a.js');
  });

  it('sends each message once and at most a handful per page', () => {
    reportClientError({ kind: 'error', message: 'same' });
    reportClientError({ kind: 'error', message: 'same' });
    for (let i = 0; i < 20; i += 1) reportClientError({ kind: 'error', message: `different ${i}` });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_PER_PAGE);
  });

  it('ignores errors that are not ours', () => {
    expect(isNoise({ message: 'Script error.' })).toBe(true);
    expect(isNoise({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
    expect(isNoise({ message: 'x', stack: 'at chrome-extension://abc/c.js:1' })).toBe(true);
    expect(isNoise({ message: '' })).toBe(true);
    expect(isNoise({ message: 'TypeError: real' })).toBe(false);
    reportClientError({ kind: 'error', message: 'Script error.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(() => reportClientError({ kind: 'error', message: 'boom' })).not.toThrow();
    await Promise.resolve();
  });

  it('reads window errors and unhandled rejections', () => {
    const error = new RangeError('bad index');
    reportWindowError({
      error,
      message: 'Uncaught RangeError: bad index',
      filename: 'https://product-editor.printo.in/x.js',
      lineno: 4,
      colno: 2,
    } as ErrorEvent);
    reportUnhandledRejection({ reason: new Error('upload failed') } as PromiseRejectionEvent);
    reportUnhandledRejection({ reason: { status: 502 } } as PromiseRejectionEvent);
    const bodies = sentBodies();
    expect(bodies[0]).toMatchObject({ kind: 'error', message: 'RangeError: bad index', line: 4 });
    expect(bodies[1]).toMatchObject({ kind: 'unhandledrejection', message: 'Error: upload failed' });
    expect(bodies[2].message).toBe('{"status":502}');
  });

  it('strips query strings from any URL in a stack', () => {
    expect(withoutQuery('see https://x.example/a.jpg?sig=abc and more')).toBe(
      'see https://x.example/a.jpg and more',
    );
  });
});
