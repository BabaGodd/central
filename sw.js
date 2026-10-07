/* ============================================================
   CENTRAL CORRIDOR — SERVICE WORKER
   Network-first for app shell files. Mapbox and CDN requests are
   explicitly excluded from caching (always go to network) since
   map tiles/scripts must stay live and are already cached by
   Mapbox's own layer.
   ============================================================ */

const CACHE_NAME = 'central-corridor-v6';
const APP_SHELL = [
  './manifest.json',
  './grda-logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const EXCLUDED_HOSTS = [
  'api.mapbox.com',
  'events.mapbox.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Mapbox or CDN requests — always hit the network.
  if (EXCLUDED_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  // Always fetch navigations (including the site's root URL) and app code fresh.
  if (event.request.mode === 'navigate' || /\.(html?|js|css)$/i.test(url.pathname)) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // Network-first for static app assets.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
