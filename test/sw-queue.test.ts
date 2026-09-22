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

test("sw queue: an offline mutation is persisted without a stale session token", async () => {
  swQueue.lastAdded = undefined;
  assert.equal(
    await internals.queueMutation("PATCH", "/items/one", { title: "updated" }),
    true,
  );
  assert.deepEqual(swQueue.lastAdded, {
    method: "PATCH",
    path: "/items/one",
    body: JSON.stringify({ title: "updated" }),
    timestamp: (swQueue.lastAdded as { timestamp: number }).timestamp,
  });
});

test("sw queue: a stale mutation token is refreshed and replayed without data loss", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [
    {
      id: 1,
      method: "PATCH",
      path: "/items/stale",
      body: null,
      csrfToken: "stale-session-token",
      timestamp: 0,
    },
  ];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
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
      return mockRequest(readCount === 1 ? swQueue.getAllResult : [], false);
    };
    await internals.flushMutationQueue();
  } finally {
    (mockStore as unknown as Record<string, unknown>).getAll = originalGetAll;
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { input: "/api/auth/me", token: null },
    { input: "/api/items/stale", token: "migrated-token" },
  ]);
  assert.equal(swQueue.deleteCallCount, 1, "the successfully replayed stale record is cleared once");
  assert.deepEqual(postedMessages, [{ type: "MUTATIONS_REPLAYED", count: 1 }]);
});

test("sw queue: a failed token bootstrap preserves every queued mutation", async () => {
  swQueue.openShouldFail = false;
  swQueue.getAllResult = [{ id: 1, method: "PATCH", path: "/items/preserved", body: null, timestamp: 0 }];
  swQueue.getAllShouldFail = false;
  swQueue.deleteCallCount = 0;
  postedMessages.length = 0;

  const originalFetch = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = async () => new Response(null, { status: 200 });
  try {
    await internals.flushMutationQueue();
  } finally {
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  }

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
    { id: 1, method: "POST", path: "/items", body: null, csrfToken: "queued-csrf", timestamp: 0 },
    { id: 2, method: "POST", path: "/items", body: null, csrfToken: "queued-csrf", timestamp: 0 },
  ];
  swQueue.getAllShouldFail = false;
  postedMessages.length = 0;

  const originalFetch = globalThis.fetch;
  let sent = 0;
  (globalThis as unknown as Record<string, unknown>).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    if (String(input) === "/api/auth/me") {
      return new Response(null, { status: 200, headers: { "x-csrf-token": "current-token" } });
    }
    sent++;
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), "current-token");
    return new Response(null, { status: 204 });
  };

  const originalGetAll = mockStore.getAll;
  try {
    let callCount = 0;
    (mockStore as unknown as Record<string, unknown>).getAll = () => {
      callCount++;
      // The second read is the post-replay re-read; fail only that one.
      return callCount === 2 ? mockRequest([], true) : mockRequest(swQueue.getAllResult, false);
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
