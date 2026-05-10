const CACHE_NAME = 'pm-web-v3';
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/manifest.json',
];

// Install: cache shell assets and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or auth — always network-first
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/healthz')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'Offline — check your connection' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }))
    );
    return;
  }

  // For navigation (SPA shell): network-first, cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Cache a copy of the shell for offline
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('/', clone));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets (CSS, JS, images, manifest): stale-while-revalidate
  if (
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.woff2') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetched = fetch(event.request).then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // Default: network, fallback to cache
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

// Handle messages from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urls).catch(() => {}));
  }
});

// Background sync for queued API calls (when back online)
self.addEventListener('sync', (event) => {
  if (event.tag === 'pm-sync') {
    // Future: replay queued mutations
  }
});
