import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CalendarCoversPanel,
  defaultCover,
  moveWindow,
  resizeWindow,
  type CoverDraft,
  type CoverKey,
} from '@/components/CalendarCoversPanel';

const BASE = { canvasWidthMm: 200, canvasHeightMm: 300, dpi: 300 };

describe('moveWindow / resizeWindow', () => {
  const r = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 };

  it('moves by the drag and keeps the window on the page', () => {
    expect(moveWindow(r, 0.1, -0.05)).toEqual({ x: 0.2, y: 0.15000000000000002, width: 0.4, height: 0.3 });
    expect(moveWindow(r, 5, 5)).toMatchObject({ x: 0.6, y: 0.7 });
    expect(moveWindow(r, -5, -5)).toMatchObject({ x: 0, y: 0 });
  });

  it('resizes from the corner, never below the minimum or past the edge', () => {
    expect(resizeWindow(r, 0.1, 0.1)).toMatchObject({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
    expect(resizeWindow(r, -5, -5)).toMatchObject({ width: 0.02, height: 0.02 });
    expect(resizeWindow(r, 5, 5)).toMatchObject({ width: 0.9, height: 0.8 });
  });
});

function Harness({ onCover }: { onCover: (c: CoverDraft | null) => void }) {
  const [covers, setCovers] = useState<Partial<Record<CoverKey, CoverDraft | null>>>({
    frontCover: { ...defaultCover(BASE), frames: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.3 }] },
  });
  return (
    <CalendarCoversPanel
      covers={covers}
      maskFiles={{}}
      onMaskFile={() => {}}
      base={BASE}
      onChange={(key, next) => {
        setCovers((c) => ({ ...c, [key]: next }));
        onCover(next);
      }}
    />
  );
}

function mockPage(el: HTMLElement, w = 200, h = 300) {
  el.getBoundingClientRect = () =>
    ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function drag(target: HTMLElement, from: [number, number], to: [number, number]) {
  target.setPointerCapture = jest.fn();
  target.hasPointerCapture = () => true;
  target.releasePointerCapture = jest.fn();
  fireEvent.pointerDown(target, { pointerId: 1, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to[0], clientY: to[1] });
}

describe('CalendarCoversPanel sketch', () => {
  it('dragging a photo window moves it and the millimetre fields follow', () => {
    const seen: (CoverDraft | null)[] = [];
    render(<Harness onCover={(c) => seen.push(c)} />);
    mockPage(screen.getByTestId('cover-sketch'));

    // 20 px right and 30 px down on a 200 x 300 px page = 0.1 and 0.1 of it.
    drag(screen.getByTestId('cover-window-0'), [50, 50], [70, 80]);

    const last = seen[seen.length - 1]!;
    expect(last.frames[0].x).toBeCloseTo(0.2, 5);
    expect(last.frames[0].y).toBeCloseTo(0.2, 5);
    expect(last.frames[0].width).toBeCloseTo(0.4, 5);
    // X is shown in mm: 0.2 of a 200 mm page.
    const xField = screen.getAllByRole('spinbutton').find((i) => (i as HTMLInputElement).value === '40');
    expect(xField).toBeTruthy();
  });

  it('dragging the corner resizes without moving the window', () => {
    const seen: (CoverDraft | null)[] = [];
    render(<Harness onCover={(c) => seen.push(c)} />);
    mockPage(screen.getByTestId('cover-sketch'));

    drag(screen.getByTestId('cover-window-0-resize'), [100, 100], [120, 130]);

    const f = seen[seen.length - 1]!.frames[0];
    expect(f.x).toBeCloseTo(0.1, 5);
    expect(f.y).toBeCloseTo(0.1, 5);
    expect(f.width).toBeCloseTo(0.5, 5);
    expect(f.height).toBeCloseTo(0.4, 5);
  });

  it('arrow keys move the focused window 1 mm, Shift 10 mm', () => {
    const seen: (CoverDraft | null)[] = [];
    render(<Harness onCover={(c) => seen.push(c)} />);
    const win = screen.getByTestId('cover-window-0');

    fireEvent.keyDown(win, { key: 'ArrowRight' });
    expect(seen[seen.length - 1]!.frames[0].x).toBeCloseTo(0.1 + 1 / 200, 6);
    fireEvent.keyDown(win, { key: 'ArrowDown', shiftKey: true });
    expect(seen[seen.length - 1]!.frames[0].y).toBeCloseTo(0.1 + 10 / 300, 6);
  });
});
