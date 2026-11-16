import { snapResizedRect } from '../fabric-utils';

const GRID = 10;
const rect = { left: 23, top: 47, width: 104, height: 61 }; // right 127, bottom 108

describe('snapResizedRect', () => {
  it('snaps only the edges the handle drags', () => {
    expect(snapResizedRect(rect, 'br', GRID)).toEqual({ left: 23, top: 47, width: 130 - 23, height: 110 - 47 });
    expect(snapResizedRect(rect, 'tl', GRID)).toEqual({ left: 20, top: 50, width: 127 - 20, height: 108 - 50 });
    expect(snapResizedRect(rect, 'mr', GRID)).toEqual({ left: 23, top: 47, width: 130 - 23, height: 61 });
    expect(snapResizedRect(rect, 'mt', GRID)).toEqual({ left: 23, top: 50, width: 104, height: 108 - 50 });
  });

  it('keeps the opposite edge where it is', () => {
    const out = snapResizedRect(rect, 'tl', GRID);
    expect(out.left + out.width).toBe(127);
    expect(out.top + out.height).toBe(108);
  });

  it('never lets an edge cross its opposite one: at least one cell is kept', () => {
    // Dragging the right edge back almost onto the left edge.
    const thin = { left: 20, top: 20, width: 3, height: 40 };
    expect(snapResizedRect(thin, 'mr', GRID).width).toBe(GRID);
    const flat = { left: 20, top: 20, width: 40, height: 2 };
    expect(snapResizedRect(flat, 'mb', GRID).height).toBe(GRID);
  });

  it('changes nothing without a handle or a grid', () => {
    expect(snapResizedRect(rect, undefined, GRID)).toBe(rect);
    expect(snapResizedRect(rect, 'br', 0)).toBe(rect);
  });
});
