/**
 * Where a card's quick-action rail goes: down the picture's side, or in a row
 * under it when the picture is too short to hold it. On a phone a mug card is
 * about 150px tall; the rail was clipped there and Swap and Remove could not
 * be reached (seen on an iPhone inside printo.in, 2026-11-22).
 */
import { act, render, screen } from '@testing-library/react';
import { RAIL_MIN_PREVIEW_HEIGHT, railGoesBelow, useQuickRailBelow } from '../useQuickRailBelow';

describe('railGoesBelow', () => {
  it('keeps the rail on the picture when the picture can hold it', () => {
    expect(railGoesBelow(RAIL_MIN_PREVIEW_HEIGHT)).toBe(false);
    expect(railGoesBelow(478)).toBe(false);
  });

  it('moves it under a picture that is too short', () => {
    expect(railGoesBelow(RAIL_MIN_PREVIEW_HEIGHT - 1)).toBe(true);
    expect(railGoesBelow(145)).toBe(true);
  });

  it('leaves it alone before the picture has been measured', () => {
    expect(railGoesBelow(0)).toBe(false);
  });
});

describe('useQuickRailBelow', () => {
  let report: (height: number) => void = () => {};
  const disconnect = jest.fn();
  const realObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    disconnect.mockClear();
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        report = height => callback(
          [{ contentRect: { height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { globalThis.ResizeObserver = realObserver; });

  function Card() {
    const [ref, below] = useQuickRailBelow();
    return <div ref={ref}>{below ? 'row under the picture' : 'column on the picture'}</div>;
  }

  it('follows the picture as it is resized, and stops watching on unmount', () => {
    const { unmount } = render(<Card />);
    expect(screen.getByText('column on the picture')).toBeInTheDocument();

    act(() => report(145));
    expect(screen.getByText('row under the picture')).toBeInTheDocument();

    act(() => report(478));
    expect(screen.getByText('column on the picture')).toBeInTheDocument();

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
