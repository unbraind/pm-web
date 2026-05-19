// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER — pm-web PWA
// Cache versioning: auto-bust based on build timestamp
// Offline fallback page, mutation queue via IndexedDB
// ═══════════════════════════════════════════════════════════════

const BUILD_TIMESTAMP = '__BUILD_TIME__';
const CACHE_NAME = 'pm-web-' + (BUILD_TIMESTAMP !== '__BUILD_TIME__' ? BUILD_TIMESTAMP : Date.now().toString(36));
const MUTATION_DB = 'pm-web-offline';
const MUTATION_STORE = 'mutations';

const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/src/api.js',
  '/src/app.js',
  '/src/components/modals.js',
  '/src/components/toast.js',
  '/src/constants.js',
  '/src/state.js',
  '/src/types.js',
  '/src/utils.js',
  '/src/views/activity.js',
  '/src/views/admin.js',
  '/src/views/auth.js',
  '/src/views/calendar.js',
  '/src/views/comments-audit.js',
  '/src/views/config.js',
  '/src/views/context.js',
  '/src/views/create.js',
  '/src/views/dedupe.js',
  '/src/views/export.js',
  '/src/views/github.js',
  '/src/views/graph-canvas.js',
  '/src/views/graph.js',
  '/src/views/groups.js',
  '/src/views/guide.js',
  '/src/views/health.js',
  '/src/views/items.js',
  '/src/views/normalize.js',
  '/src/views/projects.js',
  '/src/views/router.js',
  '/src/views/search.js',
  '/src/views/settings.js',
  '/src/views/shared.js',
  '/src/views/sharing.js',
  '/src/views/stats.js',
  '/src/views/templates.js',
  '/src/views/validate.js',
  '/src/views/plan.js',
];

// ── Offline fallback page ──
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pm-web — Offline</title>
<style>
  body{font-family:'Inter',system-ui,sans-serif;background:#0a0f1e;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
  .offline-icon{font-size:48px;margin-bottom:20px;opacity:0.5}
  .offline-title{font-size:22px;font-weight:600;margin-bottom:8px}
  .offline-text{color:#94a3b8;max-width:400px;line-height:1.7;margin-bottom:24px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;transition:0.15s}
  .btn-primary{background:#2dd4bf;color:#0f172a}
  .btn-primary:hover{background:#34ead4}
</style>
</head>
<body>
  <div>
    <div class="offline-icon">📡</div>
    <div class="offline-title">You're offline</div>
    <div class="offline-text">pm-web needs an internet connection to load. Please check your connection and try again.</div>
    <button class="btn btn-primary" onclick="location.reload()">Try Again</button>
  </div>
</body>
</html>`;

// ── IndexedDB Mutation Queue ──
function openMutationDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MUTATION_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MUTATION_STORE)) {
        const store = db.createObjectStore(MUTATION_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueMutation(method: string, path: string, body: unknown): Promise<void> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readwrite');
    const store = tx.objectStore(MUTATION_STORE);
    store.add({
      method,
      path,
      body: body !== undefined ? JSON.stringify(body) : null,
      timestamp: Date.now(),
    });
  } catch (e) {
    // If IndexedDB fails, mutations are lost — graceful degradation
    console.warn('Failed to queue mutation for offline:', e);
  }
}

async function getQueuedMutations(): Promise<Array<{ id: number; method: string; path: string; body: string | null; timestamp: number }>> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readonly');
    const store = tx.objectStore(MUTATION_STORE);
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function clearMutation(id: number): Promise<void> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readwrite');
    tx.objectStore(MUTATION_STORE).delete(id);
  } catch { /* ignore */ }
}

async function flushMutationQueue(): Promise<void> {
  const mutations = await getQueuedMutations();
  if (mutations.length === 0) return;

  for (const mut of mutations) {
    try {
      const opts: RequestInit = {
        method: mut.method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      };
      if (mut.body !== null) opts.body = mut.body;
      const res = await fetch('/api' + mut.path, opts);
      if (res.ok) {
        await clearMutation(mut.id);
      } else {
        console.warn('Offline mutation failed:', mut.method, mut.path, res.status);
        // Stop processing on first failure — try again later
        break;
      }
    } catch {
      // Network failed again — stop processing
      break;
    }
  }

  // Notify clients about replayed mutations
  const remaining = await getQueuedMutations();
  if (remaining.length === 0 && mutations.length > 0) {
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'MUTATIONS_REPLAYED', count: mutations.length });
    });
  } else if (remaining.length > 0) {
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'MUTATIONS_PARTIAL', replayed: mutations.length - remaining.length, remaining: remaining.length });
    });
  }
}

// ── Install ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(STATIC_ASSETS.map((asset) => cache.add(asset).catch(() => null)))
    )
  );
  self.skipWaiting();
});

// ── Activate ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch strategy ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls: try network, queue mutations if offline
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/healthz')) {
    // Queue write operations (POST, PUT, PATCH, DELETE) when offline
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
      event.respondWith(
        fetch(event.request).catch(async () => {
          // Network failed — queue the mutation for later
          let body: unknown = undefined;
          try {
            body = await event.request.clone().json();
          } catch { /* no body */ }
          await queueMutation(event.request.method, url.pathname.replace('/api', ''), body);
          return new Response(JSON.stringify({ queued: true, message: 'Request queued for when you are back online' }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        })
      );
      return;
    }

    // GET/HEAD API calls: network-only, return offline JSON error
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'Offline — check your connection', queued: 0 }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }))
    );
    return;
  }

  // Navigation (SPA shell): network-first, cache fallback, offline page fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('/', clone));
          }
          return res;
        })
        .catch(async () => {
          // Try cached shell first
          const cached = await caches.match('/');
          if (cached) return cached;
          // Return offline fallback page
          return new Response(OFFLINE_HTML, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        })
    );
    return;
  }

  // Static assets: stale-while-revalidate
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

// ── Messages ──
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urls).catch(() => {}));
  }
  if (event.data && event.data.type === 'FLUSH_QUEUE') {
    flushMutationQueue();
  }
});

// ── Background sync ──
self.addEventListener('sync', (event) => {
  if (event.tag === 'pm-sync') {
    event.waitUntil(flushMutationQueue());
  }
});

// ── Online event: flush queue when connectivity returns ──
self.addEventListener('online', () => {
  flushMutationQueue();
});
