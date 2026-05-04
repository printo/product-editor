'use client';

import { memo, useEffect, useRef, useState } from 'react';

/**
 * Defers `<img>` mounting until the wrapper enters the viewport (IntersectionObserver).
 *
 * Use case: large canvas grids (200+ items) where every card holds a base-64
 * dataUrl preview. Mounting all `<img>` tags eagerly blocks initial paint and
 * inflates JS heap. With this wrapper, off-screen cards render a cheap
 * placeholder div until they scroll near the viewport, then the real `<img>`
 * mounts.
 *
 * `rootMargin` defaults to "300px" so cards just below the fold render before
 * the user scrolls to them — no flash of empty placeholder during fast scroll.
 *
 * Once visible the component stays mounted (no re-unmount on scroll-out) so we
 * don't churn decoded image data — the goal is faster *first* paint, not
 * peak-memory reduction. (Memory reduction would require lazy dataUrl
 * generation, a separate B-series item.)
 */
interface LazyImgProps {
  src: string;
  alt?: string;
  className?: string;
  rootMargin?: string;
  /** Background placeholder colour while waiting to mount. */
  placeholderClassName?: string;
}

export const LazyImg = memo(function LazyImg({
  src,
  alt = '',
  className,
  rootMargin = '300px',
  placeholderClassName = 'bg-slate-100',
}: LazyImgProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Eager render in SSR / older browsers. Lazy init avoids a setState-in-effect
  // ESLint warning and saves an extra render on the fallback path.
  const [visible, setVisible] = useState(() =>
    typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin, visible]);

  if (visible) {
    return <img src={src} alt={alt} className={className} />;
  }
  return <div ref={ref} className={`${className ?? ''} ${placeholderClassName}`.trim()} aria-hidden />;
});
