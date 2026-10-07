'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

/** Pins the editor toolbar under the top bar once scrolled past, and measures
 *  its height for what has to clear it. EditorToolbar renders the sentinel and
 *  the toolbar through the two callback refs returned here. */
export function useStickyToolbar(headerHeight: number) {
  // The toolbar switches to `position: fixed` once scrolled up to where it
  // would go under the fixed dashboard header — driven by this boolean, not
  // CSS `position: sticky`. Sticky's containing block is the toolbar's own
  // direct parent (the `.relative` wrapper in EditorToolbar), and that parent is sized
  // to exactly the toolbar's own height — its only other child is a 1px
  // `absolute` sentinel, contributing none — so a sticky toolbar there can
  // only stay stuck for about one toolbar-height of scroll before its own
  // undersized container scrolls out from under it and drags the toolbar
  // away too, right off-screen under the header instead of stopping below
  // it. Confirmed by forcing that wrapper tall at runtime: sticky then held
  // correctly at any scroll depth. `fixed` has no containing-block-height
  // requirement, so it doesn't hit that trap.
  // The sentinel is held in state through a callback ref, like the toolbar
  // below: the toolbar renders only once the layout has loaded, after this
  // effect's first run, and with a plain ref nothing re-ran it once the
  // sentinel existed — so the toolbar never pinned (until 2026-10-07).
  const [toolbarSentinel, setToolbarSentinel] = useState<HTMLDivElement | null>(null);
  const [isToolbarStuck, setIsToolbarStuck] = useState(false);

  useEffect(() => {
    if (!toolbarSentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsToolbarStuck(!entry.isIntersecting),
      { rootMargin: `-${headerHeight + 1}px 0px 0px 0px`, threshold: 0 }
    );
    observer.observe(toolbarSentinel);
    return () => observer.disconnect();
  }, [headerHeight, toolbarSentinel]);

  // The floating qty banner has to clear BOTH bars above it. In the embed
  // iframe no app <header> is mounted at all (headerHeight is 0) and this
  // sticky toolbar is the only thing at the top of the viewport, so a
  // header-only offset would drop the banner straight on top of it. Measured
  // rather than hardcoded — the toolbar is one row on desktop and two on a
  // phone, and it re-flows as the window resizes. A callback ref so the
  // measurement starts the moment the toolbar mounts (it renders only after
  // the layout loads).
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  useLayoutEffect(() => {
    if (!toolbarEl) return;
    const measure = () => setToolbarHeight(Math.round(toolbarEl.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbarEl);
    return () => observer.disconnect();
  }, [toolbarEl]);

  return { setToolbarSentinel, isToolbarStuck, setToolbarEl, toolbarHeight };
}
