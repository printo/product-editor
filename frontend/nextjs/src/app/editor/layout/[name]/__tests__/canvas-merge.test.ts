/**
 * Unit tests for the identity-based canvas/frame reuse planner
 * (Phase 3 — "never lose edits").
 */
import {
  canvasHasRealEdits,
  countCanvasesLosingEdits,
  planCanvasReuse,
} from '../canvas-merge';
import type { CanvasItem, FrameState } from '../types';

let fileCounter = 0;
function makeFile(name: string): File {
  const f = new File(['x'.repeat(10 + (fileCounter % 7))], name, { type: 'image/jpeg' });
  Object.defineProperty(f, 'lastModified', { value: 1700000000000 + fileCounter++ });
  return f;
}

function frame(file: File | null, edits: Partial<FrameState> = {}): FrameState {
  return {
    id: 0,
    originalFile: file,
    offset: { x: 0, y: 0 },
    scale: 1,
    rotation: 0,
    fitMode: 'cover',
    ...edits,
  };
}

function canvas(id: number, frames: FrameState[], extra: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id,
    frames,
    overlays: [],
    bgColor: '#ffffff',
    paperColor: '#ffffff',
    dataUrl: `thumb-${id}`,
    ...extra,
  };
}

describe('planCanvasReuse', () => {
  it('same files, same order → every frame and canvas carry preserved (incl. thumbnails)', () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')];
    const existing = [
      canvas(0, [frame(a, { offset: { x: -12, y: 3 }, scale: 1.4 })], { overlays: [{ id: 1 } as never] }),
      canvas(1, [frame(b, { rotation: 90 })], { bgColor: '#112233' }),
    ];
    const plan = planCanvasReuse(existing, [[a], [b]]);

    expect(plan.frames[0][0]?.offset).toEqual({ x: -12, y: 3 });
    expect(plan.frames[1][0]?.rotation).toBe(90);
    expect(plan.carry[0]?.overlays).toHaveLength(1);
    expect(plan.carry[0]?.dataUrl).toBe('thumb-0');
    expect(plan.carry[1]?.bgColor).toBe('#112233');
  });

  it('appending a file leaves originals untouched and gives the new canvas defaults', () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')];
    const existing = [canvas(0, [frame(a, { scale: 2 })])];
    const plan = planCanvasReuse(existing, [[a], [b]]);

    expect(plan.frames[0][0]?.scale).toBe(2);
    expect(plan.frames[1][0]).toBeNull();
    expect(plan.carry[1]).toBeNull();
  });

  it('reordering files → transforms follow the FILE; stale thumbnails dropped', () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')];
    const existing = [
      canvas(0, [frame(a, { scale: 3 })]),
      canvas(1, [frame(b, { scale: 5 })]),
    ];
    const plan = planCanvasReuse(existing, [[b], [a]]);

    expect(plan.frames[0][0]?.scale).toBe(5);
    expect(plan.frames[1][0]?.scale).toBe(3);
    // Canvas carry still applies (whole page moved), but the cached
    // thumbnail belongs to a different grid slot — must re-render.
    expect(plan.carry[0]?.dataUrl).toBeNull();
    expect(plan.carry[1]?.dataUrl).toBeNull();
  });

  it('duplicate files claim edits at most once, in stable order', () => {
    const a = makeFile('a.jpg');
    const existing = [canvas(0, [frame(a, { scale: 7 })])];
    // The same File object fills two slots (auto-fill cycling).
    const plan = planCanvasReuse(existing, [[a], [a]]);

    expect(plan.frames[0][0]?.scale).toBe(7);
    expect(plan.frames[1][0]).toBeNull();
  });

  it('multi-frame canvas only carries overlays when ALL its photos moved together', () => {
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    const existing = [
      canvas(0, [frame(a, { scale: 2 }), frame(b, { scale: 3 })], { overlays: [{ id: 9 } as never] }),
    ];
    // b is replaced by c: frame a keeps its edits, but the canvas-level
    // overlays must NOT carry (the page is no longer the same page).
    const plan = planCanvasReuse(existing, [[a, c]]);

    expect(plan.frames[0][0]?.scale).toBe(2);
    expect(plan.frames[0][1]).toBeNull();
    expect(plan.carry[0]).toBeNull();
  });

  it('splitting a two-frame page across two pages does not duplicate its overlays', () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')];
    const existing = [
      canvas(0, [frame(a), frame(b)], { overlays: [{ id: 1 } as never] }),
    ];
    const plan = planCanvasReuse(existing, [[a, null], [b, null]]);

    // Frames follow their files; overlays follow neither (the source page
    // did not move whole).
    expect(plan.frames[0][0]).not.toBeNull();
    expect(plan.frames[1][0]).not.toBeNull();
    expect(plan.carry[0]).toBeNull();
    expect(plan.carry[1]).toBeNull();
  });

  it('delete-splice keeps later canvases aligned (frameCount 1)', () => {
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    const existing = [
      canvas(0, [frame(a, { scale: 2 })]),
      canvas(1, [frame(b, { scale: 3 })], { overlays: [{ id: 2 } as never] }),
      canvas(2, [frame(c, { scale: 4 })]),
    ];
    // Canvas 0 deleted → files [b, c], canvases spliced the same way.
    const remaining = [existing[1], existing[2]];
    const plan = planCanvasReuse(remaining, [[b], [c]]);

    expect(plan.frames[0][0]?.scale).toBe(3);
    expect(plan.carry[0]?.overlays).toHaveLength(1);
    expect(plan.frames[1][0]?.scale).toBe(4);
  });
});

describe('canvasHasRealEdits / countCanvasesLosingEdits', () => {
  it('detects transforms, overlays and colours as real edits', () => {
    const a = makeFile('a.jpg');
    expect(canvasHasRealEdits(canvas(0, [frame(a)]))).toBe(false);
    expect(canvasHasRealEdits(canvas(0, [frame(a, { scale: 1.2 })]))).toBe(true);
    expect(canvasHasRealEdits(canvas(0, [frame(a)], { overlays: [{ id: 1 } as never] }))).toBe(true);
    expect(canvasHasRealEdits(canvas(0, [frame(a)], { bgColor: '#000000' }))).toBe(true);
  });

  it('counts only edited canvases whose files vanish from the new selection', () => {
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    const existing = [
      canvas(0, [frame(a, { scale: 2 })]),   // edited, file kept
      canvas(1, [frame(b, { scale: 2 })]),   // edited, file dropped
      canvas(2, [frame(c)]),                 // unedited, file dropped
    ];
    expect(countCanvasesLosingEdits(existing, [a])).toBe(1);
    expect(countCanvasesLosingEdits(existing, [a, b, c])).toBe(0);
  });
});
