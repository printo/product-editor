import { act, renderHook } from '@testing-library/react';
import { useStickyToolbar } from '../useStickyToolbar';

type Watcher = { cb: IntersectionObserverCallback; options?: IntersectionObserverInit; targets: Element[]; disconnected: boolean };
let watchers: Watcher[] = [];
const RealIO = window.IntersectionObserver;
const RealRO = window.ResizeObserver;
let resize: (() => void) | null = null;

beforeEach(() => {
  watchers = [];
  window.IntersectionObserver = class {
    targets: Element[] = [];
    disconnected = false;
    constructor(public cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) { watchers.push(this); }
    observe(el: Element) { this.targets.push(el); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  window.ResizeObserver = class {
    constructor(cb: () => void) { resize = cb; }
    observe() {}
    unobserve() {}
    disconnect() { resize = null; }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  window.IntersectionObserver = RealIO;
  window.ResizeObserver = RealRO;
});

const report = (w: Watcher, isIntersecting: boolean) =>
  act(() => w.cb([{ isIntersecting } as IntersectionObserverEntry], w as unknown as IntersectionObserver));

describe('useStickyToolbar', () => {
  it('watches nothing until the sentinel mounts, then pins while it is out of view', () => {
    const { result } = renderHook(() => useStickyToolbar(80));
    expect(watchers).toHaveLength(0);
    const sentinel = document.createElement('div');
    act(() => result.current.setToolbarSentinel(sentinel));
    expect(watchers).toHaveLength(1);
    expect(watchers[0].targets).toEqual([sentinel]);
    // Out of view means scrolled past the bottom edge of the top bar.
    expect(watchers[0].options?.rootMargin).toBe('-81px 0px 0px 0px');
    report(watchers[0], false);
    expect(result.current.isToolbarStuck).toBe(true);
    report(watchers[0], true);
    expect(result.current.isToolbarStuck).toBe(false);
  });

  it('starts a new observer when the top bar height changes', () => {
    const { result, rerender } = renderHook(({ h }) => useStickyToolbar(h), { initialProps: { h: 0 } });
    act(() => result.current.setToolbarSentinel(document.createElement('div')));
    expect(watchers[0].options?.rootMargin).toBe('-1px 0px 0px 0px');
    rerender({ h: 72 });
    expect(watchers[0].disconnected).toBe(true);
    expect(watchers[1].options?.rootMargin).toBe('-73px 0px 0px 0px');
  });

  it('measures the toolbar when it mounts and whenever it resizes', () => {
    const { result } = renderHook(() => useStickyToolbar(0));
    expect(result.current.toolbarHeight).toBe(0);
    const toolbar = document.createElement('div');
    let height = 64.4;
    toolbar.getBoundingClientRect = () => ({ height } as DOMRect);
    act(() => result.current.setToolbarEl(toolbar));
    expect(result.current.toolbarHeight).toBe(64);
    height = 120.6;
    act(() => resize!());
    expect(result.current.toolbarHeight).toBe(121);
  });
});
