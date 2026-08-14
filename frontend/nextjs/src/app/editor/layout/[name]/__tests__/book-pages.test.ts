/**
 * Unit tests for the book page-count reconciliation (R1 — "customer-variable
 * surface count"). These pin the grow/shrink/restore round-trip: a page's
 * customer edits (photos, pans, overlays) must survive a page-count change
 * in either direction, and cover/backCover must never be touched by it.
 */
import { reconcilePageCount, roleForSurfaceKey } from '../book-pages';
import type { SurfaceState, CanvasItem } from '../types';
import type { BookLayoutLike } from '@/lib/book-layout';

const LAYOUT: BookLayoutLike = {
  productType: 'book',
  book: {
    pageCount: { min: 4, max: 16, step: 4, default: 8 },
    gutterMm: 10,
    cover: {
      canvas: { width: 1000, height: 800, widthMm: 210, heightMm: 168 },
      frames: [{ id: 'c0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
    },
    innerPage: {
      canvas: { width: 900, height: 700, widthMm: 190, heightMm: 148 },
      frames: [{ id: 'p0', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
    },
  },
};

function keys(surfaces: ReadonlyArray<SurfaceState>): string[] {
  return surfaces.map(s => s.key);
}

/** A canvas carrying a fake "customer edit" so we can assert it survives. */
function editedCanvas(marker: string): CanvasItem {
  return {
    id: 0,
    frames: [{
      id: 0, originalFile: null, fileName: marker, fileSize: 1,
      offset: { x: 5, y: -3 }, scale: 1.4, rotation: 90, fitMode: 'cover',
    }],
    overlays: [],
    bgColor: '#ffffff',
    paperColor: '#ffffff',
    dataUrl: null,
  };
}

describe('reconcilePageCount', () => {
  it('builds cover + N inner pages + back_cover at the template default', () => {
    const { visible, resolvedCount } = reconcilePageCount(LAYOUT, undefined, [], {});
    expect(resolvedCount).toBe(8);
    expect(keys(visible)).toEqual([
      'cover', 'page_01', 'page_02', 'page_03', 'page_04',
      'page_05', 'page_06', 'page_07', 'page_08', 'back_cover',
    ]);
  });

  it('clamps a requested count onto the min/max/step grid', () => {
    expect(reconcilePageCount(LAYOUT, 5, [], {}).resolvedCount).toBe(8); // snaps up
    expect(reconcilePageCount(LAYOUT, 1, [], {}).resolvedCount).toBe(4); // clamps to min
    expect(reconcilePageCount(LAYOUT, 999, [], {}).resolvedCount).toBe(16); // clamps to max
  });

  it('growing keeps existing pages\' edits and appends blank pages at the tail', () => {
    const first = reconcilePageCount(LAYOUT, 8, [], {});
    const edited = first.visible.map(s =>
      s.key === 'page_03' ? { ...s, canvases: [editedCanvas('photo-on-page-3.jpg')] } : s
    );

    const grown = reconcilePageCount(LAYOUT, 12, edited, {});
    expect(keys(grown.visible)).toEqual([
      'cover', 'page_01', 'page_02', 'page_03', 'page_04', 'page_05',
      'page_06', 'page_07', 'page_08', 'page_09', 'page_10', 'page_11',
      'page_12', 'back_cover',
    ]);
    const page3 = grown.visible.find(s => s.key === 'page_03')!;
    expect(page3.canvases[0].frames[0].fileName).toBe('photo-on-page-3.jpg');
    const page9 = grown.visible.find(s => s.key === 'page_09')!;
    expect(page9.canvases).toEqual([]);
  });

  it('shrinking stashes the trailing pages\' edits into the archive rather than discarding them', () => {
    const first = reconcilePageCount(LAYOUT, 12, [], {});
    const edited = first.visible.map(s =>
      s.key === 'page_11' ? { ...s, canvases: [editedCanvas('photo-on-page-11.jpg')] } : s
    );

    const shrunk = reconcilePageCount(LAYOUT, 8, edited, {});
    expect(keys(shrunk.visible)).toEqual([
      'cover', 'page_01', 'page_02', 'page_03', 'page_04',
      'page_05', 'page_06', 'page_07', 'page_08', 'back_cover',
    ]);
    expect(Object.keys(shrunk.archive).sort()).toEqual(['page_09', 'page_10', 'page_11', 'page_12']);
    expect(shrunk.archive['page_11'].canvases[0].frames[0].fileName).toBe('photo-on-page-11.jpg');
  });

  it('growing back restores a held page\'s edits from the archive', () => {
    const first = reconcilePageCount(LAYOUT, 12, [], {});
    const edited = first.visible.map(s =>
      s.key === 'page_11' ? { ...s, canvases: [editedCanvas('photo-on-page-11.jpg')] } : s
    );
    const shrunk = reconcilePageCount(LAYOUT, 8, edited, {});
    const regrown = reconcilePageCount(LAYOUT, 12, shrunk.visible, shrunk.archive);

    const page11 = regrown.visible.find(s => s.key === 'page_11')!;
    expect(page11.canvases[0].frames[0].fileName).toBe('photo-on-page-11.jpg');
    // The page moved back into `visible`, so it must no longer be archived.
    expect(regrown.archive['page_11']).toBeUndefined();
  });

  it('never moves cover or back_cover into the archive across any count change', () => {
    const first = reconcilePageCount(LAYOUT, 16, [], {});
    const withCoverEdit = first.visible.map(s =>
      s.key === 'cover' ? { ...s, canvases: [editedCanvas('cover-photo.jpg')] } : s
    );
    const shrunk = reconcilePageCount(LAYOUT, 4, withCoverEdit, {});

    expect(shrunk.archive['cover']).toBeUndefined();
    expect(shrunk.archive['back_cover']).toBeUndefined();
    const cover = shrunk.visible.find(s => s.key === 'cover')!;
    expect(cover.canvases[0].frames[0].fileName).toBe('cover-photo.jpg');
  });

  it('leaves a page untouched (same edits, refreshed label) when the count does not change', () => {
    const first = reconcilePageCount(LAYOUT, 8, [], {});
    const edited = first.visible.map(s =>
      s.key === 'page_02' ? { ...s, canvases: [editedCanvas('x.jpg')] } : s
    );
    const same = reconcilePageCount(LAYOUT, 8, edited, {});
    const page2 = same.visible.find(s => s.key === 'page_02')!;
    expect(page2.canvases[0].frames[0].fileName).toBe('x.jpg');
    expect(Object.keys(same.archive)).toHaveLength(0);
  });
});

describe('roleForSurfaceKey', () => {
  it('recognises the cover and back_cover keys', () => {
    expect(roleForSurfaceKey('cover')).toEqual({ role: 'cover', pageIndex: null });
    expect(roleForSurfaceKey('back_cover')).toEqual({ role: 'backCover', pageIndex: null });
  });

  it('extracts the 1-based page index from an inner page key', () => {
    expect(roleForSurfaceKey('page_01')).toEqual({ role: 'inner', pageIndex: 1 });
    expect(roleForSurfaceKey('page_12')).toEqual({ role: 'inner', pageIndex: 12 });
  });

  it('falls back to inner with a null index for an unrecognised key', () => {
    expect(roleForSurfaceKey('something_else')).toEqual({ role: 'inner', pageIndex: null });
  });
});
