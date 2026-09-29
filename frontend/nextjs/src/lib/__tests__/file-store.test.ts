/**
 * The test environment has no IndexedDB, so these run against file-store's
 * in-memory fallback — the same bookkeeping the durable store applies.
 */
import { saveFile, getFilesForOrder, pruneUnreferencedFiles, deleteFile } from '../file-store';

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
