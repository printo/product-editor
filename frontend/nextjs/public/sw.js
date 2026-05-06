// Minimal Service Worker for Product Editor.
//
// Scope: caches GET requests for `/_next/static/*` and `/static/*` with a
// cache-first strategy. Both classes of asset are content-hashed (Next.js
// chunk filenames + WhiteNoise's manifest storage), so cached entries are
// safe to keep forever — when the build changes, the URL changes, and we
// just store a new entry alongside.
//
// What this gets you over the existing CDN + browser cache:
//   - Durability. Browser HTTP cache can be evicted under quota pressure or
//     on browser data clears; the SW cache is far stickier (separate quota).
//     For users who hit the editor daily, that means warm cold-loads instead
//     of round-tripping the CDN every Monday.
//   - Predictability. The SW guarantees the asset is local; no 304 conditional
//     request, no DNS lookup if the underlying network is flaky.
//
// What it deliberately does NOT do:
//   - Cache API responses, HTML, or anything auth-gated.
//   - Pre-cache on install (avoid bloating first-load with kilobytes the user
//     may not need; we just lazy-cache as routes are visited).
//   - Background sync, push, offline routing.

const CACHE_VERSION = 'pe-static-v1';

self.addEventListener('install', (event) => {
  // Take over immediately so users on the page when SW updates get the new
  // worker without a hard refresh.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Sweep any cache entries from prior versions of this SW.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('pe-static-') && k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isStaticAsset =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/static/');
  if (!isStaticAsset) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Only cache successful, basic (same-origin) responses. Opaque or
        // partial responses (206) would corrupt range requests later.
        if (response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Network failure on an asset we never cached — let the browser
        // surface the error, same as it would without the SW.
        throw err;
      }
    })()
  );
});
