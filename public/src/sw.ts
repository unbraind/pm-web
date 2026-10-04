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
// The signed-in account the page broadcasts lives in its own store so the
// mutation records and the session can be written and read independently,
// exactly like a real browser would keep them.
const SESSION_STORE = 'session';
const SESSION_KEY = 'current';

const STATIC_ASSETS: readonly string[] = [
  '/',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/src/api.js',
  '/src/api-types.js',
  '/src/app.js',
  '/src/browser-window.js',
  '/src/components/modals.js',
  '/src/components/toast.js',
  '/src/constants.js',
  '/src/filters.js',
  '/src/i18n.js',
  '/src/i18n/de.json',
  '/src/i18n/en.json',
  '/src/offline-recovery.js',
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
  '/src/views/packages.js',
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
  /** Account that queued the mutation. Absent on legacy records. */
  ownerId?: string | null;
  /** Workspace (project id) the queued path targets. Absent on legacy records. */
  workspace?: string | null;
  /** Server-enforced exactly-once identity for the replay. */
  idempotencyKey?: string;
  /** Durable recovery state; absence on legacy records means queued. */
  state?: 'queued' | 'needs-attention';
  /** Terminal replay problem requiring owner action. */
  attentionReason?: 'outcome-unknown' | 'repeated-5xx';
  /** Consecutive server failures survive worker restarts. */
  serverFailures?: number;
}

interface StoredMutation {
  method: string;
  path: string;
  body: string | null;
  timestamp: number;
  /** Account that queued the mutation; `null` when no session was known. */
  ownerId: string | null;
  /** Workspace (project id) the queued path targets; `null` when account-level. */
  workspace: string | null;
  /** Server-enforced exactly-once identity for the replay. */
  idempotencyKey: string;
}

/** The signed-in account as persisted in the `session` store. */
interface StoredSession {
  key: string;
  userId: string | null;
}

/** Shape of the `/api/auth/me` response body the flush bootstrap reads. */
interface MeBody {
  user?: { id?: string };
}

/** Why one queued mutation was refused during a flush. */
type ReplayBlockReason = 'no-session' | 'unknown-owner' | 'owner-mismatch' | 'auth-route'
  | 'outcome-unknown' | 'repeated-5xx' | 'workspace-order';

/** A queued mutation a flush refused, surfaced to the page for explicit recovery. */
interface BlockedMutation {
  id: number;
  method: string;
  path: string;
  ownerId: string | null;
  workspace: string | null;
  reason: ReplayBlockReason;
}

/**
 * Extract the workspace (project id) a queued API path targets, or `null` for
 * account-level mutations.
 *
 * Every project-scoped mutation the SPA issues lives under
 * `/projects/<projectId>/…`, so the first path segment after `/projects/` is
 * the workspace the record is bound to. The value is stamped at queue time
 * and replayed verbatim in MUTATIONS_BLOCKED reports, so an operator can see
 * which workspace a stranded record belongs to without re-deriving it.
 *
 * @param path - The queued API path (relative to `/api`).
 * @returns The project id the path targets, or `null` when the path is account-level.
 */
function workspaceFromPath(path: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(path);
  return match ? match[1] : null;
}

/**
 * Generate a fresh idempotency key for one queued mutation.
 *
 * The key is a random UUID-shaped string so a replayed record can be
 * deduplicated server-side even when the response to the first attempt was
 * lost after the server committed. It is generated before the first attempt and
 * persisted with the record so every retry of the same record reuses the
 * same key and a genuinely different mutation never collides with it.
 *
 * @returns A random 128-bit key formatted as a UUID string.
 */
function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Minimal Background Sync event typing. The `WebWorker` lib does not ship
// `SyncEvent`, so declare the surface we use (it extends ExtendableEvent).
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

/** Open (creating on first run) the IndexedDB database backing the offline
 * mutation queue, ensuring the `mutations` object store and its timestamp
 * index exist. Resolves with the ready database handle. */
function openMutationDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MUTATION_DB, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MUTATION_STORE)) {
        const store = db.createObjectStore(MUTATION_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      // Version 2 added the session store; an existing version-1 database is
      // upgraded in place so a returning browser keeps its queued mutations.
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'key' });
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
 * Read the account the page last broadcast as signed in, or `null` when no
 * session is known.
 *
 * The session lives in its own IndexedDB store so it survives service-worker
 * restarts: a worker can be killed at any time, and a mutation queued after a
 * restart must still be stamped with the account that is signed in, not with
 * whatever in-memory state a freshly booted worker happens to have.
 *
 * @returns The persisted user id, or `null` when nothing was broadcast or the
 *   store cannot be read (both mean ownership is unknown, never guessed).
 */
async function readSession(): Promise<string | null> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(SESSION_STORE, 'readonly');
    const store = tx.objectStore(SESSION_STORE);
    const session = await new Promise<StoredSession | undefined>((resolve, reject) => {
      const request = store.get(SESSION_KEY);
      request.onsuccess = () => resolve(request.result as StoredSession | undefined);
      request.onerror = () => reject(request.error);
    });
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the account the page reports as signed in (or `null` on logout).
 *
 * Called from the AUTH_SESSION message so every later queueMutation stamps its
 * records with this account. A storage failure leaves the previous value in
 * place rather than silently clearing ownership.
 *
 * @param userId - The signed-in user id, or `null` when nobody is signed in.
 */
async function saveSession(userId: string | null): Promise<void> {
  const db = await openMutationDB();
  const tx = db.transaction(SESSION_STORE, 'readwrite');
  tx.objectStore(SESSION_STORE).put({ key: SESSION_KEY, userId });
  await transactionDone(tx);
}

/**
 * Queue a mutation for later replay. Returns `true` only when the mutation has
 * been durably persisted to IndexedDB; `false` when persistence failed so the
 * caller can respond with an explicit error instead of claiming it was queued.
 *
 * The record is durably bound to the account the page last broadcast as signed
 * in and to the workspace its path targets, and carries a fresh idempotency
 * key, so a flush can never replay it under a different signed-in user and a
 * retried record can never be applied twice server-side. When no session is
 * known the record is still queued, with `ownerId: null`: ownership is
 * recorded as unknown and the record is surfaced for explicit recovery
 * instead of being guessed (and replayed under whoever happens to be signed
 * in next).
 *
 * @param originatingAccount - Identity captured before the first attempt;
 *   direct queue calls without an attempt read the current stored session.
 */
async function queueMutation(
  method: string,
  path: string,
  body: unknown,
  idempotencyKey = newIdempotencyKey(),
  originatingAccount?: string | null,
): Promise<boolean> {
  if (/^\/auth(?:\/|\?|$)/i.test(path)) return false;
  try {
    const db = await openMutationDB();
    const ownerId = originatingAccount === undefined ? await readSession() : originatingAccount;
    const tx = db.transaction(MUTATION_STORE, 'readwrite');
    const store = tx.objectStore(MUTATION_STORE);
    const record: StoredMutation = {
      method,
      path,
      body: body !== undefined ? JSON.stringify(body) : null,
      timestamp: Date.now(),
      ownerId,
      workspace: workspaceFromPath(path),
      idempotencyKey,
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

/** The outcome of reading the mutation queue: either the mutations were read
 * successfully, or the read failed and the queue state is unknown. The
 * discriminator lets callers distinguish an empty queue from an unreadable
 * one instead of collapsing both into `[]`. */
type QueueReadResult =
  | { ok: true; mutations: QueuedMutation[] }
  | { ok: false; error: unknown };

/** Read every queued mutation out of IndexedDB in insertion order. Returns
 * `{ ok: true, mutations }` on success (including an empty array when the
 * queue is genuinely empty) or `{ ok: false, error }` on storage failure so
 * callers can distinguish an empty queue from an unreadable one instead of
 * treating both as drained. */
async function getQueuedMutations(): Promise<QueueReadResult> {
  try {
    const db = await openMutationDB();
    const tx = db.transaction(MUTATION_STORE, 'readonly');
    const store = tx.objectStore(MUTATION_STORE);
    const mutations = await new Promise<QueuedMutation[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as QueuedMutation[]);
      request.onerror = () => reject(request.error);
    });
    return { ok: true, mutations };
  } catch (error) {
    return { ok: false, error };
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

/**
 * Decide whether one queued mutation may be replayed under the current
 * session, and if not, why.
 *
 * The three refusals are deliberately distinct so a surfaced report tells the
 * user what to do: `no-session` means nobody is signed in (log in and flush
 * again), `unknown-owner` means the record predates ownership tracking (adopt
 * it explicitly), and `owner-mismatch` means the record belongs to a different
 * account and must wait for that account — it is never reassigned silently.
 *
 * @param mut - The queued mutation as IndexedDB returns it.
 * @param currentUserId - The account `/api/auth/me` reports as signed in, or
 *   `null` when nobody is.
 * @returns The refusal reason, or `null` when the record may be replayed.
 */
function replayBlockReason(
  mut: QueuedMutation,
  currentUserId: string | null,
): ReplayBlockReason | null {
  if (/^\/auth(?:\/|\?|$)/i.test(mut.path)) return 'auth-route';
  if (currentUserId === null) return 'no-session';
  // Legacy records queued before ownership tracking have no ownerId at all.
  if (mut.ownerId === undefined || mut.ownerId === null) return 'unknown-owner';
  if (mut.ownerId !== currentUserId) return 'owner-mismatch';
  return null;
}

/** Replay each workspace in FIFO order, removing successes, then post-message the
 * connected clients with how many were replayed or remain. A storage read
 * failure is never treated as a drained queue: the initial read failure
 * aborts the flush, and a final read failure reports a partial result rather
 * than claiming all mutations were replayed.
 *
 * Identity is authoritative from the server: `/api/auth/me` names the account
 * that is signed in, and only records that account queued are replayed.
 * Records owned by a different account, records whose ownership is unknown
 * (legacy, or queued with no known session), and every record while logged
 * out are never replayed and never deleted — they are kept and surfaced via
 * MUTATIONS_BLOCKED so the page can offer explicit recovery. An owned failed
 * or attention record blocks only later records in its workspace. Account-level
 * work is a barrier across workspaces: it cannot overtake earlier unresolved
 * owned work, and unresolved account-level work blocks all later owned work.
 * Different owners have separate ordering. Replayed records carry their key,
 * so a retry after an ambiguous (lost) response is applied exactly once
 * server-side. */
async function replayQueuedMutations(): Promise<void> {
  const read = await getQueuedMutations();
  if (!read.ok) {
    console.warn('Failed to read mutation queue:', read.error);
    return;
  }
  const mutations = read.mutations;
  if (mutations.length === 0) return;

  let replayCsrfToken: string | null;
  let currentUserId: string | null = null;
  try {
    const bootstrap = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
    replayCsrfToken = bootstrap.headers.get('x-csrf-token');
    if (!replayCsrfToken) {
      console.warn('Cannot replay offline mutations without a CSRF bootstrap token');
      return;
    }
    // The bootstrap response is also the authoritative identity check: the
    // signed-in account decides which records may replay. A 401 (or any
    // unparseable body) means nobody is signed in, so every record is kept.
    const me = await bootstrap.json().catch(() => null) as MeBody | null;
    const bootstrapUserId = me?.user?.id;
    currentUserId = typeof bootstrapUserId === 'string' ? bootstrapUserId : null;
  } catch {
    // The network failed during token bootstrap; preserve the entire queue.
    return;
  }

  const blocked: BlockedMutation[] = [];
  const blockedWorkspaces = new Set<string | null>();
  let replayed = 0;
  for (const mut of mutations) {
    // Derive legacy scope from the path rather than assuming it is independent.
    const workspace = workspaceFromPath(mut.path);
    const reason = replayBlockReason(mut, currentUserId)
      ?? (mut.state === 'needs-attention' ? mut.attentionReason ?? 'outcome-unknown' : null)
      ?? (blockedWorkspaces.has(null) || (workspace === null ? blockedWorkspaces.size > 0 : blockedWorkspaces.has(workspace))
        ? 'workspace-order' : null);
    if (reason) {
      // Never replayed, never deleted: kept for its owner and surfaced so the
      // page can offer explicit recovery. Skipping does not stop the loop, so
      // blocked records cannot wedge unrelated owned records behind them.
      blocked.push({
        id: mut.id,
        method: mut.method,
        path: mut.path,
        ownerId: mut.ownerId ?? null,
        workspace,
        reason,
      });
      if (mut.ownerId === currentUserId && currentUserId !== null) blockedWorkspaces.add(workspace);
      continue;
    }
    try {
      const opts: RequestInit = {
        method: mut.method,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': replayCsrfToken,
          'X-PM-Expected-Account': mut.ownerId!,
          ...(mut.idempotencyKey ? { 'Idempotency-Key': mut.idempotencyKey } : {}),
        },
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
        replayed++;
      } else {
        console.warn('Offline mutation failed:', mut.method, mut.path, res.status);
        const body = await res.json().catch(() => null) as { code?: unknown } | null;
        let attention: QueuedMutation['attentionReason'];
        if (body?.code === 'PM_IDEMPOTENCY_OUTCOME_UNKNOWN') attention = 'outcome-unknown';
        if (res.status >= 500) {
          mut.serverFailures = (mut.serverFailures ?? 0) + 1;
          if (mut.serverFailures >= 3) attention = 'repeated-5xx';
        } else if (!attention && mut.serverFailures) {
          mut.serverFailures = 0;
        }
        if (attention) {
          mut.state = 'needs-attention';
          mut.attentionReason = attention;
          blocked.push({ id: mut.id, method: mut.method, path: mut.path,
            ownerId: mut.ownerId ?? null, workspace, reason: attention });
        }
        // Persist before allowing independent workspace replay; failure stops the flush.
        const db = await openMutationDB();
        const tx = db.transaction(MUTATION_STORE, 'readwrite');
        tx.objectStore(MUTATION_STORE).put(mut);
        await transactionDone(tx);
        blockedWorkspaces.add(workspace);
      }
    } catch {
      // Network failed again — stop processing
      break;
    }
  }

  // Notify clients about replayed mutations
  const remainingRead = await getQueuedMutations();
  const clients = await sw.clients.matchAll();
  // Empty reports remove a previously rendered or dismissed recovery set.
  clients.forEach((client) => {
    client.postMessage({ type: 'MUTATIONS_BLOCKED', blocked });
  });
  if (!remainingRead.ok) {
    // Could not re-read the queue — do NOT claim all mutations were replayed.
    // Report a partial result with the known replayed count so unreplayed
    // mutations are not treated as drained.
    console.warn('Failed to re-read mutation queue after replay:', remainingRead.error);
    if (mutations.length > 0) {
      clients.forEach((client) => {
        client.postMessage({
          type: 'MUTATIONS_PARTIAL',
          replayed,
          remaining: mutations.length - replayed,
        });
      });
    }
    return;
  }
  const remaining = remainingRead.mutations;
  if (remaining.length === 0 && mutations.length > 0) {
    clients.forEach((client) => {
      client.postMessage({ type: 'MUTATIONS_REPLAYED', count: mutations.length });
    });
  } else if (remaining.length > 0) {
    clients.forEach((client) => {
      client.postMessage({
        type: 'MUTATIONS_PARTIAL',
        replayed,
        remaining: remaining.length,
      });
    });
  }
}

/** Pending queue operations share one chain across messages, sync and online events. */
let queueOperation: Promise<void> = Promise.resolve();

/** Serialize queue adoption and replay, recovering the chain after an operation fails. */
function runQueueOperation(operation: () => Promise<void>): Promise<void> {
  const pending = queueOperation.then(async () => {
    await sessionUpdate.catch(() => {});
    await operation();
  });
  queueOperation = pending.catch(() => {});
  return pending;
}

/** Flush under the same single-flight chain used for explicit recovery. */
function flushMutationQueue(): Promise<void> {
  return runQueueOperation(replayQueuedMutations);
}

/**
 * Explicitly rebind unknown-owner records to the signed-in account.
 *
 * The page offers this after a flush surfaces records with the `unknown-owner`
 * reason: the signed-in user states that this queued work is theirs. Only
 * records whose ownership is unknown are adoptable — a record already owned by
 * another account is never reassigned, because its true owner may still
 * return to replay it.
 *
 * @param ids - Only these record ids are adopted, or all unknown records when absent.
 * @param ownerId - The approving page's account, verified against the server session.
 * @returns Whether the current server session approved adoption.
 */
function adoptUnknownOwnerRecords(ids: number[] | undefined, ownerId: string): Promise<boolean> {
  return updateRecoveryRecords(ownerId, (store, mut) => {
    if ((mut.ownerId === undefined || mut.ownerId === null)
      && (ids === undefined || ids.includes(mut.id))
      && !/^\/auth(?:\/|\?|$)/i.test(mut.path)) {
      store.put({ ...mut, ownerId, idempotencyKey: mut.idempotencyKey || newIdempotencyKey() });
    }
  });
}

/** Adopt records through the common queue-operation chain used by flushes. */
function rebindUnknownOwnerRecords(ids: number[] | undefined, ownerId: string): Promise<void> {
  return runQueueOperation(async () => { await adoptUnknownOwnerRecords(ids, ownerId); });
}

/** Apply owner-approved retry with a fresh key or discard atomically; never change another owner's work. */
function recoverAttentionRecord(id: number, ownerId: string, action: 'retry-new' | 'discard'): Promise<boolean> {
  return updateRecoveryRecords(ownerId, (store, mut) => {
    if (mut.id !== id || mut.ownerId !== ownerId || mut.state !== 'needs-attention') return;
    if (action === 'discard') store.delete(id);
    else store.put({ ...mut, state: 'queued', attentionReason: undefined, serverFailures: 0, idempotencyKey: newIdempotencyKey() });
  });
}

/** Verify the approving account, then read and update recovery records in one live IndexedDB transaction. */
async function updateRecoveryRecords(ownerId: string, update: (store: IDBObjectStore, mut: QueuedMutation) => void): Promise<boolean> {
  const approval = await fetch('/api/auth/me', {
    credentials: 'include', cache: 'no-store', headers: { 'X-PM-Expected-Account': ownerId },
  });
  if (!approval.ok) return false;
  const me = await approval.json().catch(() => null) as MeBody | null;
  if (me?.user?.id !== ownerId) return false;
  const db = await openMutationDB();
  const tx = db.transaction(MUTATION_STORE, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(MUTATION_STORE);
  const request = store.getAll();
  request.onsuccess = () => {
    for (const mut of request.result as QueuedMutation[]) {
      update(store, mut);
    }
  };
  await done;
  return true;
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
    // Session responses must reach the browser with their live cookie changes.
    // Remove caller keys too; failed auth requests are never queued.
    if (/^\/api\/auth(?:\/|$)/i.test(url.pathname)) {
      const headers = new Headers(event.request.headers);
      headers.delete('Idempotency-Key');
      headers.delete('X-PM-Expected-Account');
      event.respondWith(fetch(new Request(event.request, { headers })));
      return;
    }
    // Queue write operations (POST, PUT, PATCH, DELETE) when offline
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
      const headers = new Headers(event.request.headers);
      if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', newIdempotencyKey());
      event.respondWith(
        (async () => {
          await sessionUpdate.catch(() => {});
          // Capture identity before sending, never after a lost response.
          const ownerId = headers.get('X-PM-Expected-Account') ?? await readSession();
          if (ownerId !== null) headers.set('X-PM-Expected-Account', ownerId);
          const request = new Request(event.request, { headers });
          const queuedRequest = request.clone();
          return fetch(request).catch(async () => {
            // Network failed — queue the mutation for later.
            let body: unknown = undefined;
            try {
              body = await queuedRequest.json();
            } catch { /* no body */ }
            const queued = await queueMutation(
              event.request.method,
              url.pathname.replace('/api', '') + url.search,
              body,
              headers.get('Idempotency-Key') ?? newIdempotencyKey(),
              ownerId,
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
          });
        })(),
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

// Serialise session writes and recovery so adoption cannot read an older login.
let sessionUpdate: Promise<void> = Promise.resolve();

// ── Messages ──
sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as
    | { type?: string; urls?: string[]; userId?: unknown; ids?: unknown; ownerId?: unknown; id?: unknown; action?: unknown }
    | null;
  if (data && data.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
  if (data && data.type === 'CACHE_URLS') {
    const urls = data.urls ?? [];
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urls).catch(() => {}));
  }
  if (data && data.type === 'FLUSH_QUEUE') {
    event.waitUntil(sessionUpdate.then(() => flushMutationQueue()).catch(() => {
      console.warn('Failed to flush offline mutations');
    }));
  }
  if (data && data.type === 'AUTH_SESSION') {
    // The page names the signed-in account so queued mutations are bound to
    // it. `null` (logout) is a valid broadcast: it means ownership of later
    // queues is unknown, never the next signed-in account.
    const userId = typeof data.userId === 'string' ? data.userId : null;
    sessionUpdate = sessionUpdate.catch(() => {}).then(() => saveSession(userId));
    event.waitUntil(sessionUpdate.catch(() => {
      console.warn('Failed to persist offline session');
    }));
  }
  if (data && data.type === 'REBIND_RECORDS') {
    // Explicit recovery: adopt unknown-owner records for the signed-in
    // account. The ids are optional; without them every unknown-owner record
    // is adopted.
    const ids = Array.isArray(data.ids)
      ? data.ids.filter((id): id is number => typeof id === 'number')
      : undefined;
    const ownerId = data.ownerId;
    if (typeof ownerId !== 'string' || ownerId.length === 0) return;
    event.waitUntil(runQueueOperation(async () => {
      if (await adoptUnknownOwnerRecords(ids, ownerId)) await replayQueuedMutations();
    }).catch(() => {
      console.warn('Failed to adopt offline mutations');
    }));
  }
  if (data && data.type === 'RECOVER_RECORD') {
    const { id, ownerId, action } = data;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof ownerId !== 'string' || ownerId.length === 0
      || (action !== 'retry-new' && action !== 'discard')) return;
    event.waitUntil(runQueueOperation(async () => {
      if (await recoverAttentionRecord(id, ownerId, action)) await replayQueuedMutations();
    }).catch(() => {
      console.warn('Failed to recover offline mutation');
    }));
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

// ── Test-only: expose queue internals ──
// app.ts registers this file as a CLASSIC worker (`register('/sw.js', ...)`
// with no `type: 'module'`), so it cannot use `export` — a module-mode script
// fails to load under a classic registration, which would take offline support
// down. That leaves a global as the only seam a test can reach.
//
// It is inert in the browser because a classic service worker is the only
// script that ever runs in its own global scope: no page script, extension or
// import shares it, so nothing exists that could set the flag before this line
// executes. That invariant is the registration mode, not the flag name — if
// app.ts ever registers with `type: 'module'`, replace this with real exports
// rather than keeping both.
const __testGlobals = globalThis as unknown as Record<string, unknown>;
if (__testGlobals.__swTestHarness) {
  __testGlobals.__swInternals = {
    getQueuedMutations,
    flushMutationQueue,
    queueMutation,
    clearMutation,
    saveSession,
    rebindRecords: rebindUnknownOwnerRecords,
  };
}
