'use client';

import { memo, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

/**
 * Viewport-gated `<img>` that loads when scrolled near the viewport and
 * — critically for 200+-card grids — DROPS its `src` again when it scrolls
 * far away, so the browser can release the decoded bitmap.
 *
 * Earlier versions only lazy-LOADED: an `<img>` mounted on first scroll-in
 * and then stayed loaded forever. On a 200-photo batch every decoded
 * thumbnail (~1–7 MB of bitmap memory each) accumulated until the tab hit
 * its memory ceiling and the renderer process was killed — the "editor lags
 * then refreshes to the home page" crash the ops team hit.
 *
 * Releasing memory is still the point. But the version that did it by
 * swapping the `<img>` for a placeholder `<div>` made the editor grid blink
 * an image at a time (customer report, embed flow, Sep 2026), for three
 * reasons, all fixed here:
 *
 *   1. The observed element was the one being swapped. Each flip tore the
 *      observer down and re-attached it to whichever node had just replaced
 *      the other, and a fresh observer always re-delivers an initial
 *      callback — so what was measured changed as a *result* of measuring
 *      it. Now a single `<img>` is mounted for the life of the component and
 *      only its `src` changes, so the observers are built once and always
 *      measure the same box.
 *   2. One band did both jobs, so crossing it by a pixel unloaded a card
 *      that the next frame loaded again. Now loading and unloading use
 *      different bands, and the gap between them is dead zone.
 *   3. Destroying the element threw away the decoded bitmap *and* the node,
 *      so coming back re-decoded the whole data URL from scratch — with
 *      production thumbnails at ~350 kB of base64 each, long enough to see
 *      as a blank card. Keeping the node means the browser re-decodes at
 *      most the image, and never re-creates layout.
 *
 * `rootMargin` sets the load band. 600px ≈ 1–2 card rows of pre-load
 * buffer. The unload band is 4× that, so only a few dozen images stay
 * decoded at once regardless of total batch size — the same memory ceiling
 * as before.
 */

/** Fallback load band when `rootMargin` is unparseable. */
const DEFAULT_LOAD_PX = 600;
/** Floor for the unload band, so a small `rootMargin` still gets real hysteresis. */
const MIN_KEEP_PX = 2400;

function parsePx(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

interface LazyImgProps {
  src: string;
  alt?: string;
  className?: string;
  rootMargin?: string;
  /** Background placeholder colour while the image is unloaded. */
  placeholderClassName?: string;
}

export const LazyImg = memo(function LazyImg({
  src,
  alt = '',
  className,
  rootMargin = '600px',
  placeholderClassName = 'bg-slate-100',
}: LazyImgProps) {
  const ref = useRef<HTMLImageElement | null>(null);
  const loadPx = parsePx(rootMargin, DEFAULT_LOAD_PX);
  const keepPx = Math.max(loadPx * 4, MIN_KEEP_PX);

  // Fail OPEN. A page that receives no callbacks at all — a background tab,
  // or the offscreen cross-origin iframe the embed editor opens inside on
  // printo.in — must still show its photos, so the image starts loaded and
  // the wide band below unloads whatever turns out to be far away. Starting
  // `false` instead left every card a grey box until a callback arrived,
  // which in those states never happens.
  const [loaded, setLoaded] = useState(true);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;

    const loadIo = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLoaded(true);
      },
      { rootMargin: `${loadPx}px` },
    );
    // Only the wider band may unload, and its first delivery is what prunes
    // the far-away cards that started loaded. Between the two bands the
    // current state is left alone — that gap is the hysteresis.
    const keepIo = new IntersectionObserver(
      (entries) => {
        if (entries.length && entries.every((e) => !e.isIntersecting)) setLoaded(false);
      },
      { rootMargin: `${keepPx}px` },
    );
    loadIo.observe(el);
    keepIo.observe(el);
    return () => {
      loadIo.disconnect();
      keepIo.disconnect();
    };
  }, [loadPx, keepPx]);

  return (
    // One element, for the life of the component. Dropping `src` releases the
    // decoded image; the node, its box and its observers all stay put, so
    // nothing reflows and there is no add/remove churn to see.
    <img
      ref={ref}
      src={loaded ? src : undefined}
      alt={loaded ? alt : ''}
      className={clsx(className, !loaded && placeholderClassName)}
      aria-hidden={loaded ? undefined : true}
    />
  );
});
