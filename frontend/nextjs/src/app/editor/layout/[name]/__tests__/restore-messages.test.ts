import {
  MAX_RESTORE_PHOTOS, RESTORE_DATA, RESTORE_REQUEST, RESTORE_RESULT,
  fileIdFromLink, parseRestoreData, readRestoreOrderId, requestRestore, restoreStatusFor, sendRestoreResult,
  type RestoreWindow,
} from '../restore-messages';

const DESIGN = { layoutName: 'test_4x6', surfaces: [{ key: 'default', canvases: [] }] };
const PHOTO = { file_id: 'f-1', name: 'a.jpg', url: 'https://files.example.com/a.jpg' };
const reply = (over: Record<string, unknown> = {}) =>
  ({ type: RESTORE_DATA, orderId: 'NEW-1', schema_version: 1, editor_state: DESIGN, photos: [PHOTO], ...over });

describe('readRestoreOrderId', () => {
  it('reads a plain order reference from the address', () => {
    expect(readRestoreOrderId('?token=t&order_id=NEW-1&restore_order_id=OLD-9')).toBe('OLD-9');
  });
  it.each(['', '?restore_order_id=', '?restore_order_id=a/b', '?restore_order_id=has space', `?restore_order_id=${'x'.repeat(65)}`])(
    'is null for %p', (search) => { expect(readRestoreOrderId(search)).toBeNull(); },
  );
});

describe('parseRestoreData', () => {
  const parse = (raw: unknown) => parseRestoreData(raw, { orderId: 'NEW-1' });

  it('accepts the agreed shape', () => {
    expect(parse(reply())).toEqual({
      ok: true, editorState: DESIGN, schemaVersion: 1, layoutVersion: null,
      photos: [{ fileId: 'f-1', name: 'a.jpg', url: 'https://files.example.com/a.jpg', kind: null }],
    });
  });
  it('carries the layout version and each photo\'s kind when the page passes them on', () => {
    const r = parse(reply({ layout_version: 7, photos: [{ ...PHOTO, kind: 'overlay' }] }));
    expect(r).toEqual(expect.objectContaining({ ok: true, layoutVersion: 7 }));
    expect(r.ok && r.photos[0].kind).toBe('overlay');
  });
  it('gives a photo sent without an id one made from its link, the same every time', () => {
    const photos = [
      { name: 'a.jpg', url: 'https://files.example.com/user/a.jpg?sig=ONE' },
      { name: 'b.jpg', url: 'https://files.example.com/user/b.jpg' },
      { name: 'a-again.jpg', url: 'https://files.example.com/user/a.jpg?sig=TWO' },
    ];
    const first = parse(reply({ editor_state: null, photos }));
    const second = parse(reply({ editor_state: null, photos: [{ ...photos[0], url: 'https://files.example.com/user/a.jpg?sig=THREE' }, photos[1]] }));
    if (!first.ok || !second.ok) throw new Error('expected both to parse');
    // The same photo listed twice is one photo; a changed signature is the same photo.
    expect(first.photos.map(p => p.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(second.photos.map(p => p.fileId)).toEqual(first.photos.map(p => p.fileId));
    expect(first.photos[0].fileId).toMatch(/^u-[0-9a-f]{16}$/);
    expect(first.photos[0].fileId).not.toBe(first.photos[1].fileId);
    expect(fileIdFromLink(new URL(photos[1].url))).toBe(first.photos[1].fileId);
  });
  it('takes the name restore.json uses as well', () => {
    const r = parse(reply({ photos: [{ file_id: 'f-1', original_name: 'b.png', url: PHOTO.url }] }));
    expect(r.ok && r.photos[0].name).toBe('b.png');
  });
  it('accepts photos with no design (an order from before designs were kept)', () => {
    const r = parse(reply({ editor_state: null }));
    expect(r).toEqual(expect.objectContaining({ ok: true, editorState: null }));
  });
  it('refuses a reply for another order', () => {
    expect(parse(reply({ orderId: 'SOMEONE-ELSE' }))).toEqual({ ok: false, reason: 'invalid_reply' });
  });
  it('reads an error as the page declining', () => {
    expect(parse(reply({ error: 'not_found' }))).toEqual({ ok: false, reason: 'declined' });
  });
  it.each([
    ['not an object', 'hello'],
    ['another message type', { ...reply(), type: 'pe:something' }],
    ['a design that is not an object', reply({ editor_state: 'x' })],
    ['photos missing', reply({ photos: undefined })],
    ['too many photos', reply({ photos: Array.from({ length: MAX_RESTORE_PHOTOS + 1 }, (_, i) => ({ ...PHOTO, file_id: `f-${i}` })) })],
    ['nothing to restore', reply({ editor_state: null, photos: [] })],
    ['an oversized design', reply({ editor_state: { blob: 'x'.repeat(2 * 1024 * 1024 + 1) } })],
  ])('refuses %s', (_label, raw) => {
    expect(parse(raw)).toEqual({ ok: false, reason: 'invalid_reply' });
  });
  it('drops a photo entry it cannot trust and keeps the rest', () => {
    const r = parse(reply({ photos: [
      PHOTO,
      { file_id: 'f-2', url: 'http://files.example.com/plain-http.jpg' },
      { file_id: 'f-3', url: 'javascript:alert(1)' },
      { file_id: '../f-4', url: 'https://files.example.com/x.jpg' },
      { file_id: 'f-1', url: 'https://files.example.com/duplicate-id.jpg' },
      { file_id: 'f-5' },
      { file_id: 42, url: 'https://files.example.com/number-id.jpg' },
      'nonsense',
      { file_id: 'f-6', url: 'https://files.example.com/ok.jpg', name: 42 },
    ] }));
    expect(r.ok && r.photos.map(p => p.fileId)).toEqual(['f-1', 'f-6']);
    expect(r.ok && r.photos[1].name).toBe('');
  });
});

/** A window with a parent page, and a way to deliver a message as if posted. */
function fakeWindow({ framed = true } = {}) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const posted: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  const parent = { postMessage: (message: Record<string, unknown>, targetOrigin: string) => { posted.push({ message, targetOrigin }); } };
  const win: RestoreWindow = {
    parent: null,
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
  };
  win.parent = framed ? parent : win;
  const deliver = (data: unknown, { source = parent as unknown, origin = 'https://shop.example.com' } = {}) => {
    for (const l of [...listeners]) l({ data, source, origin } as unknown as MessageEvent);
  };
  return { win, parent, posted, deliver, listeners };
}
const ask = (win: RestoreWindow, over: Partial<Parameters<typeof requestRestore>[0]> = {}) => requestRestore({
  win, orderId: 'NEW-1', restoreOrderId: 'OLD-9', targetOrigin: 'https://shop.example.com',
  expectedOrigin: 'https://shop.example.com', ...over,
});

describe('requestRestore', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('asks the embedding page, at its own origin and never "*", and resolves with its reply', async () => {
    const w = fakeWindow();
    const pending = ask(w.win);
    expect(w.posted).toEqual([{
      message: { type: RESTORE_REQUEST, orderId: 'NEW-1', restoreOrderId: 'OLD-9' },
      targetOrigin: 'https://shop.example.com',
    }]);
    w.deliver(reply());
    await expect(pending).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(w.listeners.size).toBe(0);
  });

  it('is refused outright when the editor is not inside another page', async () => {
    const w = fakeWindow({ framed: false });
    await expect(ask(w.win)).resolves.toEqual({ ok: false, reason: 'not_embedded' });
    expect(w.posted).toEqual([]);
  });

  it('ignores a reply that does not come from the embedding page', async () => {
    const w = fakeWindow();
    const pending = ask(w.win);
    w.deliver(reply(), { source: { postMessage() {} } });            // a sibling frame or pop-up
    w.deliver(reply(), { origin: 'https://evil.example.com' });       // the parent window, navigated elsewhere
    w.deliver({ type: 'pe:something_else' });
    jest.advanceTimersByTime(10_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(w.listeners.size).toBe(0);
  });

  it('accepts the parent whatever its origin when the browser does not report one', async () => {
    const w = fakeWindow();
    const pending = ask(w.win, { expectedOrigin: null });
    w.deliver(reply(), { origin: 'https://anything.example.com' });
    await expect(pending).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('gives up after ten seconds of silence', async () => {
    const w = fakeWindow();
    const pending = ask(w.win);
    jest.advanceTimersByTime(9_999);
    w.deliver({ type: 'unrelated' });
    jest.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('settles on the first reply from the page, even a bad one', async () => {
    const w = fakeWindow();
    const pending = ask(w.win);
    w.deliver(reply({ orderId: 'WRONG' }));
    w.deliver(reply());
    await expect(pending).resolves.toEqual({ ok: false, reason: 'invalid_reply' });
  });
});

describe('sendRestoreResult', () => {
  it('tells the page how it went, at its own origin', () => {
    const w = fakeWindow();
    sendRestoreResult(w.win, 'https://shop.example.com', { orderId: 'NEW-1', restoreOrderId: 'OLD-9' },
      { status: 'partial', photosTotal: 5, photosLoaded: 3 });
    expect(w.posted).toEqual([{
      targetOrigin: 'https://shop.example.com',
      message: { type: RESTORE_RESULT, orderId: 'NEW-1', restoreOrderId: 'OLD-9', status: 'partial', photos: { total: 5, loaded: 3, failed: 2 } },
    }]);
  });
  it('says whether the whole design came back or only the photos', () => {
    const w = fakeWindow();
    sendRestoreResult(w.win, 'https://shop.example.com', { orderId: 'NEW-1', restoreOrderId: 'OLD-9' },
      { status: 'restored', mode: 'photos', photosTotal: 2, photosLoaded: 2 });
    expect(w.posted[0].message).toEqual(expect.objectContaining({ status: 'restored', mode: 'photos' }));
  });
  it('carries the reason when nothing was restored', () => {
    const w = fakeWindow();
    sendRestoreResult(w.win, 'https://shop.example.com', { orderId: 'NEW-1', restoreOrderId: 'OLD-9' },
      { status: 'none', reason: 'timeout', photosTotal: 0, photosLoaded: 0 });
    expect(w.posted[0].message).toEqual(expect.objectContaining({ status: 'none', reason: 'timeout' }));
  });
  it('does nothing when unframed', () => {
    const w = fakeWindow({ framed: false });
    sendRestoreResult(w.win, 'https://shop.example.com', { orderId: 'a', restoreOrderId: 'b' }, { status: 'none', photosTotal: 0, photosLoaded: 0 });
    expect(w.posted).toEqual([]);
  });
});

describe('restoreStatusFor', () => {
  it.each([[0, 0, 'restored'], [3, 3, 'restored'], [3, 1, 'partial'], [3, 0, 'none']] as const)(
    '%i photos, %i loaded → %s', (total, loaded, status) => { expect(restoreStatusFor(total, loaded)).toBe(status); },
  );
});
