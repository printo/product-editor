/**
 * Tests for the calendar cell-image upload orchestrator
 * (CALENDAR_FEATURE_PRD §5 Phase 8).
 *
 * The helper composes existing chunked-upload + file-store + ml-orientation
 * primitives, so the tests focus on:
 *  - file validation (MIME / size / empty / null)
 *  - orchestrator wiring (parallel upload + IDB save, both must succeed)
 *  - blob URL creation
 *  - test-seam ergonomics (uploadFn + saveFileFn override cleanly)
 *  - graceful auto-orientation failure (never blocks upload)
 *
 * @jest-environment @happy-dom/jest-environment
 */
import {
  CalendarCellUploadError,
  uploadCalendarCellImage,
  validateCellImageFile,
} from '@/lib/calendar-cell-upload';
import type { UploadResult } from '@/lib/upload-utils';

// happy-dom polyfill for URL.createObjectURL — track calls + return a stub URL.
const createObjectURLSpy = jest.fn(() => 'blob:fake-url');
beforeAll(() => {
  global.URL.createObjectURL = createObjectURLSpy;
});
beforeEach(() => createObjectURLSpy.mockClear());

function makeFile(name = 'photo.jpg', type = 'image/jpeg', size = 1024): File {
  // Build a File with arbitrary content of the requested size so size guard
  // tests don't depend on a real binary blob.
  const buf = new Uint8Array(size);
  return new File([buf], name, { type });
}

// ─── validateCellImageFile ──────────────────────────────────────────────────

describe('validateCellImageFile', () => {
  it('accepts a typical jpeg', () => {
    const f = makeFile();
    expect(validateCellImageFile(f)).toBe(f);
  });

  it('accepts png / webp / heic', () => {
    expect(() => validateCellImageFile(makeFile('a.png', 'image/png'))).not.toThrow();
    expect(() => validateCellImageFile(makeFile('a.webp', 'image/webp'))).not.toThrow();
    expect(() => validateCellImageFile(makeFile('a.heic', 'image/heic'))).not.toThrow();
  });

  it('accepts an image with empty mime when the type starts with image/', () => {
    expect(() => validateCellImageFile(makeFile('a.png', ''))).not.toThrow();
  });

  it('rejects a 0-byte file as empty', () => {
    expect(() => validateCellImageFile(makeFile('a.jpg', 'image/jpeg', 0)))
      .toThrow(CalendarCellUploadError);
  });

  it('rejects a file over 50 MB', () => {
    const big = makeFile('big.jpg', 'image/jpeg', 51 * 1024 * 1024);
    expect(() => validateCellImageFile(big)).toThrow(/exceeds the 50 MB limit/);
  });

  it('rejects a non-image MIME type', () => {
    const pdf = makeFile('doc.pdf', 'application/pdf', 1024);
    expect(() => validateCellImageFile(pdf)).toThrow(/isn't supported/);
  });
});

// ─── uploadCalendarCellImage — orchestrator ─────────────────────────────────

describe('uploadCalendarCellImage', () => {
  function setup(overrides: Partial<Parameters<typeof uploadCalendarCellImage>[1]> = {}) {
    const uploadResult: UploadResult = {
      uploadId: 'upload-xyz',
      filePath: '/uploads/xyz.jpg',
      filename: 'photo.jpg',
    };
    const uploadFn = jest.fn().mockResolvedValue(uploadResult);
    const saveFileFn = jest.fn().mockResolvedValue('file-id-abc');
    const opts = {
      apiBase: '/api',
      orderId: 'ORDER-1',
      getAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer test' })),
      uploadFn,
      saveFileFn,
      ...overrides,
    };
    return { opts, uploadFn, saveFileFn };
  }

  it('uploads via uploadFn AND saves to IDB, returning all the right fields', async () => {
    const { opts, uploadFn, saveFileFn } = setup();
    const file = makeFile();
    const result = await uploadCalendarCellImage(file, opts);
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(saveFileFn).toHaveBeenCalledTimes(1);
    expect(saveFileFn).toHaveBeenCalledWith('ORDER-1', file);
    expect(result.uploadId).toBe('upload-xyz');
    expect(result.fileId).toBe('file-id-abc');
    expect(result.filename).toBe('photo.jpg');
    expect(result.blobUrl).toBe('blob:fake-url');
    expect(createObjectURLSpy).toHaveBeenCalledWith(file);
    expect(result.rotation).toBeUndefined(); // autoOrient defaults to false
  });

  it('runs upload + IDB-save in parallel', async () => {
    // Both functions await a release token; if the orchestrator awaited them
    // sequentially the second wouldn't start until the first finished. We
    // verify the second STARTS before the first FINISHES.
    let releaseUpload!: () => void;
    let releaseSave!: () => void;
    const uploadStarted = jest.fn();
    const saveStarted = jest.fn();

    const uploadFn = jest.fn(async () => {
      uploadStarted();
      await new Promise<void>(r => { releaseUpload = r; });
      return { uploadId: 'u', filePath: '/p', filename: 'f' };
    });
    const saveFileFn = jest.fn(async () => {
      saveStarted();
      await new Promise<void>(r => { releaseSave = r; });
      return 'fid';
    });

    const promise = uploadCalendarCellImage(makeFile(), {
      apiBase: '/api',
      orderId: 'O',
      getAuthHeaders: () => ({}),
      uploadFn,
      saveFileFn,
    });

    // Both should have started before we release either.
    await Promise.resolve(); // microtask flush
    expect(uploadStarted).toHaveBeenCalled();
    expect(saveStarted).toHaveBeenCalled();
    releaseUpload();
    releaseSave();
    await expect(promise).resolves.toBeDefined();
  });

  it('throws CalendarCellUploadError immediately when validation fails', async () => {
    const { opts, uploadFn, saveFileFn } = setup();
    const bad = makeFile('a.pdf', 'application/pdf');
    await expect(uploadCalendarCellImage(bad, opts)).rejects.toThrow(CalendarCellUploadError);
    expect(uploadFn).not.toHaveBeenCalled();
    expect(saveFileFn).not.toHaveBeenCalled();
  });

  it('propagates uploader errors with the original message', async () => {
    const { opts, uploadFn } = setup();
    uploadFn.mockRejectedValueOnce(new Error('network down'));
    await expect(uploadCalendarCellImage(makeFile(), opts)).rejects.toThrow(/network down/);
  });

  it('propagates IDB save errors with the original message', async () => {
    const { opts, saveFileFn } = setup();
    saveFileFn.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(uploadCalendarCellImage(makeFile(), opts)).rejects.toThrow(/quota exceeded/);
  });

  it('falls back gracefully when autoOrient is enabled but orientation throws', async () => {
    const { opts } = setup({ autoOrient: true });
    // No mock for detectFileOrientation — happy-dom has no real fetch, so
    // the call will reject. The orchestrator must swallow it and still
    // resolve normally with rotation=undefined.
    const result = await uploadCalendarCellImage(makeFile(), opts);
    expect(result.uploadId).toBe('upload-xyz');
    expect(result.rotation).toBeUndefined();
  });
});
