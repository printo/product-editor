import { useSyncExternalStore } from 'react';

// Tailwind's `md` breakpoint is 768px; a phone layout is everything below it.
const PHONE_QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches;
}

/** True below Tailwind's `md` width. For layouts that differ in structure, not
 *  only in classes: one set of controls is rendered, never a hidden twin. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
