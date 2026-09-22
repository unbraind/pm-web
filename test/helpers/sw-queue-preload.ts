/**
 * Install service-worker mocks before `public/src/sw.ts` evaluates.
 *
 * The worker reads `self`, IndexedDB and `caches` at module load. A static
 * import of this module from the suite runs first and publishes the same
 * mutable fixtures the tests drive.
 */

/** Mutable IndexedDB and client fixtures shared with the queue suite. */
export const swQueue = {
  openShouldFail: false,
  getAllResult: [] as unknown[],
  getAllShouldFail: false,
  deleteCallCount: 0,
  lastAdded: undefined as unknown,
  postedMessages: [] as { type: string; [key: string]: unknown }[],
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

export const mockStore: IDBObjectStore = {
  getAll: () => mockRequest(swQueue.getAllResult, swQueue.getAllShouldFail),
  add: (value: unknown) => {
    swQueue.lastAdded = value;
    return mockRequest(undefined, false);
  },
  delete: () => {
    swQueue.deleteCallCount += 1;
    return mockRequest(undefined, false);
  },
} as unknown as IDBObjectStore;

const mockTransaction: IDBTransaction = {
  objectStore: () => mockStore,
  oncomplete: null,
  onabort: null,
  onerror: null,
} as unknown as IDBTransaction;

/** Schedule oncomplete after the caller assigns handlers. */
function scheduleCommit(): void {
  queueMicrotask(() => (mockTransaction.oncomplete as (() => void) | null)?.());
}

const mockDB: IDBDatabase = {
  transaction: () => {
    scheduleCommit();
    return mockTransaction;
  },
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
  addEventListener: () => {},
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
