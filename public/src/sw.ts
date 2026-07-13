// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER — pm-web PWA
// Cache versioning: auto-bust based on build timestamp
// Offline fallback page, mutation queue via IndexedDB
//
// This is the TypeScript source for /sw.js. It is compiled with the
// `WebWorker` lib (see public/tsconfig.sw.json) so the ServiceWorker
// global scope (`ServiceWorkerGlobalScope`, `caches`, `clients`,
// `skipWaiting`, IndexedDB, fetch) is fully typed. The emitted
// `public/sw.js` is plain JavaScript served at the same URL.
// ═══════════════════════════════════════════════════════════════

// `self` is the ServiceWorkerGlobalScope inside a service worker. The
// `WebWorker` lib types the ambient `self` as the generic WorkerGlobalScope,
// so narrow it once at the top via a `unknown` cast (no `any`).
const sw = self as unknown as ServiceWorkerGlobalScope;

// `__BUILD_TIME__` is an optional build-time substitution placeholder.
// No substitution is performed by the default build, so the literal is
// retained verbatim and the cache name falls back to a runtime stamp.
// Kept as a widened `string` so the placeholder comparison stays a
// runtime check and the emitted output is deterministic.
const BUILD_TIMESTAMP: string = '__BUILD_TIME__';
const CACHE_NAME = 'pm-web-' + (BUILD_TIMESTAMP !== '__BUILD_TIME__' ? BUILD_TIMESTAMP : Date.now().toString(36));
const MUTATION_DB = 'pm-web-offline';
const MUTATION_STORE = 'mutations';

const STATIC_ASSETS: readonly string[] = [
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
  '/src/filters.js',
  '/src/state.js',
  '/src/theme.js',
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
  '/src/views/plan.js',
  '/src/views/plan-execution.js',
  '/src/views/projects.js',
  '/src/views/router.js',
  '/src/views/search.js',
  '/src/views/settings.js',
  '/src/views/shared.js',
  '/src/views/sharing.js',
  '/src/views/stats.js',
  '/src/views/templates.js',
  '/src/views/validate.js',
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

interface QueuedMutation {
  id: number;
  method: string;
  path: string;
  body: string | null;
  timestamp: number;
}

interface StoredMutation {
  method: string;
  path: string;
  body: string | null;
  timestamp: number;
}

// Minimal Background Sync event typing. The `WebWorker` lib does not ship
// `SyncEvent`, so declare the surface we use (it extends ExtendableEvent).
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

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

/**
 * Resolve when an IDB transaction has durably committed; reject on abort or
 * error so callers can never mistake a half-applied (or never-applied) write
 * for a persisted mutation. The transaction auto-commits once all queued
 * requests settle, so awaiting this is sufficient to know the write is durable.
 */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction error'));
  });
}

/**
 * Queue a mutation for later replay. Returns `true` only when the mutation has
 * been durably persisted to IndexedDB; `false` when persistence failed so the
 * caller can respond with an explicit error instead of claiming it was queued.
 */
async function queueMutation(method: string, path: string, body: unknown): Promise<boolean> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readwrite');
    const store = tx.objectStore(MUTATION_STORE);
    const record: StoredMutation = {
      method,
      path,
      body: body !== undefined ? JSON.stringify(body) : null,
      timestamp: Date.now(),
    };
    store.add(record);
    // Await the transaction commit (not just the request dispatch) so the
    // promise only resolves after the mutation is durably persisted. A request
    // error triggers a transaction abort, surfaced via `transactionDone`.
    await transactionDone(tx);
    return true;
  } catch (e) {
    // Persistence failed — do NOT claim the mutation was queued.
    console.warn('Failed to queue mutation for offline:', e);
    return false;
  }
}

async function getQueuedMutations(): Promise<QueuedMutation[]> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readonly');
    const store = tx.objectStore(MUTATION_STORE);
    return await new Promise<QueuedMutation[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as QueuedMutation[]);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

/**
 * Remove a replayed mutation from the queue. Returns `true` only when the
 * deletion has committed, so the caller can stop replay on a persistence
 * failure instead of silently leaving duplicate entries to be retried.
 */
async function clearMutation(id: number): Promise<boolean> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readwrite');
    tx.objectStore(MUTATION_STORE).delete(id);
    await transactionDone(tx);
    return true;
  } catch (e) {
    console.warn('Failed to clear queued mutation:', e);
    return false;
  }
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
        const cleared = await clearMutation(mut.id);
        if (!cleared) {
          // Could not remove the replayed mutation from the queue — stop to
          // avoid duplicate replays on the next flush; it will retry later.
          break;
        }
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
  const clients = await sw.clients.matchAll();
  if (remaining.length === 0 && mutations.length > 0) {
    clients.forEach((client) => {
      client.postMessage({ type: 'MUTATIONS_REPLAYED', count: mutations.length });
    });
  } else if (remaining.length > 0) {
    clients.forEach((client) => {
      client.postMessage({
        type: 'MUTATIONS_PARTIAL',
        replayed: mutations.length - remaining.length,
        remaining: remaining.length,
      });
    });
  }
}

// ── Install ──
sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(STATIC_ASSETS.map((asset) => cache.add(asset).catch(() => null)))
    )
  );
  sw.skipWaiting();
});

// ── Activate ──
sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  sw.clients.claim();
});

// ── Fetch strategy ──
sw.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // API calls: try network, queue mutations if offline
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/healthz')) {
    // Queue write operations (POST, PUT, PATCH, DELETE) when offline
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
      event.respondWith(
        fetch(event.request).catch(async () => {
          // Network failed — queue the mutation for later.
          let body: unknown = undefined;
          try {
            body = await event.request.clone().json();
          } catch { /* no body */ }
          const queued = await queueMutation(
            event.request.method,
            url.pathname.replace('/api', ''),
            body,
          );
          if (queued) {
            return new Response(
              JSON.stringify({ queued: true, message: 'Request queued for when you are back online' }),
              { status: 202, headers: { 'Content-Type': 'application/json' } },
            );
          }
          // Persistence failed — do not claim the mutation was queued.
          return new Response(
            JSON.stringify({ error: 'Offline and unable to queue mutation', queued: false }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }),
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
      (async (): Promise<Response> => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        // Kick off revalidation in the background. The network promise resolves
        // to `undefined` on failure (no unsafe cast — the type is explicit).
        const network = fetch(event.request)
          .then((res): Response => {
            if (res.ok) void cache.put(event.request, res.clone());
            return res;
          })
          .catch((): Response | undefined => undefined);
        // Stale-while-revalidate: serve cached immediately when present.
        if (cached) {
          void network;
          return cached;
        }
        // No cached entry — must wait for the network.
        const res = await network;
        if (res) return res;
        return new Response('Unavailable offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })(),
    );
    return;
  }

  // Default: network, fallback to cache, then explicit 503.
  event.respondWith(
    (async (): Promise<Response> => {
      try {
        return await fetch(event.request);
      } catch {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return new Response('Unavailable offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});

// ── Messages ──
sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; urls?: string[] } | null;
  if (data && data.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
  if (data && data.type === 'CACHE_URLS') {
    const urls = data.urls ?? [];
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urls).catch(() => {}));
  }
  if (data && data.type === 'FLUSH_QUEUE') {
    void flushMutationQueue();
  }
});

// ── Background sync ──
// The `WebWorker` lib has no `SyncEvent`, so receive the generic Event and
// narrow to our minimal SyncEvent interface (no `any`).
sw.addEventListener('sync', (event: Event) => {
  const syncEvent = event as unknown as SyncEvent;
  if (syncEvent.tag === 'pm-sync') {
    syncEvent.waitUntil(flushMutationQueue());
  }
});

// ── Online event: flush queue when connectivity returns ──
sw.addEventListener('online', () => {
  void flushMutationQueue();
});