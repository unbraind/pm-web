/** Real HTTP response loss after a PostgreSQL commit exercises worker queue replay. */
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { swQueue, swQueueInternals } from "./helpers/sw-queue-preload.ts";
import "../public/src/sw.ts";
import { authCookie, configureIdempotencyWait, ensureSchema, RUN_ID, seedPasswordUser, seedUser, setupOwnerAppTest, type AppServer, type SeedUser } from "./helpers/pg-harness.ts";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";
import { createTierLimiters } from "../src/rate-limit.ts";
import { signToken } from "../src/auth.ts";
import { pool } from "../src/db.ts";
import { idempotencyGuard } from "../src/idempotency.ts";
import { groupsRouter } from "../src/routes/groups.ts";

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

/** Serve real keyed mutations and account bootstrap for workspace recovery tests. */
async function setupWorkspaceRecovery(t: test.TestContext): Promise<{
  owner: SeedUser; worker: ReturnType<typeof swQueueInternals>; browser: ReturnType<typeof browserTransport>;
}> {
  await ensureSchema();
  const owner = await seedUser();
  configureIdempotencyWait(t, 50);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(idempotencyGuard());
  app.get("/api/auth/me", (_req, res) => {
    res.setHeader("x-csrf-token", "pm-web-test-csrf");
    res.json({ user: { id: owner.id } });
  });
  app.use("/api/projects/:workspace/groups", groupsRouter);
  let ambiguousAttempts = 0;
  app.post("/api/projects/:workspace/mutate", async (req, res) => {
    const name = (req.body as { name: string }).name;
    await pool.query("INSERT INTO pm_groups (name, owner_id) VALUES ($1, $2)", [name, owner.id]);
    if (name === "ambiguous") ambiguousAttempts++;
    res.status(name === "ambiguous" && ambiguousAttempts === 1 ? 500 : 201).json({ name });
  });
  const server = await startEphemeralServer(app);
  t.after(() => server.close());
  const browser = browserTransport(server, owner);
  t.after(browser.restore);
  const worker = swQueueInternals();
  await worker.saveSession?.(owner.id);
  swQueue.getAllResult = [];
  swQueue.postedMessages.length = 0;
  return { owner, worker, browser };
}

/** Queue independent workspaces and retain the durable records accepted by the worker. */
async function queueWorkspaceRecords(worker: ReturnType<typeof swQueueInternals>, route: string, first: string): Promise<void> {
  for (const [id, workspace, name] of [[1, "a", first], [2, "a", "after-a"], [3, "b", "other-b"]] as const) {
    await worker.queueMutation("POST", `/projects/${workspace}/${route}`, { name });
    swQueue.getAllResult.push({ ...(swQueue.lastAdded as object), id });
  }
}

/** Send an explicit recovery approval through the actual worker message listener. */
async function recoverRecord(ownerId: string, action: string, id = 1): Promise<void> {
  const pending: Promise<unknown>[] = [];
  swQueue.listeners.message({ data: { type: "RECOVER_RECORD", action, id, ownerId },
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } });
  await Promise.all(pending);
}

test("ambiguous HTTP failure needs attention, isolates workspace ordering, and confirmed retry-as-new executes once", async (t) => {
  const { owner, worker, browser } = await setupWorkspaceRecovery(t);
  await queueWorkspaceRecords(worker, "mutate", "ambiguous");
  const originalKey = (swQueue.getAllResult[0] as { idempotencyKey: string }).idempotencyKey;
  await worker.flushMutationQueue();
  await worker.flushMutationQueue();
  const first = swQueue.getAllResult[0] as { state: string; attentionReason: string };
  assert.equal(first.state, "needs-attention");
  assert.equal(first.attentionReason, "outcome-unknown");
  assert.deepEqual(swQueue.getAllResult.map((value) => (value as { id: number }).id), [1, 2]);
  assert.ok(browser.requests.some((request) => request.path.includes("/b/") && request.status === 201));
  assert.ok(!browser.requests.some((request) => request.path.includes("/a/") && request.key !== originalKey));
  const before = browser.requests.length;
  await worker.flushMutationQueue();
  assert.equal(browser.requests.slice(before).filter((request) => request.method === "POST").length, 0, "unknown work is never replayed automatically");
  await recoverRecord(owner.id, "retry-new");
  const retry = browser.requests.find((request) => request.path.includes("/a/") && request.method === "POST" && request.status === 201);
  assert.ok(retry);
  assert.notEqual(retry.key, originalKey, "user approval assigned a fresh key");
  await worker.flushMutationQueue();
  await worker.flushMutationQueue();
  const writes = await pool.query<{ name: string; n: number }>(
    "SELECT name, count(*)::int AS n FROM pm_groups WHERE owner_id = $1 GROUP BY name", [owner.id],
  );
  assert.equal(writes.rows.find((row) => row.name === "ambiguous")?.n, 2, "one original commit plus one approved new request");
  assert.deepEqual(swQueue.getAllResult, [], "successful approved retry unblocks later work in the same workspace");
  assert.equal(browser.requests.filter((request) => request.method === "POST" && request.key === retry.key).length, 1);
  const ordered = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pm_groups WHERE owner_id = $1 AND name = 'after-a'", [owner.id]);
  assert.equal(ordered.rows[0]?.n, 1);
});

test("repeated pre-commit HTTP 5xx needs attention without starving other workspaces", async (t) => {
  const { owner, worker, browser } = await setupWorkspaceRecovery(t);
  const trigger = `worker_failure_${RUN_ID}`;
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.owner_id = '${owner.id}' AND NEW.name = 'repeated-5xx' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON pm_groups FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  t.after(async () => {
    await pool.query(`DROP TRIGGER ${trigger} ON pm_groups`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
  });
  await queueWorkspaceRecords(worker, "groups", "repeated-5xx");
  for (let attempt = 0; attempt < 3; attempt++) await worker.flushMutationQueue();
  const first = swQueue.getAllResult[0] as { state: string; attentionReason: string };
  assert.equal(first.state, "needs-attention");
  assert.equal(first.attentionReason, "repeated-5xx");
  assert.equal(browser.requests.filter((request) => request.method === "POST" && request.status === 500).length, 3);
  assert.equal(browser.requests.filter((request) => request.path.includes("/b/") && request.status === 201).length, 1);
  const before = browser.requests.length;
  await worker.flushMutationQueue();
  assert.equal(browser.requests.slice(before).filter((request) => request.method === "POST").length, 0);
  await recoverRecord("different-account", "discard");
  assert.equal(swQueue.getAllResult.length, 2, "another account cannot discard owned work");
  await recoverRecord(owner.id, "discard");
  assert.deepEqual(swQueue.getAllResult, []);
});

test("pre-commit HTTP failure retries the same worker key once and preserves workspace FIFO", async (t) => {
  const { owner, worker, browser } = await setupWorkspaceRecovery(t);
  const trigger = `worker_once_${RUN_ID}`;
  await pool.query(`CREATE SEQUENCE ${trigger}`);
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.user_id = '${owner.id}' AND nextval('${trigger}') = 1 THEN RAISE EXCEPTION 'synthetic one-time rollback'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON pm_group_members FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  t.after(async () => {
    await pool.query(`DROP TRIGGER ${trigger} ON pm_group_members`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
    await pool.query(`DROP SEQUENCE ${trigger}`);
  });
  await queueWorkspaceRecords(worker, "groups", "one-time-rollback");
  const key = (swQueue.getAllResult[0] as { idempotencyKey: string }).idempotencyKey;
  await worker.flushMutationQueue();
  assert.deepEqual(swQueue.getAllResult.map((value) => (value as { id: number }).id), [1, 2]);
  await worker.flushMutationQueue();
  await worker.flushMutationQueue();
  assert.deepEqual(swQueue.getAllResult, []);
  assert.deepEqual(browser.requests.filter((request) => request.key === key).map((request) => request.status), [500, 201]);
  const groups = await pool.query<{ name: string }>("SELECT name FROM pm_groups WHERE owner_id = $1 ORDER BY created_at", [owner.id]);
  assert.deepEqual(groups.rows.map((row) => row.name), ["other-b", "one-time-rollback", "after-a"]);
});

test("account-level records cannot overtake unresolved workspace work or let later workspaces overtake them", async (t) => {
  const { owner, worker, browser } = await setupWorkspaceRecovery(t);
  for (const [id, path, name] of [[1, "/projects/a/mutate", "ambiguous"], [2, "/groups", "barrier"], [3, "/projects/b/mutate", "later-b"]] as const) {
    await worker.queueMutation("POST", path, { name });
    swQueue.getAllResult.push({ ...(swQueue.lastAdded as object), id });
  }
  await worker.flushMutationQueue();
  await worker.flushMutationQueue();
  assert.ok(browser.requests.filter((request) => request.method === "POST").every((request) => request.path === "/api/projects/a/mutate"));
  const blocked = [...swQueue.postedMessages].reverse().find((message) => message.type === "MUTATIONS_BLOCKED")?.blocked as Array<{ id: number; reason: string }>;
  assert.deepEqual(blocked.map(({ id, reason }) => ({ id, reason })), [
    { id: 1, reason: "outcome-unknown" }, { id: 2, reason: "workspace-order" }, { id: 3, reason: "workspace-order" },
  ]);
  await recoverRecord(owner.id, "discard");
  // The probe intentionally has no account-level route: its 404 is a normal failure and keeps the barrier.
  assert.ok(!browser.requests.some((request) => request.path.includes("/b/") && request.method === "POST"));
});
