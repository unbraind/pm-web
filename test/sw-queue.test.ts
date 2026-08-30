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
/** Last mutation record passed to `store.add`, used to verify token durability. */
let lastAdded: unknown;

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
  add: (value: unknown) => { lastAdded = value; return mockRequest(undefined, false); },
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
  queueMutation: (
    method: string,
    path: string,
    body: unknown,
    csrfToken: string | null,
  ) => Promise<boolean>;
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

test("sw queue: the CSRF token is persisted with an offline mutation", async () => {
  lastAdded = undefined;
  assert.equal(
    await internals.queueMutation("PATCH", "/items/one", { title: "updated" }, "queued-csrf"),
    true,
  );
  assert.deepEqual(lastAdded, {
    method: "PATCH",
    path: "/items/one",
    body: JSON.stringify({ title: "updated" }),
    csrfToken: "queued-csrf",
    timestamp: (lastAdded as { timestamp: number }).timestamp,
  });
});

test("sw queue: a legacy mutation bootstraps a token and replays without data loss", async () => {
  openShouldFail = false;
  getAllResult = [
    { id: 1, method: "PATCH", path: "/items/legacy", body: null, timestamp: 0 },
  ];
  getAllShouldFail = false;
  deleteCallCount = 0;
  postedMessages.length = 0;

  const originalFetch = globalThis.fetch;
  const originalGetAll = mockStore.getAll;
  const requests: { input: string; token: string | null }[] = [];
  (globalThis as unknown as Record<string, unknown>).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push({ input: url, token: new Headers(init?.headers).get("x-csrf-token") });
    if (url === "/api/auth/me") {
      return new Response(null, { status: 200, headers: { "x-csrf-token": "migrated-token" } });
    }
    return new Response(null, { status: 204 });
  };

  try {
    let readCount = 0;
    (mockStore as unknown as Record<string, unknown>).getAll = () => {
      readCount++;
      return mockRequest(readCount === 1 ? getAllResult : [], false);
    };
    await internals.flushMutationQueue();
  } finally {
    (mockStore as unknown as Record<string, unknown>).getAll = originalGetAll;
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { input: "/api/auth/me", token: null },
    { input: "/api/items/legacy", token: "migrated-token" },
  ]);
  assert.equal(deleteCallCount, 1, "the successfully replayed legacy record is cleared once");
  assert.deepEqual(postedMessages, [{ type: "MUTATIONS_REPLAYED", count: 1 }]);
});

test("sw queue: a final read failure after replay reports the known replayed count, not a full drain", async () => {
  // The mutations must actually replay before the final read fails, otherwise
  // `replayed` is 0 for the trivial reason that the loop never ran and the
  // test cannot distinguish a correct count from a hardcoded zero. So fetch
  // succeeds here: both queued mutations are sent and cleared, then the second
  // read (remainingRead) fails. Two rather than one so the reported count is
  // non-trivial - a test asserting `replayed: 1` cannot tell a real count from
  // an off-by-one. The flush must report MUTATIONS_PARTIAL carrying that count
  // rather than MUTATIONS_REPLAYED.
  openShouldFail = false;
  getAllResult = [
    { id: 1, method: "POST", path: "/items", body: null, csrfToken: "queued-csrf", timestamp: 0 },
    { id: 2, method: "POST", path: "/items", body: null, csrfToken: "queued-csrf", timestamp: 0 },
  ];
  getAllShouldFail = false;
  postedMessages.length = 0;

  const originalFetch = globalThis.fetch;
  let sent = 0;
  (globalThis as unknown as Record<string, unknown>).fetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    sent++;
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), "queued-csrf");
    return new Response(null, { status: 204 });
  };

  const originalGetAll = mockStore.getAll;
  try {
    let callCount = 0;
    (mockStore as unknown as Record<string, unknown>).getAll = () => {
      callCount++;
      // The second read is the post-replay re-read; fail only that one.
      return callCount === 2 ? mockRequest([], true) : mockRequest(getAllResult, false);
    };

    await internals.flushMutationQueue();
  } finally {
    (mockStore as unknown as Record<string, unknown>).getAll = originalGetAll;
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  }

  assert.equal(sent, 2, "both queued mutations must be replayed before the final read fails");

  const partial = postedMessages.find((msg) => msg.type === "MUTATIONS_PARTIAL");
  assert.ok(partial, "a final read failure must still report a partial result");
  assert.equal(partial.replayed, 2, "the known replayed count must be reported, not zero");
  assert.equal(partial.remaining, 0, "remaining is what the failed read could not confirm");
  assert.equal(
    postedMessages.filter((msg) => msg.type === "MUTATIONS_REPLAYED").length,
    0,
    "a final read failure must never claim the queue drained",
  );
});
