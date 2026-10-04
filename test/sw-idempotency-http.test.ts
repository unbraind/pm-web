/** Real HTTP response loss after a PostgreSQL commit exercises worker queue replay. */
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { swQueue, swQueueInternals } from "./helpers/sw-queue-preload.ts";
import "../public/src/sw.ts";
import { authCookie, seedPasswordUser, setupOwnerAppTest, type AppServer, type SeedUser } from "./helpers/pg-harness.ts";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";
import { createTierLimiters } from "../src/rate-limit.ts";
import { signToken } from "../src/auth.ts";
import { pool } from "../src/db.ts";

test("a real HTTP response lost after commit replays the queued write exactly once", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const networkFetch = globalThis.fetch;
  const auth = `Bearer ${signToken({ userId: owner.id, email: owner.email })}`;
  const keys: Array<string | undefined> = [];
  let loseResponse = true;
  const proxy = express();
  proxy.use(express.json());
  const limits = createTierLimiters(process.env);
  proxy.use(limits.read, limits.write);
  proxy.all("/api/{*path}", async (req, res) => {
    const key = req.get("idempotency-key");
    if (req.method === "POST") keys.push(key);
    const upstream = await networkFetch(server.url(req.originalUrl), {
      method: req.method,
      headers: { authorization: auth, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}),
        ...(req.get("x-pm-expected-account") ? { "x-pm-expected-account": req.get("x-pm-expected-account")! } : {}) },
      ...(req.method === "POST" ? { body: JSON.stringify(req.body as unknown) } : {}),
    });
    const body = await upstream.text(); // the real app has committed and finished its response
    if (req.method === "POST" && loseResponse) {
      loseResponse = false;
      req.socket.destroy(); // caller gets a network failure, not the committed response
      return;
    }
    upstream.headers.forEach((value, name) => { res.setHeader(name, value); });
    res.status(upstream.status).send(body);
  });
  const transport = await startEphemeralServer(proxy);
  t.after(() => transport.close());
  const worker = swQueueInternals();
  await worker.saveSession?.(owner.id);
  let response: Promise<Response> | undefined;
  swQueue.listeners.fetch({
    request: new Request(transport.url("/api/groups"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "lost-http-response" }),
    }),
    respondWith: (promise: Promise<Response>) => { response = promise; },
  });
  assert.equal((await response)?.status, 202);
  assert.ok(keys[0], "the committed first attempt carried a key");
  const queued = swQueue.lastAdded as Record<string, unknown>;
  assert.equal(queued.idempotencyKey, keys[0]);
  swQueue.getAllResult = [{ ...queued, id: 1 }];
  // Resolve the worker's browser-relative URLs through the real loopback HTTP proxy.
  globalThis.fetch = (input, init) => networkFetch(transport.url(String(input)), init);
  try {
    await worker.flushMutationQueue();
  } finally {
    Object.assign(globalThis, { fetch: networkFetch });
  }
  assert.deepEqual(keys, [queued.idempotencyKey, queued.idempotencyKey]);
  const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pm_groups WHERE owner_id = $1", [owner.id]);
  assert.equal(count.rows[0]?.n, 1);
  assert.deepEqual(swQueue.getAllResult, [], "the replay drained the queue");
});

/** Browser cookie transport backed by the real HTTP app, with response interleaving hooks. */
function browserTransport(server: AppServer, owner: SeedUser): {
  requests: Array<{ path: string; method: string; expected: string | null; key: string | null; status: number }>;
  setAfterResponse: (hook: (request: Request, response: Response) => Promise<void>) => void;
  signIn: (user: SeedUser) => Promise<void>;
  restore: () => void;
} {
  const networkFetch = globalThis.fetch;
  const cookies = new Map([["session", authCookie(owner)]]);
  /** Current response hook runs after real HTTP responses arrive. */
  let afterResponse = async (_request: Request, _response: Response): Promise<void> => {};
  const transport = {
    requests: [] as Array<{ path: string; method: string; expected: string | null; key: string | null; status: number }>,
    /** Replace the interleaving hook synchronously, without reading an old transport snapshot. */
    setAfterResponse: (hook: typeof afterResponse): void => { afterResponse = hook; },
    /** Sign another tab in through the real password endpoint and update shared browser cookies. */
    signIn: async (user: SeedUser): Promise<void> => {
      const response = await networkFetch(server.url("/api/auth/login"), {
        method: "POST", headers: { cookie: cookies.get("session")!, "x-csrf-token": "pm-web-test-csrf", "content-type": "application/json" },
        body: JSON.stringify({ email: user.email, password: "synthetic-password" }),
      });
      assert.equal(response.status, 200);
      const session = response.headers.getSetCookie().find((value) => value.startsWith("pm_token="))?.split(";")[0];
      assert.ok(session);
      cookies.set("session", `${session}; csrf_token=pm-web-test-csrf`);
    },
    /** Restore the host transport after a test, including failing assertions. */
    restore: (): void => { globalThis.fetch = networkFetch; },
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(server.url(String(input)), init);
    const headers = new Headers(request.headers);
    headers.set("cookie", cookies.get("session")!);
    if (request.method !== "GET") headers.set("x-csrf-token", "pm-web-test-csrf");
    const response = await networkFetch(new Request(request, { headers }));
    transport.requests.push({ path: new URL(request.url).pathname, method: request.method,
      expected: headers.get("x-pm-expected-account"), key: headers.get("idempotency-key"), status: response.status });
    await afterResponse(request, response);
    return response;
  };
  return transport;
}

/** Start a real two-account browser session with worker identity and cleanup. */
async function setupAccountInterleaving(t: test.TestContext): Promise<{
  server: AppServer; owner: SeedUser; other: SeedUser;
  worker: ReturnType<typeof swQueueInternals>; browser: ReturnType<typeof browserTransport>;
}> {
  const { server, owner } = await setupOwnerAppTest(t);
  const other = await seedPasswordUser();
  const worker = swQueueInternals();
  await worker.saveSession?.(owner.id);
  const browser = browserTransport(server, owner);
  t.after(browser.restore);
  return { server, owner, other, worker, browser };
}

/** Dispatch a browser mutation through the actual worker fetch listener. */
async function submitGroup(server: AppServer): Promise<Response> {
  let response: Promise<Response> | undefined;
  swQueue.listeners.fetch({
    request: new Request(server.url("/api/groups"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "interleaved-work" }),
    }),
    respondWith: (result: Promise<Response>) => { response = result; },
  });
  assert.ok(response);
  return response;
}

test("failed first attempt keeps account A when tab B signs in before the failure", async (t) => {
  const { server, owner, other, worker, browser } = await setupAccountInterleaving(t);
  browser.setAfterResponse(async (request) => {
    if (request.method !== "POST") return;
    browser.setAfterResponse(async () => {});
    await browser.signIn(other);
    await worker.saveSession?.(other.id);
    throw new TypeError("response lost after account switch");
  });
  assert.equal((await submitGroup(server)).status, 202);
  const queued = swQueue.lastAdded as Record<string, unknown>;
  assert.equal(queued.ownerId, owner.id, "queue ownership is captured before the first attempt");
  swQueue.getAllResult = [{ ...queued, id: 1 }];
  await worker.flushMutationQueue();
  assert.equal(swQueue.getAllResult.length, 1, "B cannot drain A's work");
  const groups = await pool.query<{ owner_id: string }>("SELECT owner_id FROM pm_groups WHERE owner_id = ANY($1::uuid[])", [[owner.id, other.id]]);
  assert.deepEqual(groups.rows.map((row) => row.owner_id), [owner.id]);
});

test("replay refuses changed browser cookies without claiming a key and keeps account A's record", async (t) => {
  const { owner, other, worker, browser } = await setupAccountInterleaving(t);
  await worker.queueMutation("POST", "/groups", { name: "account-bound" });
  const queued = swQueue.lastAdded as Record<string, unknown>;
  swQueue.getAllResult = [{ ...queued, id: 2 }];
  browser.setAfterResponse(async (request) => {
    if (new URL(request.url).pathname !== "/api/auth/me") return;
    browser.setAfterResponse(async () => {});
    await browser.signIn(other);
  });
  await worker.flushMutationQueue();
  const replay = browser.requests.find((request) => request.method === "POST");
  assert.equal(replay?.status, 409);
  assert.equal(replay?.expected, owner.id);
  assert.equal(swQueue.getAllResult.length, 1);
  const counts = await pool.query<{ groups: number; keys: number }>(
    "SELECT (SELECT count(*)::int FROM pm_groups WHERE owner_id = ANY($1::uuid[])) AS groups, (SELECT count(*)::int FROM pm_idempotency_keys WHERE idempotency_key = $2) AS keys",
    [[owner.id, other.id], queued.idempotencyKey],
  );
  assert.deepEqual(counts.rows[0], { groups: 0, keys: 0 });
});

test("recovery approved by account A is refused after tab B signs in", async (t) => {
  const { owner, other, worker, browser } = await setupAccountInterleaving(t);
  swQueue.getAllResult = [{ id: 3, method: "POST", path: "/groups", body: JSON.stringify({ name: "legacy" }), timestamp: 0 }];
  swQueue.putValues.length = 0;
  await browser.signIn(other);
  await worker.saveSession?.(other.id);
  const pending: Promise<unknown>[] = [];
  swQueue.listeners.message({ data: { type: "REBIND_RECORDS", ids: [3], ownerId: owner.id },
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(swQueue.putValues.length, 0, "server session B cannot adopt work approved for A");
  assert.equal(swQueue.getAllResult.length, 1);
  assert.ok(!browser.requests.some((request) => request.method === "POST"));
});

test("overlapping recovery and flush preserve one key when tab B signs in during adoption", async (t) => {
  const { owner, other, worker, browser } = await setupAccountInterleaving(t);
  swQueue.getAllResult = [{ id: 4, method: "POST", path: "/groups", body: JSON.stringify({ name: "overlap" }), timestamp: 0 }];
  swQueue.putValues.length = 0;
  let switched = false;
  browser.setAfterResponse(async (request) => {
    if (switched || new URL(request.url).pathname !== "/api/auth/me") return;
    switched = true;
    await browser.signIn(other);
  });
  const pending: Promise<unknown>[] = [];
  for (let click = 0; click < 2; click++) {
    swQueue.listeners.message({ data: { type: "REBIND_RECORDS", ids: [4], ownerId: owner.id },
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } });
  }
  pending.push(worker.flushMutationQueue());
  await Promise.all(pending);
  assert.equal(swQueue.putValues.length, 1, "only one transaction assigns the key");
  const record = swQueue.getAllResult[0] as Record<string, unknown>;
  assert.equal(record.ownerId, owner.id);
  assert.equal(record.idempotencyKey, (swQueue.putValues[0] as Record<string, unknown>).idempotencyKey);
  assert.ok(browser.requests.every((request) => request.method !== "POST" || request.status === 409));
  const groups = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pm_groups WHERE owner_id = ANY($1::uuid[])", [[owner.id, other.id]]);
  assert.equal(groups.rows[0]?.n, 0);
});
