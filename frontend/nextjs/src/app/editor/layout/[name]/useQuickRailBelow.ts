import { useEffect, useRef, useState, type RefObject } from 'react';

/** The tallest quick-action rail (six buttons of 30px, five 6px gaps, its own
 *  padding and border) plus the 8px it stands off the card's top and bottom.
 *  A card's picture shorter than this cannot hold the rail down its side. */
export const RAIL_MIN_PREVIEW_HEIGHT = 240;

/** Whether the rail leaves the picture and becomes a row under it. An
 *  unmeasured picture (height 0: before layout, or under a test DOM) keeps
 *  the rail where it always was. */
export function railGoesBelow(previewHeight: number): boolean {
  return previewHeight > 0 && previewHeight < RAIL_MIN_PREVIEW_HEIGHT;
}

/** Watches a card's picture and says where its quick-action rail belongs: down
 *  the picture's right edge, or, when the picture is too short to hold it (a
 *  mug on a phone is about 150px tall), in a row under the picture, where it
 *  covers nothing. The picture's height comes from its width and the layout's
 *  shape, never from the rail, so moving the rail cannot change the answer. */
export function useQuickRailBelow(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // The observer reports once as soon as it starts, before the first paint.
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height ?? 0;
      setBelow(railGoesBelow(height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, below];
}
