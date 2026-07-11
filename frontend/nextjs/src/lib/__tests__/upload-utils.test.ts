/**
 * Tests for chunked-upload byte progress and in-session resume (Phase 3).
 * fetch is fully mocked; each test uses fresh File objects (sessions are
 * WeakMap-keyed by File identity).
 */
import { uploadFile, uploadFiles } from '@/lib/upload-utils';

const CHUNK = 2 * 1024 * 1024;

function makeFile(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

type Route = (url: string, init: RequestInit) => { status: number; body?: unknown } | undefined;

function mockFetch(route: Route) {
  const calls: { url: string; method: string }[] = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method || 'GET' });
    const out = route(u, init || {}) || { status: 500 };
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body ?? {},
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const happyRoute = (uploadId: string): Route => (url, init) => {
  if (url.endsWith('/upload/init')) return { status: 200, body: { upload_id: uploadId, chunk_size: CHUNK } };
  if (url.includes('/chunk?index=')) return { status: 200, body: { received: 1, total: 1 } };
  if (url.endsWith('/complete')) return { status: 200, body: { file_path: `/u/${uploadId}.jpg`, filename: 'f.jpg' } };
  return undefined;
};

afterEach(() => jest.restoreAllMocks());

describe('uploadFiles byte-weighted progress', () => {
  it('emits monotonically increasing byte totals ending at the full size', async () => {
    const files = [makeFile('a.jpg', CHUNK + 100), makeFile('b.jpg', 500)];
    mockFetch(happyRoute('u1'));
    const events: Array<[number, number]> = [];
    await uploadFiles(files, '/api', () => ({}), (done, total) => events.push([done, total]));

    const total = files[0].size + files[1].size;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(([, t]) => t === total)).toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i][0]).toBeGreaterThanOrEqual(events[i - 1][0]);
    }
    expect(events[events.length - 1][0]).toBe(total);
  });
});

describe('in-session resume', () => {
  it('a failed file resumes from the failed chunk; init is not repeated', async () => {
    const file = makeFile('big.jpg', CHUNK * 3);  // 3 chunks
    let failSecondChunk = true;
    const calls = mockFetch((url) => {
      if (url.endsWith('/upload/init')) return { status: 200, body: { upload_id: 'u-res', chunk_size: CHUNK } };
      if (url.includes('/chunk?index=1') && failSecondChunk) return { status: 400, body: { detail: 'boom' } };
      if (url.includes('/chunk?index=')) return { status: 200, body: {} };
      if (url.endsWith('/complete')) return { status: 200, body: { file_path: '/u/x.jpg', filename: 'big.jpg' } };
      return undefined;
    });

    await expect(uploadFile(file, '/api', () => ({}))).rejects.toThrow(/Chunk 1/);
    const initsBefore = calls.filter(c => c.url.endsWith('/upload/init')).length;
    expect(initsBefore).toBe(1);
    expect(calls.some(c => c.url.includes('/chunk?index=0'))).toBe(true);

    // Second attempt: chunk 1 now succeeds. init must NOT be re-called and
    // chunk 0 must NOT be re-sent (already acked).
    failSecondChunk = false;
    calls.length = 0;
    const result = await uploadFile(file, '/api', () => ({}));
    expect(result.uploadId).toBe('u-res');
    expect(calls.filter(c => c.url.endsWith('/upload/init'))).toHaveLength(0);
    expect(calls.some(c => c.url.includes('/chunk?index=0'))).toBe(false);
    expect(calls.some(c => c.url.includes('/chunk?index=1'))).toBe(true);
    expect(calls.some(c => c.url.includes('/chunk?index=2'))).toBe(true);
  });

  it('a fully-uploaded file is not re-sent on the next batch', async () => {
    const file = makeFile('done.jpg', 100);
    mockFetch(happyRoute('u-done'));
    await uploadFile(file, '/api', () => ({}));

    const calls = mockFetch(happyRoute('u-should-not-be-used'));
    const result = await uploadFile(file, '/api', () => ({}));
    expect(result.uploadId).toBe('u-done');
    expect(calls).toHaveLength(0);
  });

  it('a GC-d session (404 on resumed chunk) restarts cleanly from init once', async () => {
    const file = makeFile('gc.jpg', CHUNK * 2);
    let mode: 'fail-late' | 'gone' | 'fresh' = 'fail-late';
    const calls = mockFetch((url) => {
      if (url.endsWith('/upload/init')) {
        return { status: 200, body: { upload_id: mode === 'fresh' ? 'u-new' : 'u-old', chunk_size: CHUNK } };
      }
      if (url.includes('/chunk?index=')) {
        if (mode === 'fail-late' && url.includes('index=1')) return { status: 400, body: { detail: 'transient' } };
        if (mode === 'gone') { mode = 'fresh'; return { status: 404, body: { detail: 'Upload session not found' } }; }
        return { status: 200, body: {} };
      }
      if (url.endsWith('/complete')) return { status: 200, body: { file_path: '/u/gc.jpg', filename: 'gc.jpg' } };
      return undefined;
    });

    await expect(uploadFile(file, '/api', () => ({}))).rejects.toThrow(/Chunk 1/);
    // Server GC'd the staging dir between attempts:
    mode = 'gone';
    calls.length = 0;
    const result = await uploadFile(file, '/api', () => ({}));
    expect(result.uploadId).toBe('u-new');
    // A fresh init happened and chunk 0 was re-sent for the new session.
    expect(calls.filter(c => c.url.endsWith('/upload/init'))).toHaveLength(1);
    expect(calls.some(c => c.url.includes('/chunk?index=0'))).toBe(true);
  });

  it('uploadFiles aggregates failures and names the files', async () => {
    const good = makeFile('good.jpg', 100);
    const bad = makeFile('bad.jpg', 100);
    mockFetch((url, init) => {
      if (url.endsWith('/upload/init')) {
        const body = JSON.parse(String((init as { body?: string }).body || '{}'));
        if (body.filename === 'bad.jpg') return { status: 400, body: { detail: 'nope' } };
        return { status: 200, body: { upload_id: 'u-good', chunk_size: CHUNK } };
      }
      if (url.includes('/chunk?index=')) return { status: 200, body: {} };
      if (url.endsWith('/complete')) return { status: 200, body: { file_path: '/u/g.jpg', filename: 'good.jpg' } };
      return undefined;
    });

    await expect(uploadFiles([good, bad], '/api', () => ({}))).rejects.toThrow(/bad\.jpg/);
  });
});
