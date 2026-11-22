import { missingPhotosCause, reportMissingPhotos } from '../missing-photos-report';
import { getFilesForOrder, lastOrderFilesReadout, saveFile } from '../file-store';
import { resetClientErrorReports } from '../client-error-report';

describe('missingPhotosCause', () => {
  const opened = (recordsForOrder: number, unreadable = 0) => ({ storeOpened: true, recordsForOrder, unreadable });

  it('names storage that never opened', () => {
    expect(missingPhotosCause({ storeOpened: false, recordsForOrder: 0, unreadable: 0 }, null, 'memory')).toBe('storage blocked');
    expect(missingPhotosCause(null, null, 'unknown')).toBe('storage blocked');
  });

  it('tells an emptied store from one that kept other orders', () => {
    expect(missingPhotosCause(opened(0), 0, 'durable')).toBe('store emptied');
    expect(missingPhotosCause(opened(0), 7, 'durable')).toBe('nothing kept for this order');
  });

  it('names records that are there but cannot be read', () => {
    expect(missingPhotosCause(opened(10, 10), 10, 'durable')).toBe('kept but unreadable');
  });

  it('falls back to some never kept', () => {
    expect(missingPhotosCause(opened(6), 6, 'durable')).toBe('some never kept');
  });
});

describe('reportMissingPhotos', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    resetClientErrorReports();
    fetchMock = jest.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends one warning with counts only, never ids or names', async () => {
    await reportMissingPhotos(10, 10, { storeOpened: true, recordsForOrder: 0, unreadable: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/client-errors');
    const body = JSON.parse(init.body);
    expect(body.kind).toBe('photos-missing');
    expect(body.level).toBe('warning');
    expect(body.message).toMatch(/^Photos missing after refresh \(.+\): 10 of 10$/);
    expect(body.stack).toContain('Kept for this order: 0, of which unreadable: 0');
    expect(body.stack).toContain("Inside another site's page:");
  });

  it('sends nothing when nothing is missing', async () => {
    await reportMissingPhotos(4, 0, { storeOpened: true, recordsForOrder: 4, unreadable: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('lastOrderFilesReadout', () => {
  it('records what the last read found for the order', async () => {
    const order = 'ORD-READOUT-1';
    await saveFile(order, new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    await getFilesForOrder(order);
    expect(lastOrderFilesReadout(order)).toEqual(expect.objectContaining({ recordsForOrder: 1, unreadable: 0 }));
  });
});
