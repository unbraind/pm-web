/**
 * Behavioral tests for the service worker mutation-queue drain logic.
 *
 * The service worker has no module system, so sw.ts exposes its queue
 * internals through a globalThis flag (`__swTestHarness`) that is inert in a
 * browser. This test sets that flag and mocks the ServiceWorkerGlobalScope
 * surface (self, indexedDB, caches, clients) before importing the source,
 * then exercises the discriminated-result contract: a storage read failure
 * must never be indistinguishable from an empty queue.
 *
 * The ownership suite covers the multi-user contract: every queued mutation is
 * bound to the account that created it (and the workspace its path targets),
 * carries a server-enforced idempotency key, and can never replay under a
 * different signed-in account. Unknown-owner (legacy) records are preserved
 * and surfaced for explicit recovery without blocking owned records.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mockRequest,
  mockStore,
  swQueue,
  swQueueInternals,
} from "./helpers/sw-queue-preload.ts";
import "../public/src/sw.ts";

const internals = swQueueInternals();
const {
  postedMessages,
} = swQueue;

/** Shape of the `/api/auth/me` body the flush bootstrap reads the identity from. */
interface MeBody {
  user?: { id?: string };
}

/** Build the mocked `/api/auth/me` response the way the real route answers. */
function meResponse(userId: string | null, csrfToken: string): Response {
  const body = JSON.stringify(
    userId === null ? { error: "Authentication required" } : { user: { id: userId } },
  );
  return new Response(body, {
    status: userId === null ? 401 : 200,
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
  });
}

/** A queued-mutation record as IndexedDB returns it, with test-chosen fields. */
function queuedRecord(fields: {
  id: number;
  path: string;
  ownerId?: string | null;
  idempotencyKey?: string;
  method?: string;
}): Record<string, unknown> {
  return {
    id: fields.id,
    method: fields.method ?? "PATCH",
    path: fields.path,
    body: null,
    timestamp: 0,
    ...(fields.ownerId === undefined ? {} : { ownerId: fields.ownerId }),
    ...(fields.idempotencyKey === undefined ? {} : { idempotencyKey: fields.idempotencyKey }),
  };
}

/** The UUID shape every generated idempotency key must have. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Temporarily replaces `globalThis.fetch` and (optionally) `mockStore.getAll`,
 * runs `flushMutationQueue`, and restores both in a finally block. */
async function withMockedFetch(
  fetchImpl: typeof globalThis.fetch,
  getAllImpl?: () => IDBRequest,
  operation: () => Promise<void> = internals.flushMutationQueue,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalGetAll = mockStore.getAll;
  (globalThis as unknown as Record<string, unknown>).fetch = fetchImpl;
  try {
    if (getAllImpl) {
      (mockStore as unknown as Record<string, unknown>).getAll = getAllImpl;
    }
    await operation();
  } finally {
    (mockStore as unknown as Record<string, unknown>).getAll = originalGetAll;
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  }
}

/** Run a queue flush as the given signed-in account and return the mutation
 * paths the flush replayed, in replay order. */
async function flushAs(userId: string | null): Promise<string[]> {
  const replayedPaths: string[] = [];
  await withMockedFetch(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") return meResponse(userId, "current-token");
    replayedPaths.push(url);
    return new Response(null, { status: 204 });
  });
  return replayedPaths;
}

// ── Tests ──

test("sw queue: getQueuedMutations returns ok:false on storage failure, not an empty array", async () => {
  swQueue.openShouldFail = true;
  const result = await internals.getQueuedMutations();
  swQueue.openShouldFail = false;

  assert.equal(result.ok, false, "read failure must return ok:false");
  assert.ok(result.error !== undefined, "read failure must carry the error");
  assert.ok(!("mutations" in result), "read failure must not fabricate a mutations array");
});

test("sw queue: a read failure does not report the queue as drained", async () => {
  swQueue.openShouldFail = true;
  postedMessages.length = 0;
  await internals.flushMutationQueue();
  swQueue.openShouldFail = false;

  assert.equal(postedMessages.length, 0, "no client messages on initial read failure");
  for (const msg of postedMessages) {
    assert.notEqual(msg.type, "MUTATIONS_REPLAYED", "must not claim all mutations were replayed");
  }
});

test("sw queue: a read failure does not delete or lose queued mutations", async () => {
  swQueue.openShouldFail = true;
  swQueue.deleteCallCount = 0;
  await internals.flushMutationQueue();
  swQueue.openShouldFail = false;

  assert.equal(swQueue.deleteCallCount, 0, "no delete calls on read failure — mutations must not be lost");
});

test("sw queue: an empty queue is reported as ok:true with an empty array, not as a failure", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [];
  swQueue.getAllShouldFail = false;

  const result = await internals.getQueuedMutations();

  assert.equal(result.ok, true, "empty queue must return ok:true");
  assert.deepEqual(result.mutations, [], "empty queue must carry an empty mutations array");
});

test("sw queue: an empty queue flush is a no-op — the two outcomes do not collapse", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [];
  swQueue.getAllShouldFail = false;
  postedMessages.length = 0;

  await internals.flushMutationQueue();

  assert.equal(postedMessages.length, 0, "empty queue flush must not post any messages");
});

test("sw queue: a queued mutation is bound to the broadcast account, its workspace and a fresh idempotency key", async () => {
  assert.ok(internals.saveSession, "the worker must persist the session the page broadcasts");
  swQueue.sessionPutValues.length = 0;
  await internals.saveSession("user-alice");

  swQueue.lastAdded = undefined;
  assert.equal(
    await internals.queueMutation("POST", "/projects/proj-1/pm/items", { title: "new" }),
    true,
  );
  const added = swQueue.lastAdded as Record<string, unknown>;
  assert.equal(added.method, "POST");
  assert.equal(added.path, "/projects/proj-1/pm/items");
  assert.equal(added.body, JSON.stringify({ title: "new" }));
  assert.equal(added.ownerId, "user-alice", "the record is bound to the account that queued it");
  assert.equal(added.workspace, "proj-1", "the record is bound to the workspace its path targets");
  assert.match(
    String(added.idempotencyKey),
    UUID_PATTERN,
    "the record carries a generated idempotency key",
  );
  assert.ok(!("csrfToken" in added), "no session token is persisted in the record");

  // Every record gets its own key, so a retried record is deduplicated
  // server-side without suppressing a genuinely different mutation.
  await internals.queueMutation("POST", "/projects/proj-1/pm/items", { title: "second" });
  const second = swQueue.lastAdded as Record<string, unknown>;
  assert.notEqual(second.idempotencyKey, added.idempotencyKey, "each record gets a distinct key");

  // Account-level mutations (no /projects/<id> segment) have no workspace.
  await internals.queueMutation("PATCH", "/groups/profile", { displayName: "Alice" });
  const profile = swQueue.lastAdded as Record<string, unknown>;
  assert.equal(profile.ownerId, "user-alice");
  assert.equal(profile.workspace, null, "an account-level mutation has no workspace");
});

test("sw queue: a mutation queued with no known session is preserved as unknown-owner", async () => {
  assert.ok(internals.saveSession, "the worker must persist the session the page broadcasts");
  // No session was ever broadcast for this browser, so ownership is unknown.
  await internals.saveSession(null);
  swQueue.lastAdded = undefined;
  assert.equal(
    await internals.queueMutation("PATCH", "/items/one", { title: "updated" }),
    true,
  );
  const added = swQueue.lastAdded as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(added).sort(),
    ["body", "idempotencyKey", "method", "ownerId", "path", "timestamp", "workspace"].sort(),
    "the record persists exactly the queue contract fields",
  );
  assert.equal(added.ownerId, null, "unknown ownership is recorded, not guessed");
  assert.match(String(added.idempotencyKey), UUID_PATTERN, "the record still carries an idempotency key");
});

test("sw queue: concurrent queueing stamps every record with the same account and a distinct idempotency key", async () => {
  assert.ok(internals.saveSession, "the worker must persist the session the page broadcasts");
  await internals.saveSession("user-alice");
  swQueue.addedValues.length = 0;

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      internals.queueMutation("POST", `/projects/proj-1/pm/items/${i}`, { seq: i }),
    ),
  );
  assert.deepEqual(
    results,
    Array.from({ length: 8 }, () => true),
    "every concurrent mutation is durably queued",
  );

  assert.equal(swQueue.addedValues.length, 8, "no concurrent mutation is lost");
  const owners = new Set<string>();
  const keys = new Set<string>();
  for (const raw of swQueue.addedValues) {
    const record = raw as Record<string, unknown>;
    owners.add(String(record.ownerId));
    keys.add(String(record.idempotencyKey));
  }
  assert.deepEqual([...owners], ["user-alice"], "all concurrent records carry the same owner");
  assert.equal(keys.size, 8, "each concurrent record carries a distinct idempotency key");
});

test("sw queue: the AUTH_SESSION message persists the account the page broadcasts", async () => {
  const handler = swQueue.listeners["message"] as
    | ((event: { data?: unknown; waitUntil(promise: Promise<unknown>): void }) => void)
    | undefined;
  assert.ok(handler, "the worker must register a message listener");
  swQueue.sessionPutValues.length = 0;
  const pending: Promise<unknown>[] = [];
  handler({ data: { type: "AUTH_SESSION", userId: "user-carol" }, waitUntil: (promise) => { pending.push(promise); } });
  await Promise.all(pending);
  assert.deepEqual(
    swQueue.sessionPutValues,
    [{ key: "current", userId: "user-carol" }],
    "the broadcast account is durably persisted for queue stamping",
  );
});

test("sw queue: a stale mutation token is refreshed and replayed without data loss", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    {
      id: 1,
      method: "PATCH",
      path: "/items/stale",
      body: null,
      ownerId: "user-queue",
      idempotencyKey: "idem-stale",
      csrfToken: "stale-session-token",
      timestamp: 0,
    },
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  const requests: { input: string; token: string | null }[] = [];
  let readCount = 0;
  await withMockedFetch(
    async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ input: url, token: new Headers(init?.headers).get("x-csrf-token") });
      if (url === "/api/auth/me") {
        return meResponse("user-queue", "migrated-token");
      }
      return new Response(null, { status: 204 });
    },
    () => {
      readCount++;
      return mockRequest(readCount === 1 ? swQueue.getAllResult : [], false);
    },
  );

  assert.deepEqual(requests, [
    { input: "/api/auth/me", token: null },
    { input: "/api/items/stale", token: "migrated-token" },
  ]);
  assert.equal(swQueue.deleteCallCount, 1, "the successfully replayed stale record is cleared once");
  assert.deepEqual(postedMessages, [
    { type: "MUTATIONS_BLOCKED", blocked: [] }, { type: "MUTATIONS_REPLAYED", count: 1 },
  ]);
});

test("sw queue: a record owned by another account is never replayed and is kept for its owner", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items/alice", ownerId: "user-alice", idempotencyKey: "key-alice", method: "POST" }),
    queuedRecord({ id: 2, path: "/items/bob", ownerId: "user-bob", idempotencyKey: "key-bob", method: "POST" }),
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  const replayedPaths = await flushAs("user-alice");

  assert.deepEqual(replayedPaths, ["/api/items/alice"], "only the current account's record is replayed");
  assert.equal(swQueue.deleteCallCount, 1, "the owned record is cleared exactly once");

  const blocked = postedMessages.find((msg) => msg.type === "MUTATIONS_BLOCKED");
  assert.ok(blocked, "the foreign-owned record is surfaced for explicit recovery");
  assert.deepEqual(
    blocked.blocked as unknown[],
    [
      {
        id: 2,
        method: "POST",
        path: "/items/bob",
        ownerId: "user-bob",
        workspace: null,
        reason: "owner-mismatch",
      },
    ],
    "the blocked report carries the record and why it was refused",
  );
  const partial = postedMessages.find((msg) => msg.type === "MUTATIONS_PARTIAL");
  assert.ok(partial, "a flush with a kept record reports the partial outcome");
  assert.equal(partial.replayed, 1);
  assert.equal(partial.remaining, 1, "the foreign record stays in the queue — zero data loss");
});

test("sw queue: a record with unknown ownership is surfaced without blocking owned records", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    // Legacy record queued before ownership existed: no ownerId field at all.
    { id: 1, method: "POST", path: "/items/legacy", body: null, timestamp: 0 },
    queuedRecord({ id: 2, path: "/items/mine", ownerId: "user-bob", idempotencyKey: "key-mine" }),
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  const replayedPaths = await flushAs("user-bob");

  assert.deepEqual(replayedPaths, ["/api/items/mine"], "the owned record still replays");
  assert.equal(swQueue.deleteCallCount, 1, "only the owned record is cleared");
  const blocked = postedMessages.find((msg) => msg.type === "MUTATIONS_BLOCKED");
  assert.ok(blocked, "the unknown-owner record is surfaced for explicit recovery");
  const surfaced = blocked.blocked as Array<{ id: number; reason: string; ownerId: string | null }>;
  assert.equal(surfaced[0].id, 1);
  assert.equal(surfaced[0].reason, "unknown-owner");
  assert.equal(surfaced[0].ownerId, null, "unknown ownership is reported as null, not guessed");
});

test("sw queue: a flush with no signed-in session replays nothing and loses nothing", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items/alice", ownerId: "user-alice", idempotencyKey: "key-alice" }),
    queuedRecord({ id: 2, path: "/items/bob", ownerId: "user-bob", idempotencyKey: "key-bob" }),
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  const replayedPaths: string[] = [];
  await withMockedFetch(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") return meResponse(null, "logged-out-token");
    replayedPaths.push(url);
    return new Response(null, { status: 204 });
  });

  assert.deepEqual(replayedPaths, [], "no mutation is replayed while logged out");
  assert.equal(swQueue.deleteCallCount, 0, "no queued mutation is deleted — zero data loss");
  const blocked = postedMessages.find((msg) => msg.type === "MUTATIONS_BLOCKED");
  assert.ok(blocked, "the records are surfaced rather than silently dropped");
  const surfaced = blocked.blocked as Array<{ reason: string }>;
  assert.equal(surfaced.length, 2);
  for (const record of surfaced) {
    assert.equal(record.reason, "no-session", "each record names the missing session as the reason");
  }
  const partial = postedMessages.find((msg) => msg.type === "MUTATIONS_PARTIAL");
  assert.ok(partial);
  assert.equal(partial.replayed, 0);
  assert.equal(partial.remaining, 2);
});

test("sw queue: a replay carries the record's idempotency key so an ambiguous retry is exactly-once", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items/alice", ownerId: "user-alice", idempotencyKey: "idem-alice-1", method: "POST" }),
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  const mutationHeaders: Headers[] = [];
  await withMockedFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/auth/me") return meResponse("user-alice", "current-token");
    mutationHeaders.push(new Headers(init?.headers));
    return new Response(null, { status: 204 });
  });

  assert.equal(mutationHeaders.length, 1);
  assert.equal(
    mutationHeaders[0].get("idempotency-key"),
    "idem-alice-1",
    "the replay echoes the record's idempotency key for server-side deduplication",
  );
  assert.equal(mutationHeaders[0].get("x-csrf-token"), "current-token");
});

test("sw queue: owned records replay in insertion order", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items/first", ownerId: "user-alice", idempotencyKey: "key-1", method: "POST" }),
    queuedRecord({ id: 2, path: "/items/second", ownerId: "user-alice", idempotencyKey: "key-2", method: "POST" }),
  ];
  swQueue.getAllShouldFail = false;
  postedMessages.length = 0;

  const replayedPaths = await flushAs("user-alice");

  assert.deepEqual(replayedPaths, ["/api/items/first", "/api/items/second"]);
  assert.ok(
    postedMessages.some((msg) => msg.type === "MUTATIONS_REPLAYED"),
    "a fully drained queue reports the replayed count",
  );
});

test("sw queue: explicit recovery rebinds unknown-owner records to the current session", async () => {
  assert.ok(internals.rebindRecords, "the worker must expose the explicit recovery operation");
  assert.ok(internals.saveSession);
  await internals.saveSession("user-bob");

  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    { id: 1, method: "POST", path: "/items/legacy", body: null, timestamp: 0 },
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;
  swQueue.putValues.length = 0;

  // First flush: the legacy record is blocked, not replayed.
  await withMockedFetch(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/auth/me") return meResponse("user-bob", "current-token");
    return new Response(null, { status: 204 });
  });
  assert.equal(swQueue.deleteCallCount, 0, "the blocked record is not cleared");

  // Explicit recovery: the signed-in user adopts the unknown-owner record.
  await withMockedFetch(async () => meResponse("user-bob", "current-token"), undefined,
    () => internals.rebindRecords!(undefined, "user-bob"));
  assert.match(String((swQueue.putValues[0] as Record<string, unknown>).idempotencyKey), UUID_PATTERN);
  assert.deepEqual(
    swQueue.putValues,
    [{
      idempotencyKey: (swQueue.putValues[0] as Record<string, unknown>).idempotencyKey,
      id: 1,
      method: "POST",
      path: "/items/legacy",
      body: null,
      timestamp: 0,
      ownerId: "user-bob",
    }],
    "the record is rebound to the account that explicitly adopted it",
  );

  // Second flush: the adopted record is now owned and replays.
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;
  const replayedPaths = await flushAs("user-bob");
  assert.deepEqual(replayedPaths, ["/api/items/legacy"], "the adopted record replays under its new owner");
  assert.equal(swQueue.deleteCallCount, 1);
});

test("sw queue: explicit recovery never adopts a record already owned by another account", async () => {
  assert.ok(internals.rebindRecords, "the worker must expose the explicit recovery operation");
  assert.ok(internals.saveSession);
  await internals.saveSession("user-bob");

  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items/alice", ownerId: "user-alice", idempotencyKey: "key-alice" }),
  ];
  swQueue.getAllShouldFail = false;
  swQueue.putValues.length = 0;

  await withMockedFetch(async () => meResponse("user-bob", "current-token"), undefined,
    () => internals.rebindRecords!(undefined, "user-bob"));

  assert.deepEqual(swQueue.putValues, [], "a foreign-owned record is never reassigned");
  const record = swQueue.getAllResult[0] as Record<string, unknown>;
  assert.equal(record.ownerId, "user-alice", "the original owner is preserved");
});

test("sw queue: a failed token bootstrap preserves every queued mutation", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items/preserved", ownerId: "user-queue", idempotencyKey: "key-preserved" }),
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  await withMockedFetch(async () => new Response(null, { status: 200 }));

  assert.equal(swQueue.deleteCallCount, 0, "bootstrap failure must not delete queued work");
  assert.equal(postedMessages.length, 0, "bootstrap failure cannot claim replay progress");
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
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    queuedRecord({ id: 1, path: "/items", ownerId: "user-queue", idempotencyKey: "key-1", method: "POST" }),
    queuedRecord({ id: 2, path: "/items", ownerId: "user-queue", idempotencyKey: "key-2", method: "POST" }),
  ];
  swQueue.getAllShouldFail = false;
  postedMessages.length = 0;

  let sent = 0;
  let callCount = 0;
  await withMockedFetch(
    async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input) === "/api/auth/me") {
        return meResponse("user-queue", "current-token");
      }
      sent++;
      assert.equal(new Headers(init?.headers).get("x-csrf-token"), "current-token");
      return new Response(null, { status: 204 });
    },
    () => {
      callCount++;
      // The second read is the post-replay re-read; fail only that one.
      return callCount === 2 ? mockRequest([], true) : mockRequest(swQueue.getAllResult, false);
    },
  );

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

test("sw queue: the first network attempt and lost-response queue share one key", async () => {
  await internals.saveSession?.("user-alice");
  const originalFetch = globalThis.fetch;
  let firstKey: string | null = null;
  globalThis.fetch = async (input) => {
    const request = input as Request;
    firstKey = request.headers.get("idempotency-key");
    await request.text(); // the network consumed the request before losing the response
    throw new TypeError("response lost after commit");
  };
  try {
    for (const suppliedKey of [undefined, "client-original-key"]) {
      let response: Promise<Response> | undefined;
      swQueue.listeners.fetch({
        request: new Request("https://pm.example/api/groups", {
          method: "POST", body: JSON.stringify({ name: "lost" }),
          headers: suppliedKey ? { "idempotency-key": suppliedKey } : {},
        }),
        respondWith: (result: Promise<Response>) => { response = result; },
      });
      assert.equal((await response)?.status, 202);
      assert.ok(firstKey, "the original network attempt is keyed");
      assert.equal((swQueue.lastAdded as Record<string, unknown>).idempotencyKey, firstKey);
      if (suppliedKey) assert.equal(firstKey, suppliedKey);
      assert.equal((swQueue.lastAdded as Record<string, unknown>).body, JSON.stringify({ name: "lost" }));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sw queue: AUTH_SESSION extends event lifetime and handles storage failure", async () => {
  for (const fail of [false, true]) {
    swQueue.openShouldFail = fail;
    const pending: Promise<unknown>[] = [];
    swQueue.listeners.message({
      data: { type: "AUTH_SESSION", userId: "user-lifetime" },
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    });
    assert.equal(pending.length, 1, "session persistence is held by waitUntil");
    await Promise.all(pending);
    if (!fail) assert.deepEqual(swQueue.sessionRecord, { key: "current", userId: "user-lifetime" });
  }
  Object.assign(swQueue, { openShouldFail: false });
});

test("sw queue: auth requests are never keyed, queued or replayed from legacy records", async () => {
  const originalFetch = globalThis.fetch;
  const attempts: Request[] = [];
  globalThis.fetch = async (input) => {
    attempts.push(input as Request);
    throw new TypeError("offline auth request");
  };
  try {
    swQueue.addedValues.length = 0;
    for (const path of ["login", "logout", "register", "session"]) {
      let response: Promise<Response> | undefined;
      swQueue.listeners.fetch({
        request: new Request(`https://pm.example/api/auth/${path}`, { method: "POST", headers: { "idempotency-key": "caller-auth-key" } }),
        respondWith: (promise: Promise<Response>) => { response = promise; },
      });
      assert.ok(response);
      await assert.rejects(response, /offline auth request/);
    }
    assert.ok(attempts.every((request) => !request.headers.has("idempotency-key")));
    assert.equal(swQueue.addedValues.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  swQueue.getAllResult = [queuedRecord({ id: 99, path: "/auth/logout", ownerId: "user-alice", idempotencyKey: "legacy-auth-key" })];
  assert.deepEqual(await flushAs("user-alice"), []);
  assert.equal(swQueue.getAllResult.length, 1, "legacy auth work is preserved for manual recovery");
});

test("sw queue: overlapping adoptions read and write in one transaction and keep existing keys", async () => {
  swQueue.getAllResult = [
    queuedRecord({ id: 101, path: "/groups", idempotencyKey: "existing-original-key" }),
    queuedRecord({ id: 102, path: "/groups" }),
    queuedRecord({ id: 103, path: "/groups" }),
  ];
  swQueue.putValues.length = 0;
  swQueue.transactions.length = 0;
  await withMockedFetch(async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("x-pm-expected-account"), "user-alice");
    return meResponse("user-alice", "current-token");
  }, undefined, async () => {
    await Promise.all([
      internals.rebindRecords!([101, 102], "user-alice"),
      internals.rebindRecords!([101, 102], "user-alice"),
    ]);
  });
  assert.equal(swQueue.putValues.length, 2, "one adoption write per selected record");
  const records = swQueue.getAllResult as Array<Record<string, unknown>>;
  assert.equal(records[0].idempotencyKey, "existing-original-key");
  assert.equal(records[0].ownerId, "user-alice");
  assert.equal(records[1].ownerId, "user-alice");
  assert.equal(records[2].ownerId, undefined, "unselected work remains unknown");
  assert.match(String(records[1].idempotencyKey), UUID_PATTERN);
  assert.ok(swQueue.transactions.some((transaction) => transaction.mode === "readwrite"
    && transaction.operations.join(",") === "getAll,put,put"));
});
