/**
 * Error-mapping tests for pdf-import.ts. Real pdf.js rendering (canvas
 * getContext('2d') pixel work) can't run under happy-dom — see jest.config.ts
 * — so pdf.js itself is mocked here; only openPdfDocument's own
 * error-mapping logic is under test, not real PDF parsing/rendering.
 */
jest.mock('pdfjs-dist/build/pdf.worker.mjs', () => ({ WorkerMessageHandler: {} }), { virtual: true });
// Fakes are declared INSIDE the factory, not as outer consts — jest.mock
// factories are hoisted above the rest of the file, so a reference to an
// outer `class` declaration here would hit its temporal-dead-zone.
jest.mock('pdfjs-dist', () => ({
  getDocument: jest.fn(),
  PasswordException: class FakePasswordException extends Error {},
  InvalidPDFException: class FakeInvalidPDFException extends Error {},
}));

import { openPdfDocument, PdfImportError } from '@/lib/pdf-import';
import * as pdfjsLib from 'pdfjs-dist';

function makeFile(name = 'test.pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' });
}

/** getDocument() returns a "loading task" with .promise AND .destroy — the
 *  destroy call under test lives on this object, not on the resolved doc. */
function mockLoadingTask(promise: Promise<unknown>) {
  const destroy = jest.fn();
  (pdfjsLib.getDocument as jest.Mock).mockReturnValue({ promise, destroy });
  return destroy;
}

describe('openPdfDocument error mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps a PasswordException to a friendly PdfImportError, and destroys the loading task', async () => {
    const destroy = mockLoadingTask(Promise.reject(new pdfjsLib.PasswordException('needs password', 1)));
    await expect(openPdfDocument(makeFile())).rejects.toBeInstanceOf(PdfImportError);
    expect(destroy).toHaveBeenCalledTimes(1);
    mockLoadingTask(Promise.reject(new pdfjsLib.PasswordException('needs password', 1)));
    await expect(openPdfDocument(makeFile())).rejects.toThrow(/password-protected/i);
  });

  it('maps an InvalidPDFException to a friendly PdfImportError', async () => {
    mockLoadingTask(Promise.reject(new pdfjsLib.InvalidPDFException('bad structure')));
    await expect(openPdfDocument(makeFile())).rejects.toThrow(/doesn't look like a valid PDF/i);
  });

  it('maps an unrecognized failure to a generic friendly message', async () => {
    mockLoadingTask(Promise.reject(new Error('network blip')));
    await expect(openPdfDocument(makeFile())).rejects.toThrow(/couldn't be opened/i);
  });

  it('rejects a zero-page document with a friendly message, and destroys the loading task', async () => {
    const destroy = mockLoadingTask(Promise.resolve({ numPages: 0 }));
    await expect(openPdfDocument(makeFile())).rejects.toThrow(/no pages/i);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects a document over the page cap with a friendly message, and destroys the loading task', async () => {
    const destroy = mockLoadingTask(Promise.resolve({ numPages: 500 }));
    await expect(openPdfDocument(makeFile())).rejects.toThrow(/500 pages/i);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
