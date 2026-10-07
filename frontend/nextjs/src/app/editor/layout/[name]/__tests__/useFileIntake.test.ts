import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useFileIntake } from '../useFileIntake';
import { reconcilePageCount } from '../book-pages';
import { duplicateFingerprint } from '@/lib/submit-guards';
import type { BookLayoutLike } from '@/lib/book-layout';
import type { NormalizedLayout } from '@/lib/layout-utils';
import type { CanvasItem, FrameState, SurfaceState } from '../types';

// HEIC "converts" by name; an .svg can't print; "cmyk" in a name is a CMYK
// JPEG; "cut" in a name is an incomplete download.
jest.mock('@/lib/heic-convert', () => ({
  isHeicFile: (f: File) => /\.heic$/i.test(f.name),
  convertHeicFileIfNeeded: jest.fn(async (f: File) => f),
  convertAndPartitionFiles: jest.fn(async (files: File[]) => ({
    accepted: files.filter(f => !/\.svg$/i.test(f.name)),
    warning: files.some(f => /\.svg$/i.test(f.name)) ? 'skipped logo.svg' : null,
  })),
}));
jest.mock('@/lib/image-utils', () => ({
  detectJpegColorSpace: jest.fn(async (f: File) => (/cmyk/.test(f.name) ? 'CMYK' : 'RGB')),
  isImageComplete: jest.fn(async (f: File) => !/cut/.test(f.name)),
}));

const LAYOUT = { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] };
const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg', lastModified: 1 });
const names = (fs: File[]) => fs.map(f => f.name);
const pick = (...files: File[]) => ({ target: { files } }) as unknown as React.ChangeEvent<HTMLInputElement>;
const generateCanvasesForLayout = jest.fn(async (_l: unknown, files: File[]) => files.map((f, i) => ({ id: i, dataUrl: `data:${f.name}` }) as CanvasItem));
const expandPdfPages = jest.fn(async (files: File[]) => files);

const BOOK = {
  name: 'book', productType: 'book',
  book: {
    pageCount: { min: 4, max: 16, step: 4, default: 4 }, gutterMm: 10,
    cover: { canvas: { width: 1000, height: 800 }, frames: [{ id: 'c', x: 0, y: 0, width: 1, height: 1 }] },
    innerPage: { canvas: { width: 900, height: 700 }, frames: [{ id: 'p', x: 0, y: 0, width: 1, height: 1 }] },
  },
} as unknown as BookLayoutLike;

type Init = {
  files?: File[]; canvases?: CanvasItem[]; surfaceStates?: SurfaceState[]; activeSurfaceKey?: string; orderQty?: number | null;
  isCalendarProduct?: boolean; book?: boolean; layout?: unknown; qtyUnder?: { uploaded: number; needed: number } | null;
};

/** The page's state around the hook, held the way the page holds it. */
function setup(init: Init = {}) {
  const uploadInput = document.createElement('input');
  const uploadClick = jest.spyOn(uploadInput, 'click').mockImplementation(() => {});
  const replaceInput = document.createElement('input');
  const replaceClick = jest.spyOn(replaceInput, 'click').mockImplementation(() => {});
  const bookStart = reconcilePageCount(BOOK, undefined, [], {});
  const hook = renderHook(() => {
    const [files, setFiles] = useState<File[]>(init.files ?? []);
    const [canvases, setCanvases] = useState<CanvasItem[]>(init.canvases ?? []);
    const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>(init.surfaceStates ?? (init.book ? bookStart.visible : []));
    const [bookPageCount, setBookPageCount] = useState(init.book ? bookStart.resolvedCount : 0);
    const [bookHiddenPages, setBookHiddenPages] = useState<Record<string, SurfaceState>>({});
    const [pendingBookOverflow, setPendingBookOverflow] = useState<{ files: File[]; currentCapacity: number; suggestedCount: number } | null>(null);
    const [qtyUnder, setQtyUnder] = useState(init.qtyUnder ?? null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [heicConverting, setHeicConverting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [colorWarning, setColorWarning] = useState<string | null>(null);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [unsupportedWarning, setUnsupportedWarning] = useState<string | null>(null);
    const canvasesRef = useRef(canvases); canvasesRef.current = canvases;
    const surfaceStatesRef = useRef(surfaceStates); surfaceStatesRef.current = surfaceStates;
    const bookHiddenPagesRef = useRef(bookHiddenPages); bookHiddenPagesRef.current = bookHiddenPages;
    const bookOverflowDecidedRef = useRef(false);
    const intentionalDupesRef = useRef(new Set<string>());
    const createdObjectURLs = useRef(new Set<string>(['blob:old']));
    const fileUrlCache = useRef(new WeakMap<File, string>());
    const skipNextGenerateRef = useRef(false);
    const uploadInputRef = useRef<HTMLInputElement | null>(uploadInput);
    const intake = useFileIntake({
      layout: init.layout ?? LAYOUT, files, setFiles, setCanvases, canvasesRef, surfaceStates, setSurfaceStates, surfaceStatesRef,
      activeSurfaceKey: init.activeSurfaceKey ?? (init.book ? 'cover' : 'front'),
      normalizedLayoutState: (init.book ? { _raw: BOOK } : { _raw: { name: 'x' } }) as unknown as NormalizedLayout,
      isCalendarProduct: init.isCalendarProduct ?? false, isBookProduct: init.book ?? false, bookPageCount, setBookPageCount,
      bookHiddenPages, setBookHiddenPages, bookHiddenPagesRef, bookOverflowDecidedRef, pendingBookOverflow, setPendingBookOverflow,
      orderQty: init.orderQty ?? null, qtyUnder, setQtyUnder, intentionalDupesRef, uploadInputRef, createdObjectURLs, fileUrlCache,
      generateCanvasesForLayout, skipNextGenerateRef, expandPdfPages, serverHeicConvert: undefined, setHeicConverting, setIsProcessing,
      setError, setColorWarning, setUploadWarning, setUnsupportedWarning,
    });
    intake.replacePhotoInputRef.current = replaceInput;
    return {
      ...intake, files, setFiles, canvases, surfaceStates, bookPageCount, bookHiddenPages, pendingBookOverflow, qtyUnder, isProcessing,
      heicConverting, error, colorWarning, uploadWarning, unsupportedWarning, intentionalDupesRef, createdObjectURLs, skipNextGenerateRef,
      bookOverflowDecidedRef,
    };
  });
  return { ...hook, uploadClick, replaceClick };
}
const run = async (fn: () => unknown) => { await act(async () => { await fn(); }); };

beforeEach(() => jest.clearAllMocks());

describe('useFileIntake — Add Photos', () => {
  it('appends: a second pick adds to the photos already there, never replaces them', async () => {
    const { result } = setup({ files: [photo('a.jpg')] });
    await run(() => result.current.handleFileChange(pick(photo('b.jpg'), photo('c.jpg'))));
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('starts every pick clean: previous preview URLs are revoked', async () => {
    const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { result } = setup();
    await run(() => result.current.handleFileChange(pick(photo('a.jpg'))));
    expect(revoke).toHaveBeenCalledWith('blob:old');
    expect(result.current.createdObjectURLs.current.size).toBe(0);
    revoke.mockRestore();
  });

  it('names files it can’t print, and keeps the rest', async () => {
    const { result } = setup();
    await run(() => result.current.handleFileChange(pick(photo('a.jpg'), new File(['x'], 'logo.svg'))));
    expect(result.current.unsupportedWarning).toBe('skipped logo.svg');
    expect(names(result.current.files)).toEqual(['a.jpg']);
  });

  it('a pick of nothing printable changes nothing', async () => {
    const { result } = setup({ files: [photo('a.jpg')] });
    await run(() => result.current.handleFileChange(pick(new File(['x'], 'logo.svg'))));
    expect(names(result.current.files)).toEqual(['a.jpg']);
  });

  it('flags a CMYK photo', async () => {
    const { result } = setup();
    await run(() => result.current.handleFileChange(pick(photo('cmyk-scan.jpg'))));
    expect(result.current.colorWarning).toMatch(/^"cmyk-scan.jpg" use CMYK colour/);
  });

  it('a calendar keeps at most 12 pages of photos, and says so', async () => {
    const { result } = setup({ isCalendarProduct: true });
    await run(() => result.current.handleFileChange(pick(...Array.from({ length: 14 }, (_, i) => photo(`p${i}.jpg`)))));
    expect(result.current.files).toHaveLength(12);
    expect(result.current.uploadWarning).toBe('Calendars hold 12 photos — only the first 12 were kept.');
  });

  it('a multi-surface product deals the pick across its sides, one per print area', async () => {
    const side = (key: string) => ({ key, label: key, def: { frames: [{}] }, files: [], canvases: [], globalFitMode: 'cover' }) as unknown as SurfaceState;
    const { result } = setup({ surfaceStates: [side('front'), side('back')], activeSurfaceKey: 'back' });
    await run(() => result.current.handleFileChange(pick(photo('f.jpg'), photo('b.jpg'), photo('extra.jpg'))));
    expect(result.current.surfaceStates.map(s => names(s.files))).toEqual([['f.jpg'], ['b.jpg']]);
    expect(names(result.current.files)).toEqual(['b.jpg']);
    expect(result.current.canvases[0].dataUrl).toBe('data:b.jpg');
    expect(result.current.uploadWarning).toBe('Only 2 images were selected.');
    expect(result.current.isProcessing).toBe(false);
  });
});

describe('useFileIntake — the ordered quantity', () => {
  it('under the order: warns with the counts, and still takes the photos', async () => {
    const { result } = setup({ orderQty: 5 });
    await run(() => result.current.handleFileChange(pick(photo('a.jpg'), photo('b.jpg'))));
    expect(result.current.qtyUnder).toEqual({ uploaded: 2, needed: 5 });
    expect(result.current.files).toHaveLength(2);
  });

  it('over the order: a hard cap — the pick is held, and "Keep first N" keeps exactly N', async () => {
    const { result } = setup({ orderQty: 2, files: [photo('a.jpg')] });
    await run(() => result.current.handleFileChange(pick(photo('b.jpg'), photo('c.jpg'))));
    expect(names(result.current.pendingOverFiles!)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(names(result.current.files)).toEqual(['a.jpg']);
    act(() => result.current.handleOverConfirm(true));
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.current.pendingOverFiles).toBeNull();
  });

  it('"Choose again" drops the pick and reopens the picker', async () => {
    const { result, uploadClick } = setup({ orderQty: 2, files: [photo('a.jpg'), photo('b.jpg')] });
    await run(() => result.current.handleFileChange(pick(photo('c.jpg'))));
    act(() => result.current.handleOverConfirm(false));
    expect(uploadClick).toHaveBeenCalledTimes(1);
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.current.pendingOverFiles).toBeNull();
  });

  it('filling an order with repeats: the picked photos first, then cycling, all marked deliberate', async () => {
    const files = [photo('a.jpg'), photo('b.jpg')];
    const { result } = setup({ files, qtyUnder: { uploaded: 2, needed: 5 } });
    act(() => { result.current.setPickerSelected(new Set([1])); result.current.setShowAutoFillPicker(true); });
    act(() => result.current.handleFillWithPicked());
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg', 'b.jpg', 'a.jpg', 'b.jpg']);
    expect(result.current.intentionalDupesRef.current).toEqual(new Set(files.map(duplicateFingerprint)));
    expect(result.current.qtyUnder).toBeNull();
    expect(result.current.showAutoFillPicker).toBe(false);
    expect(result.current.pickerSelected.size).toBe(0);
  });
});

describe('useFileIntake — prompts that hold a pick', () => {
  it('an incomplete photo holds the pick; Remove drops it, Keep keeps it', async () => {
    const { result } = setup({ files: [photo('a.jpg')] });
    await run(() => result.current.handleFileChange(pick(photo('cut.jpg'), photo('b.jpg'))));
    expect(names(result.current.pendingTruncated!.bad)).toEqual(['cut.jpg']);
    expect(names(result.current.files)).toEqual(['a.jpg']);
    await run(() => result.current.handleTruncatedDecision('remove'));
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg']);
    await run(() => result.current.handleFileChange(pick(photo('cut2.jpg'))));
    await run(() => result.current.handleTruncatedDecision('keep'));
    expect(names(result.current.files)).toEqual(['a.jpg', 'b.jpg', 'cut2.jpg']);
  });

  it('removing every photo of a pick as incomplete says so', async () => {
    const { result } = setup();
    await run(() => result.current.handleFileChange(pick(photo('cut.jpg'))));
    await run(() => result.current.handleTruncatedDecision('remove'));
    expect(result.current.unsupportedWarning).toBe('All selected image was incomplete and removed — please re-upload.');
    expect(result.current.files).toEqual([]);
  });

  it('a pick that would drop edited pages asks first; Replace proceeds, Keep leaves everything', async () => {
    const edited = { id: 0, overlays: [], bgColor: '#ffffff', paperColor: '#ffffff', dataUrl: null,
      frames: [{ id: 0, originalFile: photo('old.jpg'), offset: { x: 30, y: 0 }, scale: 1, rotation: 0 } as FrameState] } as CanvasItem;
    const { result } = setup({ canvases: [edited] });
    await run(() => result.current.handleFileChange(pick(photo('new.jpg'))));
    expect(result.current.pendingRepick).toMatchObject({ losingCount: 1 });
    expect(result.current.files).toEqual([]);
    await run(() => result.current.handleRepickConfirm(false));
    expect(result.current.files).toEqual([]);
    await run(() => result.current.handleFileChange(pick(photo('new.jpg'))));
    await run(() => result.current.handleRepickConfirm(true));
    expect(names(result.current.files)).toEqual(['new.jpg']);
  });

  it('a book with more photos than pages offers to extend; Extend adds the pages', async () => {
    const { result } = setup({ book: true });
    const many = Array.from({ length: 9 }, (_, i) => photo(`p${i}.jpg`));
    await run(() => result.current.handleFileChange(pick(...many)));
    expect(result.current.pendingBookOverflow).toMatchObject({ currentCapacity: 6, suggestedCount: 8 });
    await run(() => result.current.handleBookOverflowDecision('extend'));
    expect(result.current.bookPageCount).toBe(8);
    expect(result.current.surfaceStates.flatMap(s => names(s.files))).toEqual(names(many));
    expect(result.current.bookOverflowDecidedRef.current).toBe(false);
  });

  it('Keep-as-is uses the pages there are, and says how many photos fit', async () => {
    const { result } = setup({ book: true });
    await run(() => result.current.handleFileChange(pick(...Array.from({ length: 9 }, (_, i) => photo(`p${i}.jpg`)))));
    await run(() => result.current.handleBookOverflowDecision('keep'));
    expect(result.current.bookPageCount).toBe(4);
    expect(result.current.surfaceStates.flatMap(s => s.files)).toHaveLength(6);
    expect(result.current.uploadWarning).toBe('Only 6 images were selected.');
  });
});

describe('useFileIntake — Replace photo', () => {
  it('asks for one photo and puts it in exactly that slot', async () => {
    const { result, replaceClick } = setup({ files: [photo('a.jpg'), photo('b.jpg')] });
    act(() => result.current.requestReplacePhoto(1, 0));
    expect(replaceClick).toHaveBeenCalledTimes(1);
    await run(() => result.current.handleReplaceFileSelected(photo('new.jpg')));
    expect(expandPdfPages).toHaveBeenCalledWith([expect.any(File)], { maxSelectable: 1 });
    expect(names(result.current.files)).toEqual(['a.jpg', 'new.jpg']);
  });

  it('on a collage, replaces that frame of that card', async () => {
    const collage = { ...LAYOUT, frames: [LAYOUT.frames[0], LAYOUT.frames[0]] };
    const { result } = setup({ layout: collage, files: ['1', '2', '3', '4'].map(n => photo(`${n}.jpg`)) });
    act(() => result.current.requestReplacePhoto(1, 1));
    await run(() => result.current.handleReplaceFileSelected(photo('new.jpg')));
    expect(names(result.current.files)).toEqual(['1.jpg', '2.jpg', '3.jpg', 'new.jpg']);
  });

  it('refuses a file it can’t print, and an incomplete one', async () => {
    const { result } = setup({ files: [photo('a.jpg')] });
    act(() => result.current.requestReplacePhoto(0, 0));
    await run(() => result.current.handleReplaceFileSelected(new File(['x'], 'logo.svg')));
    expect(result.current.unsupportedWarning).toMatch(/logo\.svg/);
    act(() => result.current.requestReplacePhoto(0, 0));
    await run(() => result.current.handleReplaceFileSelected(photo('cut.jpg')));
    expect(result.current.error).toBe('That image appears incomplete — please re-export it and try again.');
    expect(names(result.current.files)).toEqual(['a.jpg']);
  });

  it('does nothing without a requested slot', async () => {
    const { result } = setup({ files: [photo('a.jpg')] });
    await run(() => result.current.handleReplaceFileSelected(photo('new.jpg')));
    expect(names(result.current.files)).toEqual(['a.jpg']);
  });

  it('on a side of a multi-surface product, rebuilds that side and skips the page’s own rebuild', async () => {
    const back = { key: 'back', label: 'Back', def: { frames: [{}] }, files: [photo('b.jpg')], canvases: [], globalFitMode: 'cover' } as unknown as SurfaceState;
    const { result } = setup({ surfaceStates: [back], activeSurfaceKey: 'back', files: [photo('b.jpg')] });
    act(() => result.current.requestReplacePhoto(0, 0, 'back'));
    await run(() => result.current.handleReplaceFileSelected(photo('new.jpg')));
    expect(names(result.current.surfaceStates[0].files)).toEqual(['new.jpg']);
    expect(names(result.current.files)).toEqual(['new.jpg']);
    expect(result.current.skipNextGenerateRef.current).toBe(true);
  });
});
