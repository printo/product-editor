/**
 * The test environment has no IndexedDB, so these run against file-store's
 * in-memory fallback — the same bookkeeping the durable store applies.
 */
import { saveFile, getFilesForOrder, pruneUnreferencedFiles, deleteFile, lastOrderFilesReadout } from '../file-store';

const HOUR = 60 * 60 * 1000;
const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg', lastModified: 1 });

describe('pruneUnreferencedFiles', () => {
  let now = 1_000_000_000_000;
  beforeEach(() => { jest.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('deletes only unreferenced records older than the age floor', async () => {
    const order = 'ORD-PRUNE-1';
    const oldKept = await saveFile(order, photo('kept.jpg'));
    const oldDropped = await saveFile(order, photo('dropped.jpg'));
    now += 25 * HOUR;
    const freshDropped = await saveFile(order, photo('fresh.jpg'));

    const deleted = await pruneUnreferencedFiles(order, new Set([oldKept]), 24 * HOUR);

    expect(deleted).toBe(1);
    const left = await getFilesForOrder(order);
    expect(left.has(oldKept)).toBe(true);
    expect(left.has(oldDropped)).toBe(false);
    // Too new: could belong to another tab's unsaved state.
    expect(left.has(freshDropped)).toBe(true);
  });

  it('never touches another order', async () => {
    const other = await saveFile('ORD-PRUNE-OTHER', photo('other.jpg'));
    now += 48 * HOUR;
    await pruneUnreferencedFiles('ORD-PRUNE-2', new Set(), 0);
    expect((await getFilesForOrder('ORD-PRUNE-OTHER')).has(other)).toBe(true);
  });
});

describe('deleteFile', () => {
  it('removes just that record', async () => {
    const order = 'ORD-DELETE-1';
    const a = await saveFile(order, photo('a.jpg'));
    const b = await saveFile(order, photo('b.jpg'));
    await deleteFile(a);
    const left = await getFilesForOrder(order);
    expect(left.has(a)).toBe(false);
    expect(left.has(b)).toBe(true);
  });
});

describe('photos stored for a refresh', () => {
  it('are stored as a copy of the bytes, not the picked File itself', async () => {
    const order = 'ORD-COPY-1';
    const original = new File(['photo bytes'], 'copy.jpg', { type: 'image/jpeg', lastModified: 7 });
    const id = await saveFile(order, original);
    const back = (await getFilesForOrder(order)).get(id)!;
    expect(back).not.toBe(original);
    expect(back.name).toBe('copy.jpg');
    expect(back.type).toBe('image/jpeg');
    expect(back.lastModified).toBe(7);
    expect(await back.text()).toBe('photo bytes');
  });

  it('a stored photo that can no longer be read is left out, so its card says it is missing', async () => {
    const order = 'ORD-UNREADABLE-1';
    // What iOS left behind: a File whose bytes are gone.
    const gone = new File(['x'], 'gone.jpg', { type: 'image/jpeg' });
    const fail = () => Promise.reject(new DOMException('The file is gone', 'NotReadableError'));
    Object.defineProperty(gone, 'arrayBuffer', { value: fail });
    Object.defineProperty(gone, 'slice', { value: () => ({ arrayBuffer: fail }) });
    const goneId = await saveFile(order, gone);
    const fineId = await saveFile(order, photo('fine.jpg'));
    const back = await getFilesForOrder(order);
    expect(back.has(goneId)).toBe(false);
    expect(back.has(fineId)).toBe(true);
  });
});

describe('inside another site\'s page', () => {
  // An iPhone browser kept the record but could not read its Blob after a
  // refresh when the editor was framed by printo.in (2026-11-22).
  let topSpy: jest.SpyInstance;
  beforeEach(() => { topSpy = jest.spyOn(window, 'top', 'get').mockReturnValue({} as Window); });
  afterEach(() => { topSpy.mockRestore(); });

  it('keeps the photo as raw bytes and gives the same photo back', async () => {
    const order = 'ORD-FRAMED-1';
    const original = new File(['framed bytes'], 'framed.jpg', { type: 'image/jpeg', lastModified: 9 });
    const id = await saveFile(order, original);
    const back = (await getFilesForOrder(order)).get(id)!;
    expect(await back.text()).toBe('framed bytes');
    expect(back.name).toBe('framed.jpg');
    expect(back.type).toBe('image/jpeg');
    expect(back.lastModified).toBe(9);
    expect(lastOrderFilesReadout(order)).toEqual(expect.objectContaining({ recordsForOrder: 1, unreadable: 0, keptAsData: 1 }));
  });

  it('a page opened on its own still keeps a Blob', async () => {
    topSpy.mockRestore();
    const order = 'ORD-UNFRAMED-1';
    await saveFile(order, new File(['x'], 'own.jpg', { type: 'image/jpeg' }));
    await getFilesForOrder(order);
    expect(lastOrderFilesReadout(order)).toEqual(expect.objectContaining({ recordsForOrder: 1, keptAsData: 0 }));
    topSpy = jest.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
  });

  it('saves many photos without losing any, two at a time', async () => {
    const order = 'ORD-FRAMED-MANY';
    const ids = await Promise.all(Array.from({ length: 7 }, (_, i) =>
      saveFile(order, new File([`p${i}`], `p${i}.jpg`, { type: 'image/jpeg' }))));
    const back = await getFilesForOrder(order);
    expect(ids.every(id => back.has(id))).toBe(true);
    expect(await back.get(ids[6])!.text()).toBe('p6');
  });
});
