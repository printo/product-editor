/**
 * Unit tests for multi-surface photo allocation.
 *
 * The regression these pin: a surface with two print areas (a book spread)
 * used to receive one photo, which the generator's modulo then duplicated into
 * both areas — so the customer's photo printed twice on the same spread.
 */
import {
  allocateFilesToSurfaces,
  planFrameSlots,
  surfaceFrameCount,
  totalSurfaceCapacity,
} from '../surface-allocation';

let fileCounter = 0;
function makeFile(name: string): File {
  const f = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(f, 'lastModified', { value: 1700000000000 + fileCounter++ });
  return f;
}

/** A surface whose def declares `n` frames. */
function surface(n: number) {
  return { def: { frames: Array.from({ length: n }, () => ({})) } };
}

const names = (out: File[][]) => out.map(files => files.map(f => f.name));

describe('surfaceFrameCount', () => {
  it('reads the frame count off the surface def', () => {
    expect(surfaceFrameCount(surface(3).def)).toBe(3);
  });

  it('floors at 1 for a missing, empty or absent frames array', () => {
    expect(surfaceFrameCount({ frames: [] })).toBe(1);
    expect(surfaceFrameCount({})).toBe(1);
    expect(surfaceFrameCount(null)).toBe(1);
    expect(surfaceFrameCount(undefined)).toBe(1);
  });
});

describe('totalSurfaceCapacity', () => {
  it('sums each surface\'s own frame count, not the surface count', () => {
    // 4 spreads × 2 pages = 8 photos, where the old code allowed 4.
    expect(totalSurfaceCapacity([surface(2), surface(2), surface(2), surface(2)])).toBe(8);
  });

  it('handles mixed cover/inner frame counts', () => {
    // front cover (1) + spread (2) + spread (2) + back cover (1)
    expect(totalSurfaceCapacity([surface(1), surface(2), surface(2), surface(1)])).toBe(6);
  });

  it('matches the surface count when every surface holds one frame', () => {
    expect(totalSurfaceCapacity([surface(1), surface(1)])).toBe(2);
  });
});

describe('allocateFilesToSurfaces', () => {
  it('gives a two-frame spread two DIFFERENT photos', () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg')];
    expect(names(allocateFilesToSurfaces([surface(2)], files))).toEqual([['a.jpg', 'b.jpg']]);
  });

  it('fills surfaces in order, consuming each surface\'s frame count', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => makeFile(`${n}.jpg`));
    const out = allocateFilesToSurfaces([surface(1), surface(2), surface(2), surface(1)], files);
    expect(names(out)).toEqual([['a.jpg'], ['b.jpg', 'c.jpg'], ['d.jpg', 'e.jpg'], ['f.jpg']]);
  });

  it('preserves the one-photo-per-surface result for single-frame surfaces', () => {
    // The laptop-sleeve case — behaviour must be unchanged.
    const files = [makeFile('front.jpg'), makeFile('back.jpg')];
    expect(names(allocateFilesToSurfaces([surface(1), surface(1)], files)))
      .toEqual([['front.jpg'], ['back.jpg']]);
  });

  it('leaves trailing surfaces empty when there are too few photos', () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    const out = allocateFilesToSurfaces([surface(2), surface(2)], files);
    expect(names(out)).toEqual([['a.jpg', 'b.jpg'], ['c.jpg']]);
  });

  it('returns empty arrays for every surface when nothing is selected', () => {
    expect(names(allocateFilesToSurfaces([surface(2), surface(1)], []))).toEqual([[], []]);
  });

  it('drops files beyond total capacity rather than wrapping them', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map(n => makeFile(`${n}.jpg`));
    const out = allocateFilesToSurfaces([surface(2), surface(1)], files);
    expect(names(out)).toEqual([['a.jpg', 'b.jpg'], ['c.jpg']]);
    expect(out.flat()).toHaveLength(3);
  });

  it('never hands the same file to two slots', () => {
    const files = ['a', 'b', 'c', 'd'].map(n => makeFile(`${n}.jpg`));
    const flat = allocateFilesToSurfaces([surface(2), surface(2)], files).flat();
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe('planFrameSlots', () => {
  const slotNames = (slots: (File | null)[][]) =>
    slots.map(row => row.map(f => f?.name ?? null));

  it('repeats one photo across every slot of a repeat-fill sheet', () => {
    // passport_prints: 6 frames, 1 photo → 6 copies. Load-bearing behaviour.
    const [photo] = [makeFile('passport.jpg')];
    expect(slotNames(planFrameSlots([photo], 6, 1))).toEqual([
      ['passport.jpg', 'passport.jpg', 'passport.jpg',
       'passport.jpg', 'passport.jpg', 'passport.jpg'],
    ]);
  });

  it('gives distinct photos when the sheet is fully supplied', () => {
    const files = ['a', 'b', 'c', 'd'].map(n => makeFile(`${n}.jpg`));
    expect(slotNames(planFrameSlots(files, 4, 1)))
      .toEqual([['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']]);
  });

  it('spills across canvases in order', () => {
    const files = ['a', 'b', 'c', 'd'].map(n => makeFile(`${n}.jpg`));
    expect(slotNames(planFrameSlots(files, 2, 2)))
      .toEqual([['a.jpg', 'b.jpg'], ['c.jpg', 'd.jpg']]);
  });

  it('yields empty slots rather than throwing on an empty selection', () => {
    expect(slotNames(planFrameSlots([], 2, 1))).toEqual([[null, null]]);
  });
});

describe('allocation → slot planning (the reported bug)', () => {
  /** What a surface's canvases actually end up holding, end to end. */
  function slotsForSurfaces(frameCounts: number[], files: File[]): (string | null)[][] {
    const surfaces = frameCounts.map(surface);
    return allocateFilesToSurfaces(surfaces, files).map((surfaceFiles, i) => {
      const frameCount = frameCounts[i];
      const canvasCount = Math.ceil(surfaceFiles.length / frameCount);
      return planFrameSlots(surfaceFiles, frameCount, canvasCount)
        .flat()
        .map(f => f?.name ?? null);
    });
  }

  it('no longer prints the same photo twice on a two-page spread', () => {
    // 4 spreads × 2 pages, 8 photos. Before the fix each spread received one
    // photo and the modulo duplicated it into both print areas.
    const files = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map(n => makeFile(`${n}.jpg`));
    expect(slotsForSurfaces([2, 2, 2, 2], files)).toEqual([
      ['p1.jpg', 'p2.jpg'],
      ['p3.jpg', 'p4.jpg'],
      ['p5.jpg', 'p6.jpg'],
      ['p7.jpg', 'p8.jpg'],
    ]);
  });

  it('handles a cover + spreads product with mixed frame counts', () => {
    const files = ['c', 'a', 'b', 'd'].map(n => makeFile(`${n}.jpg`));
    expect(slotsForSurfaces([1, 2, 1], files)).toEqual([
      ['c.jpg'],
      ['a.jpg', 'b.jpg'],
      ['d.jpg'],
    ]);
  });

  it('leaves single-frame surfaces exactly as they were', () => {
    // laptop_sleeve — front / back, one frame each. No behaviour change.
    const files = [makeFile('front.jpg'), makeFile('back.jpg')];
    expect(slotsForSurfaces([1, 1], files)).toEqual([['front.jpg'], ['back.jpg']]);
  });

  it('still repeats within a spread when the customer under-supplies photos', () => {
    // 2 spreads (4 pages) but only 3 photos: the last spread gets one photo,
    // which the modulo repeats. Documented behaviour, revisited by the
    // photobook under-fill policy.
    const files = ['a', 'b', 'c'].map(n => makeFile(`${n}.jpg`));
    expect(slotsForSurfaces([2, 2], files)).toEqual([
      ['a.jpg', 'b.jpg'],
      ['c.jpg', 'c.jpg'],
    ]);
  });
});
