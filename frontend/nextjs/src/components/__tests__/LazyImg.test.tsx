import { render, act } from '@testing-library/react';
import { LazyImg } from '../LazyImg';

/**
 * These pin the three properties whose absence made the editor grid blink an
 * image at a time (customer report, embed flow, Sep 2026):
 *   - the observed element must never be the thing that loading replaces
 *   - loading and unloading must use different bands (hysteresis)
 *   - a page that gets no callbacks must still show its photos
 */

type Cb = (entries: IntersectionObserverEntry[]) => void;
interface FakeIO { cb: Cb; rootMargin: string; targets: Element[]; disconnected: boolean }

let observers: FakeIO[] = [];

function installFakeIO() {
  observers = [];
  class IO {
    cb: Cb;
    rootMargin: string;
    targets: Element[] = [];
    disconnected = false;
    constructor(cb: Cb, opts?: IntersectionObserverInit) {
      this.cb = cb;
      this.rootMargin = String(opts?.rootMargin ?? '');
      observers.push(this as unknown as FakeIO);
    }
    observe(el: Element) { this.targets.push(el); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    takeRecords() { return []; }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
}

/** Bands are ordered by construction: load observer first, keep observer second. */
const live = () => observers.filter(o => !o.disconnected);
const loadObs = () => live()[0];
const keepObs = () => live()[1];

function fire(o: FakeIO, isIntersecting: boolean) {
  act(() => {
    o.cb(o.targets.map(t => ({ target: t, isIntersecting }) as unknown as IntersectionObserverEntry));
  });
}

beforeEach(installFakeIO);

const SRC = 'data:image/png;base64,AAAA';
const img = (c: HTMLElement) => c.querySelector('img')!;

describe('LazyImg', () => {
  it('shows the photo on the first frame, before any callback arrives', () => {
    // The embed editor opens inside an offscreen cross-origin iframe, which
    // gets no callbacks until the storefront scrolls it in. Waiting for one
    // left every card a grey box.
    const { container } = render(<LazyImg src={SRC} className="absolute inset-0 object-fill" />);
    expect(img(container).getAttribute('src')).toBe(SRC);
  });

  it('keeps one element, and observes it, across every load/unload flip', () => {
    const { container } = render(<LazyImg src={SRC} />);
    const el = img(container);
    expect(loadObs().targets[0]).toBe(el);
    expect(keepObs().targets[0]).toBe(el);

    fire(keepObs(), false);                       // far away -> unload
    expect(img(container).getAttribute('src')).toBeNull();
    fire(loadObs(), true);                        // back -> load
    expect(img(container).getAttribute('src')).toBe(SRC);

    // Same node throughout, and neither observer was rebuilt. The old version
    // destroyed the node and re-pointed a new observer at its replacement,
    // which is what let a card at the band edge flip indefinitely.
    expect(img(container)).toBe(el);
    expect(live()).toHaveLength(2);
  });

  it('uses a wider band to unload than to load', () => {
    render(<LazyImg src={SRC} rootMargin="600px" />);
    expect(loadObs().rootMargin).toBe('600px');
    expect(parseFloat(keepObs().rootMargin)).toBeGreaterThan(600);
  });

  it('holds state in the gap between the two bands', () => {
    // A card parked at the load-band edge: outside the load band, still inside
    // the keep band. This is the exact input that used to flip-flop.
    const { container } = render(<LazyImg src={SRC} />);
    for (let i = 0; i < 5; i++) {
      fire(loadObs(), false);
      fire(keepObs(), true);
    }
    expect(img(container).getAttribute('src')).toBe(SRC);
  });

  it('releases the decoded image past the keep band, keeping the box', () => {
    const { container } = render(<LazyImg src={SRC} placeholderClassName="bg-slate-100" className="w-full h-full" />);
    fire(keepObs(), false);
    const el = img(container);
    expect(el.getAttribute('src')).toBeNull();
    expect(el.className).toContain('bg-slate-100');
    // The sizing classes stay, so the card cannot reflow while unloaded.
    expect(el.className).toContain('w-full');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('reloads a card that returns to the load band', () => {
    const { container } = render(<LazyImg src={SRC} alt="Canvas 1" />);
    fire(keepObs(), false);
    fire(loadObs(), true);
    expect(img(container).getAttribute('src')).toBe(SRC);
    expect(img(container).getAttribute('alt')).toBe('Canvas 1');
    expect(img(container).getAttribute('aria-hidden')).toBeNull();
  });

  it('shows the photo when the browser has no IntersectionObserver', () => {
    const saved = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      const { container } = render(<LazyImg src={SRC} />);
      // Nothing could ever switch it on later, so it must start on.
      expect(img(container).getAttribute('src')).toBe(SRC);
    } finally {
      (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = saved;
    }
  });

  it('disconnects both observers on unmount', () => {
    const { unmount } = render(<LazyImg src={SRC} />);
    const both = [...observers];
    unmount();
    expect(both.every(o => o.disconnected)).toBe(true);
  });
});
