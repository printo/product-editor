import { RestoredPhotos, restoreNoteForCard, type RestoredPhotoStatus } from '../restored-photos';
import { fileIdsInCardOrder, fillRestoredPhotos } from '../useParentRestore';
import type { CanvasItem, FrameState, Overlay } from '../types';

const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const frame = (fileId: string | undefined, originalFile: File | null = null): FrameState =>
  ({ id: 0, originalFile, fileId, offset: { x: 4, y: 2 }, scale: 1.3, rotation: 90, fitMode: 'cover' });
const sticker = (fileId: string, originalFile?: File): Overlay =>
  ({ type: 'image', id: fileId, src: 'blob:gone', source: 'local', fileId, originalFile, label: '', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1 });
const card = (frames: FrameState[], overlays: Overlay[] = [], dataUrl: string | null = 'old'): CanvasItem =>
  ({ id: 0, frames, overlays, bgColor: '#fff', paperColor: '#fff', dataUrl });

describe('RestoredPhotos', () => {
  it('knows a preview from a real photo, and which upload it stands for', () => {
    const photos = new RestoredPhotos();
    const preview = file('a.jpg');
    const own = file('b.jpg');
    photos.addStandIn(preview, { uploadId: 'up-1', width: 3000, height: 4000, fileId: 'f-1' });
    expect(photos.isStandIn(preview)).toBe(true);
    expect(photos.isStandIn(own)).toBe(false);
    expect(photos.isStandIn(null)).toBe(false);
    expect(photos.serverPhotoOf(preview)?.uploadId).toBe('up-1');
    expect(photos.serverPhotoOf(own)).toBeUndefined();
    expect(photos.standInWithoutUpload([preview, own])).toEqual([]);
  });
  it('names a preview with no upload on record, so the submit can stop', () => {
    const photos = new RestoredPhotos();
    const preview = file('a.jpg');
    photos.addStandIn(preview, { uploadId: '', width: 1, height: 1, fileId: 'f-1' });
    expect(photos.standInWithoutUpload([preview])).toEqual([preview]);
  });
});

describe('restoreNoteForCard', () => {
  const status = (entries: Array<[string, RestoredPhotoStatus]>) => new Map(entries);
  it('says nothing without a restore in play, or once the photo is there', () => {
    expect(restoreNoteForCard(card([frame('f-1')]), undefined)).toBeNull();
    expect(restoreNoteForCard(card([frame('f-1')]), status([]))).toBeNull();
    expect(restoreNoteForCard(card([frame('f-1', file('a.jpg'))]), status([['f-1', 'arriving']]))).toBeNull();
    expect(restoreNoteForCard(card([frame('f-9')]), status([['f-1', 'arriving']]))).toBeNull();
  });
  it('reports photos still on their way', () => {
    expect(restoreNoteForCard(card([frame('f-1')]), status([['f-1', 'arriving']]))).toEqual({ state: 'arriving', fileIds: ['f-1'] });
  });
  it('a failed photo outranks an arriving one, and added images count too', () => {
    const c = card([frame('f-1')], [sticker('f-2')]);
    expect(restoreNoteForCard(c, status([['f-1', 'arriving'], ['f-2', 'failed']]))).toEqual({ state: 'failed', fileIds: ['f-2'] });
  });
});

describe('fileIdsInCardOrder', () => {
  it('lists each photo once, first card first, added images included', () => {
    const surfaces = [
      { canvases: [card([frame('f-2')], [sticker('s-1')]), card([frame('f-1'), frame(undefined)])] },
      { canvases: [card([frame('f-2')]), card([frame('f-3')])] },
    ];
    expect(fileIdsInCardOrder(surfaces)).toEqual(['f-2', 's-1', 'f-1', 'f-3']);
  });
});

describe('fillRestoredPhotos', () => {
  const url = (f: File) => `blob:${f.name}`;
  it('puts an arrived photo into every card that names it, keeping the crop and turn', () => {
    const a = file('a.jpg');
    const cards = [card([frame('f-1')]), card([frame('f-2')]), card([frame('f-1')])];
    const { canvases, changed } = fillRestoredPhotos(cards, new Map([['f-1', a]]), url);
    expect(changed).toEqual([0, 2]);
    expect(canvases[0].frames[0]).toEqual({ ...cards[0].frames[0], originalFile: a });
    expect(canvases[1]).toBe(cards[1]);
    expect(canvases[2].frames[0].originalFile).toBe(a);
  });
  it('never replaces a photo already in place', () => {
    const mine = file('mine.jpg');
    const cards = [card([frame('f-1', mine)])];
    const out = fillRestoredPhotos(cards, new Map([['f-1', file('a.jpg')]]), url);
    expect(out.canvases).toBe(cards);
    expect(out.changed).toEqual([]);
  });
  it('fills an added image and gives it a fresh address', () => {
    const s = file('sticker.png');
    const { canvases } = fillRestoredPhotos([card([], [sticker('s-1')])], new Map([['s-1', s]]), url);
    expect(canvases[0].overlays[0]).toEqual(expect.objectContaining({ originalFile: s, src: 'blob:sticker.png' }));
  });
});
