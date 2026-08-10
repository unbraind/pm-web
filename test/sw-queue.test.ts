/**
 * Behavioral tests for the service worker mutation-queue drain logic.
 *
 * The service worker has no module system, so sw.ts exposes its queue
 * internals through a globalThis flag (`__swTestHarness`) that is inert in a
 * browser. This test sets that flag and mocks the ServiceWorkerGlobalScope
 * surface (self, indexedDB, caches, clients) before importing the source,
 * then exercises the discriminated-result contract: a storage read failure
 * must never be indistinguishable from an empty queue.
 */
import assert from "node:assert/strict";
import test from "node:test";

// ── Mock IndexedDB ──

/** Whether the next `indexedDB.open()` call should reject. */
let openShouldFail = false;
/** The result array returned by the next `store.getAll()` call. */
let getAllResult: unknown[] = [];
/** Whether the next `store.getAll()` request should error. */
let getAllShouldFail = false;
/** Count of `store.delete()` calls, to prove no mutations are lost on read failure. */
let deleteCallCount = 0;

/**
 * Minimal mock IDB request: stores the success/error callbacks and fires one
 * via a microtask so the caller has time to assign `onsuccess`/`onerror`.
 */
function mockRequest(result: unknown, shouldFail: boolean): IDBRequest {
  const req: IDBRequest = {
    result,
    error: shouldFail ? new Error("mock IDB read failure") : null,
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
  } as unknown as IDBRequest;
  queueMicrotask(() => {
    if (shouldFail) (req.onerror as (() => void) | null)?.();
    else (req.onsuccess as (() => void) | null)?.();
  });
  return req;
}

const mockStore: IDBObjectStore = {
  getAll: () => mockRequest(getAllResult, getAllShouldFail),
  add: () => mockRequest(undefined, false),
  delete: () => { deleteCallCount++; return mockRequest(undefined, false); },
} as unknown as IDBObjectStore;

const mockTransaction: IDBTransaction = {
  objectStore: () => mockStore,
  oncomplete: null,
  onabort: null,
  onerror: null,
} as unknown as IDBTransaction;

// Schedule oncomplete after the caller assigns handlers.
function scheduleCommit(): void {
  queueMicrotask(() => (mockTransaction.oncomplete as (() => void) | null)?.());
}

const mockDB: IDBDatabase = {
  transaction: () => { scheduleCommit(); return mockTransaction; },
  objectStoreNames: { contains: () => true } as unknown as DOMStringList,
  close: () => {},
} as unknown as IDBDatabase;

const mockIndexedDB: IDBFactory = {
  open: () => mockRequest(mockDB, openShouldFail),
} as unknown as IDBFactory;

// ── Mock ServiceWorkerGlobalScope surface ──

const postedMessages: { type: string; [key: string]: unknown }[] = [];
const mockClients = [
  { postMessage: (msg: unknown) => postedMessages.push(msg as { type: string; [key: string]: unknown }) },
];

const mockSelf = {
  addEventListener: () => {},
  skipWaiting: () => {},
  clients: {
    matchAll: async () => mockClients,
    claim: () => {},
  },
};

// Install mocks and the test-harness flag before importing sw.ts.
const g = globalThis as unknown as Record<string, unknown>;
g.self = mockSelf;
g.indexedDB = mockIndexedDB;
g.caches = { open: async () => ({ add: async () => {}, put: async () => {}, match: async () => undefined }), keys: async () => [], delete: async () => true };
g.__swTestHarness = true;

// ── Import sw.ts (runs module-level code, registers listeners, exposes internals) ──

const swUrl = new URL("../public/src/sw.ts", import.meta.url).href;
await import(swUrl);

interface QueueReadResultLike {
  ok: boolean;
  mutations?: unknown[];
  error?: unknown;
}

const internals = (g.__swInternals as {
  getQueuedMutations: () => Promise<QueueReadResultLike>;
  flushMutationQueue: () => Promise<void>;
  clearMutation: (id: number) => Promise<boolean>;
  queueMutation: (method: string, path: string, body: unknown) => Promise<boolean>;
});

// ── Tests ──

test("sw queue: getQueuedMutations returns ok:false on storage failure, not an empty array", async () => {
  openShouldFail = true;
  const result = await internals.getQueuedMutations();
  openShouldFail = false;

  assert.equal(result.ok, false, "read failure must return ok:false");
  assert.ok(result.error !== undefined, "read failure must carry the error");
  assert.ok(!("mutations" in result), "read failure must not fabricate a mutations array");
});

test("sw queue: a read failure does not report the queue as drained", async () => {
  openShouldFail = true;
  postedMessages.length = 0;
  await internals.flushMutationQueue();
  openShouldFail = false;

  assert.equal(postedMessages.length, 0, "no client messages on initial read failure");
  for (const msg of postedMessages) {
    assert.notEqual(msg.type, "MUTATIONS_REPLAYED", "must not claim all mutations were replayed");
  }
});

test("sw queue: a read failure does not delete or lose queued mutations", async () => {
  openShouldFail = true;
  deleteCallCount = 0;
  await internals.flushMutationQueue();
  openShouldFail = false;

  assert.equal(deleteCallCount, 0, "no delete calls on read failure — mutations must not be lost");
});

test("sw queue: an empty queue is reported as ok:true with an empty array, not as a failure", async () => {
  openShouldFail = false;
  getAllResult = [];
  getAllShouldFail = false;

  const result = await internals.getQueuedMutations();

  assert.equal(result.ok, true, "empty queue must return ok:true");
  assert.deepEqual(result.mutations, [], "empty queue must carry an empty mutations array");
});

test("sw queue: an empty queue flush is a no-op — the two outcomes do not collapse", async () => {
  openShouldFail = false;
  getAllResult = [];
  getAllShouldFail = false;
  postedMessages.length = 0;

  await internals.flushMutationQueue();

  assert.equal(postedMessages.length, 0, "empty queue flush must not post any messages");
});

test("sw queue: a final read failure after replay does not claim all mutations were replayed", async () => {
  // First read succeeds with one mutation; the replay loop is skipped because
  // fetch is not mocked to succeed, so the loop breaks on the first fetch
  // failure. The second read (remainingRead) fails, so the flush must NOT
  // post MUTATIONS_REPLAYED.
  openShouldFail = false;
  getAllResult = [{ id: 1, method: "POST", path: "/items", body: null, timestamp: 0 }];
  getAllShouldFail = false;
  postedMessages.length = 0;

  // Override fetch to throw so the replay loop breaks immediately.
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = async () => { throw new Error("network"); };

  try {
    // Make the second getQueuedMutations call fail by toggling openShouldFail
    // after the first call. We use a call counter.
    let callCount = 0;
    const originalGetAll = mockStore.getAll;
  (mockStore as unknown as Record<string, unknown>).getAll = () => {
      callCount++;
      if (callCount === 2) {
        // Second read — simulate failure at the getAll level
        return mockRequest([], true);
      }
      return mockRequest(getAllResult, false);
    };

    await internals.flushMutationQueue();

    (mockStore as unknown as Record<string, unknown>).getAll = originalGetAll;
  } finally {
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  }

  // The flush must not post MUTATIONS_REPLAYED on a final read failure.
  for (const msg of postedMessages) {
    assert.notEqual(msg.type, "MUTATIONS_REPLAYED", "final read failure must not claim all replayed");
  }
});