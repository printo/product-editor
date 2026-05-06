'use client';

import { useEffect } from 'react';

/**
 * Registers `/sw.js` once per page load. No-op in dev (we don't want stale
 * cache to mask code changes during local work) and on browsers without
 * Service Worker support.
 *
 * Returns null so it can be dropped into `app/layout.tsx` like any other
 * effect-only component.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Registration failure is rare (HTTPS-only, scope errors). Log and
        // move on — the app works without the SW, just without warm cache.
        console.error('[sw] registration failed:', err);
      });
    };

    if (document.readyState === 'complete') {
      onLoad();
    } else {
      window.addEventListener('load', onLoad, { once: true });
      return () => window.removeEventListener('load', onLoad);
    }
  }, []);

  return null;
}
