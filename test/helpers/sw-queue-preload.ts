/**
 * Install service-worker mocks before `public/src/sw.ts` evaluates.
 *
 * The worker reads `self`, IndexedDB and `caches` at module load. A static
 * import of this module from the suite runs first and publishes the same
 * mutable fixtures the tests drive.
 *
 * The IndexedDB mock models the queue's two object stores separately, because
 * the ownership binding keeps the signed-in session in its own `session` store
 * while mutation records live in `mutations`: `transaction(storeName)` routes
 * to the matching store mock, so a test can seed records and the session
 * independently exactly like a real browser would.
 */

/** Mutable IndexedDB, session and client fixtures shared with the queue suite. */
export const swQueue = {
  openShouldFail: false,
  getAllResult: [] as unknown[],
  getAllShouldFail: false,
  deleteCallCount: 0,
  /** How many records `add` accepted, for the concurrency assertions. */
  addCallCount: 0,
  /** Every record `add` accepted, in arrival order. */
  addedValues: [] as unknown[],
  /** The most recent record `add` accepted. */
  lastAdded: undefined as unknown,
  /** Every record `put` accepted (explicit owner rebinding writes). */
  putValues: [] as unknown[],
  /** What the `session` store `get` resolves with (`undefined` = no session). */
  sessionRecord: undefined as unknown,
  /** Every session record `put` accepted. */
  sessionPutValues: [] as unknown[],
  postedMessages: [] as { type: string; [key: string]: unknown }[],
  /** Event listeners the worker registered, keyed by event type. */
  listeners: {} as Record<string, (event: unknown) => void>,
  /** Store operations grouped by transaction, proving adoption reads and writes atomically. */
  transactions: [] as Array<{ store: string; mode?: IDBTransactionMode; operations: string[] }>,
};

/**
 * Minimal mock IDB request: stores the success/error callbacks and fires one
 * via a microtask so the caller has time to assign `onsuccess`/`onerror`.
 */
export function mockRequest(result: unknown, shouldFail: boolean): IDBRequest {
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

/** The mock for the `mutations` object store (auto-increment `id` keyPath).
 *
 * `put` and `delete` keep `swQueue.getAllResult` in sync the way a real
 * IndexedDB store would, so a second flush within one test observes exactly
 * the records that survived the first one instead of the seeded snapshot. */
export const mockStore: IDBObjectStore = {
  getAll: () => mockRequest(structuredClone(swQueue.getAllResult), swQueue.getAllShouldFail),
  add: (value: unknown) => {
    swQueue.addCallCount += 1;
    swQueue.lastAdded = value;
    swQueue.addedValues.push(value);
    return mockRequest(undefined, false);
  },
  put: (value: unknown) => {
    swQueue.putValues.push(value);
    upsertRecord(value);
    return mockRequest(undefined, false);
  },
  delete: (key: IDBValidKey) => {
    swQueue.deleteCallCount += 1;
    swQueue.getAllResult = swQueue.getAllResult.filter(
      (existing) => (existing as { id?: unknown }).id !== key,
    );
    return mockRequest(undefined, false);
  },
} as unknown as IDBObjectStore;

/** Replace the `getAllResult` entry with the same `id`, or append it. */
function upsertRecord(value: unknown): void {
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "number") return;
  const index = swQueue.getAllResult.findIndex(
    (existing) => (existing as { id?: unknown }).id === id,
  );
  if (index >= 0) swQueue.getAllResult[index] = value;
  else swQueue.getAllResult.push(value);
}

/**
 * The mock for the `session` object store (`key` keyPath, single row).
 *
 * `put` keeps `swQueue.sessionRecord` in sync the way a real store would, so
 * a later `readSession` inside the worker observes the account the test
 * broadcast instead of the value the fixture was seeded with.
 *
 * Kept unexported: tests drive it through `swQueue.sessionRecord` (the value
 * `get` resolves with) and `swQueue.sessionPutValues` (the writes `put`
 * accepted), so the fixture stays a plain data sink exactly like `mockStore`.
 */
const mockSessionStore: IDBObjectStore = {
  get: () => mockRequest(swQueue.sessionRecord, false),
  put: (value: unknown) => {
    swQueue.sessionPutValues.push(value);
    swQueue.sessionRecord = value;
    return mockRequest(undefined, false);
  },
} as unknown as IDBObjectStore;

/**
 * Build one mock transaction over the store `name`.
 *
 * A fresh transaction object per call mirrors real IndexedDB, where concurrent
 * `queueMutation` calls each get their own transaction with their own commit
 * callback. Sharing one object would make the last caller's `oncomplete`
 * assignment overwrite the earlier waiters', deadlocking every parallel
 * queue operation.
 */
function openMockTransaction(name: string, mode?: IDBTransactionMode): IDBTransaction {
  const entry = { store: name, mode, operations: [] as string[] };
  swQueue.transactions.push(entry);
  const store = name === "session" ? mockSessionStore : Object.assign({}, mockStore, {
    /** Log a transactional read without changing the fixture's request behavior. */
    getAll: (): IDBRequest => { entry.operations.push("getAll"); return mockStore.getAll(); },
    /** Log a transactional write without changing the fixture's persistence behavior. */
    put: (value: unknown): IDBRequest => { entry.operations.push("put"); return mockStore.put(value); },
  });
  const tx: IDBTransaction = {
    objectStore: () => store,
    oncomplete: null,
    onabort: null,
    onerror: null,
  } as unknown as IDBTransaction;
  setTimeout(() => (tx.oncomplete as (() => void) | null)?.(), 0);
  return tx;
}

const mockDB: IDBDatabase = {
  transaction: (storeName: string, mode?: IDBTransactionMode) => openMockTransaction(storeName, mode),
  objectStoreNames: { contains: () => true } as unknown as DOMStringList,
  close: () => {},
} as unknown as IDBDatabase;

const mockIndexedDB: IDBFactory = {
  open: () => mockRequest(mockDB, swQueue.openShouldFail),
} as unknown as IDBFactory;

const mockClients = [
  {
    postMessage: (msg: unknown) => {
      swQueue.postedMessages.push(msg as { type: string; [key: string]: unknown });
    },
  },
];

const mockSelf = {
  addEventListener: (type: string, handler: (event: never) => void) => {
    swQueue.listeners[type] = handler as (event: unknown) => void;
  },
  skipWaiting: () => {},
  clients: {
    matchAll: async () => mockClients,
    claim: () => {},
  },
};

const swGlobals = globalThis as unknown as Record<string, unknown>;
swGlobals.self = mockSelf;
swGlobals.indexedDB = mockIndexedDB;
swGlobals.caches = {
  open: async () => ({
    add: async () => {},
    put: async () => {},
    match: async () => undefined,
  }),
  keys: async () => [],
  delete: async () => true,
};
swGlobals.__swTestHarness = true;

/** Queue operations the worker publishes when the test harness flag is set. */
export interface SwQueueInternals {
  getQueuedMutations: () => Promise<{ ok: boolean; mutations?: unknown[]; error?: unknown }>;
  flushMutationQueue: () => Promise<void>;
  clearMutation: (id: number) => Promise<boolean>;
  queueMutation: (method: string, path: string, body: unknown) => Promise<boolean>;
  /** Persists the signed-in account the way the AUTH_SESSION message does. */
  saveSession?: (userId: string | null) => Promise<void>;
  /** Rebinds unknown-owner records only after verifying the page's approving account. */
  rebindRecords?: (ids: number[] | undefined, ownerId: string) => Promise<void>;
}

/**
 * Read the harness internals installed by the worker module.
 *
 * @returns The queue operations published on `globalThis`.
 */
export function swQueueInternals(): SwQueueInternals {
  const value = swGlobals.__swInternals;
  if (!isSwQueueInternals(value)) {
    throw new Error("service worker test internals were not installed");
  }
  return value;
}

/** Whether a value has the queue operations the suite calls. */
function isSwQueueInternals(value: unknown): value is SwQueueInternals {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.getQueuedMutations === "function"
    && typeof candidate.flushMutationQueue === "function"
    && typeof candidate.clearMutation === "function"
    && typeof candidate.queueMutation === "function";
}
