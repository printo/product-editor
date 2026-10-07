import { downloadBlob } from '@/lib/zip-utils';

describe('downloadBlob', () => {
  afterEach(() => jest.restoreAllMocks());

  it('downloads through a detached link, leaves the document untouched, and revokes the blob URL', () => {
    const clicks: Array<{ href: string; download: string; attached: boolean }> = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download, attached: this.isConnected });
    });
    const revoke = jest.spyOn(URL, 'revokeObjectURL');
    const childrenBefore = document.body.childElementCount;

    downloadBlob(new Blob(['zip']), 'sheets.zip');

    expect(clicks).toEqual([{ href: expect.stringMatching(/^blob:/), download: 'sheets.zip', attached: false }]);
    expect(document.body.childElementCount).toBe(childrenBefore);
    expect(revoke).toHaveBeenCalledWith(clicks[0].href);
  });
});
