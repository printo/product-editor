'use client';

import { memo, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Viewport-gated `<img>` that mounts when scrolled near the viewport and
 * — critically for 200+-card grids — UNMOUNTS again when it scrolls far
 * away, so the browser can release the decoded bitmap.
 *
 * Earlier versions only lazy-LOADED: an `<img>` mounted on first
 * scroll-in and then stayed mounted forever. On a 200-photo batch every
 * decoded thumbnail (~1–7 MB of bitmap memory each) accumulated until the
 * tab hit its memory ceiling and the renderer process was killed — the
 * "editor lags then refreshes to the home page" crash the ops team hit.
 *
 * Now a single IntersectionObserver flips `visible` BOTH ways:
 *   - within ±`rootMargin` of the viewport → `<img>` mounted
 *   - farther away                         → placeholder div, bitmap freed
 *
 * The placeholder keeps the card's box (same `className`) so scroll
 * height is stable and nothing jumps when an image mounts/unmounts.
 *
 * `rootMargin` sets the live band. 600px ≈ 1–2 card rows of pre-load
 * buffer — large enough that normal scrolling rarely shows a
 * placeholder, small enough that only a few dozen images stay decoded
 * at once regardless of total batch size.
 */
interface LazyImgProps {
  src: string;
  alt?: string;
  className?: string;
  rootMargin?: string;
  /** Background placeholder colour while unmounted. */
  placeholderClassName?: string;
}

export const LazyImg = memo(function LazyImg({
  src,
  alt = '',
  className,
  rootMargin = '600px',
  placeholderClassName = 'bg-slate-100',
}: LazyImgProps) {
  const ref = useRef<HTMLImageElement | HTMLDivElement | null>(null);
  // SSR / no-IntersectionObserver browsers: render eagerly, never unmount.
  const [visible, setVisible] = useState(() =>
    typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Mount when near the viewport, unmount when far. Unmounting
          // is the whole point — it bounds how many decoded images are
          // alive at once, so a 1000-photo grid costs the same memory
          // as a 30-photo one.
          setVisible(entry.isIntersecting);
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
    // `visible` is in deps so the observer re-attaches to whichever
    // element (the <img> or the placeholder <div>) is currently mounted.
  }, [rootMargin, visible]);

  if (visible) {
    return (
      <img
        ref={ref as RefObject<HTMLImageElement>}
        src={src}
        alt={alt}
        className={className}
      />
    );
  }
  return (
    <div
      ref={ref as RefObject<HTMLDivElement>}
      className={`${className ?? ''} ${placeholderClassName}`.trim()}
      aria-hidden
    />
  );
});
