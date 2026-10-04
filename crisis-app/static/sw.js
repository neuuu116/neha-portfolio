/* Minimal service worker: cache the app shell and the seed data so the
 * demo genuinely works with the network switched off. */
const CACHE = 'csh-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'];
const DATA_PATHS = ['/api/bootstrap', '/api/strategies', '/api/resources'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes fail fast and get queued client-side

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (DATA_PATHS.some((p) => url.pathname === p)) {
    event.respondWith(networkFirst(request, url.pathname));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(cacheFirst(request, '/index.html'));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(cacheKey, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    return new Response(JSON.stringify({ strategies: [], resources: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirst(request, fallback) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const fb = fallback ? await cache.match(fallback) : null;
    return fb || Response.error();
  }
}
