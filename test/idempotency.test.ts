/**
 * Real-Postgres, real-HTTP coverage for the server-side idempotency guard.
 *
 * Every mutating `/api` request that carries an `Idempotency-Key` header must
 * be applied exactly once per account: the first execution stores its outcome,
 * and any retry — including a retry after an ambiguous response the client
 * never saw — replays the stored outcome instead of re-executing. A key reused
 * for a different request is rejected, keys are scoped per account, and a
 * request without a key keeps the plain, non-deduplicated behaviour.
 *
 * The tests run against the real Express application (and, for response-shape
 * corner cases the shipped routes never produce, a minimal app that mounts the
 * same guard), the real `pg.Pool`, and real HTTP listeners, with no stubs of
 * the code under test: a wrong SQL statement or a missing ownership predicate
 * fails the assertion instead of being masked by a fake.
 */
import assert from "node:assert/strict";
import test from "node:test";
import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { createTierLimiters } from "../src/rate-limit.ts";

import { pool } from "../src/db.ts";
import { signToken } from "../src/auth.ts";
import { idempotencyGuard, requestFingerprint } from "../src/idempotency.ts";
import {
  RUN_ID,
  configureIdempotencyWait,
  authedFetch,
  ensureSchema,
  seedUser,
  seedPasswordUser,
  setupOwnerAppTest,
  type AppServer,
  type SeedUser,
} from "./helpers/pg-harness.ts";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";

/** A unique idempotency key, long enough to pass the length validation. */
function uniqueKey(label: string): string {
  return `key-${label}-${RUN_ID}-${Math.random().toString(36).slice(2)}`;
}

/** Fingerprint the real groups route payload used by pending-key fixtures. */
function groupsFingerprint(name: string): string {
  return requestFingerprint("POST", "/api/groups", { name });
}

/** Build an isolated HTTP probe with the real limiter, guard and PostgreSQL user. */
async function keyedProbe(): Promise<{ app: Express; owner: SeedUser }> {
  await ensureSchema();
  const owner = await seedUser();
  const app = express();
  app.use(express.json());
  app.use(createTierLimiters(process.env).write);
  app.use(idempotencyGuard());
  return { app, owner };
}

/** Count the groups one account owns — the side effect a retry must not double. */
async function groupCount(ownerId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pm_groups WHERE owner_id = $1",
    [ownerId],
  );
  return (result.rows[0] as { n: number }).n;
}

/** The stored idempotency rows for one (account, key) pair. */
async function keyRows(userId: string, key: string): Promise<
  Array<{ id: string; status_code: number | null; response_body: string | null }>
> {
  const result = await pool.query<{
    id: string;
    status_code: number | null;
    response_body: string | null;
  }>(
    "SELECT id, status_code, response_body FROM pm_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2",
    [userId, key],
  );
  return result.rows;
}

/** Seed a pending idempotency row, optionally backdated to simulate a crash. */
async function seedPendingKey(fields: {
  userId: string;
  key: string;
  fingerprint: string;
  ageMs?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO pm_idempotency_keys (user_id, idempotency_key, method, path, request_fingerprint, created_at)
     VALUES ($1, $2, 'POST', '/api/groups', $3, NOW() - ($4::double precision * interval '1 ms'))`,
    [fields.userId, fields.key, fields.fingerprint, fields.ageMs ?? 0],
  );
}

/** Resolve after `ms` milliseconds, for driving the guard's settle window. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Issue a cookie-authenticated POST /api/groups with an idempotency key. */
function keyedGroupPost(
  server: AppServer,
  user: SeedUser,
  key: string,
  name: string,
): Promise<Response> {
  return authedFetch(server, user, "/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ name }),
  });
}

/** Exercise live session changes and assert cookie headers survive repeated caller keys. */
async function assertLiveSessionChanges(server: AppServer, source: SeedUser, destination: SeedUser, key: string): Promise<void> {
  const login = await authedFetch(server, source, "/api/auth/login", {
    method: "POST", headers: { "idempotency-key": key, "content-type": "application/json" },
    body: JSON.stringify({ email: destination.email, password: "synthetic-password" }),
  });
  assert.equal(login.status, 200);
  assert.ok(login.headers.getSetCookie().some((value) => value.startsWith("pm_token=")));
  assert.equal(login.headers.get("idempotency-replayed"), null);
  const logout = await authedFetch(server, source, "/api/auth/logout", { method: "POST", headers: { "idempotency-key": key } });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie().some((value) => value.startsWith("pm_token=;")));
  assert.equal(logout.headers.get("idempotency-replayed"), null);
}

test("a retried mutation with the same idempotency key is applied exactly once and replays the stored response", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("retry");
  const name = `group-${RUN_ID}-retry`;

  const first = await keyedGroupPost(server, owner, key, name);
  assert.equal(first.status, 201, "the original request creates the group");
  assert.equal(first.headers.get("idempotency-replayed"), null, "the first execution is not a replay");
  const firstBody = (await first.json()) as { group: { id: string } };

  // The client never saw that response (lost connection after the commit);
  // from the server's perspective an unread response and a lost one are the
  // same thing, so it retries the identical request with the identical key.
  const retry = await keyedGroupPost(server, owner, key, name);
  assert.equal(retry.status, 201, "the retry succeeds");
  assert.deepEqual(await retry.json(), firstBody, "the retry replays the stored response body");
  assert.equal(retry.headers.get("idempotency-replayed"), "true", "the retry is marked as replayed");

  assert.equal(await groupCount(owner.id), 1, "the mutation was applied exactly once");
  const rows = await keyRows(owner.id, key);
  assert.equal(rows.length, 1, "exactly one record exists for the key");
  assert.equal((rows[0] as { status_code: number | null }).status_code, 201);
});

test("a key reused for a different request is rejected, not silently deduplicated", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("reuse");
  const firstName = `group-${RUN_ID}-first`;

  const first = await keyedGroupPost(server, owner, key, firstName);
  assert.equal(first.status, 201);
  const firstGroup = await first.json() as { group: { id: string } };

  // Same key, different body: must not be treated as a retry of the first.
  const otherBody = await keyedGroupPost(server, owner, key, `group-${RUN_ID}-second`);
  assert.equal(otherBody.status, 422, "a key reused for a different body is rejected");
  assert.equal(await groupCount(owner.id), 1, "the rejected request created nothing");

  // Same key, different route and method: also a different request.
  const otherPath = await authedFetch(server, owner, `/api/groups/${firstGroup.group.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ name: "Someone Else" }),
  });
  assert.equal(otherPath.status, 422, "a key reused on a different route is rejected");
});

test("idempotency keys are scoped per account", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const other = await seedUser();
  const key = uniqueKey("scoped");
  const ownerName = `group-${RUN_ID}-owner`;
  const otherName = `group-${RUN_ID}-other`;

  const asOwner = await keyedGroupPost(server, owner, key, ownerName);
  assert.equal(asOwner.status, 201);
  // A second account sending the same key is a different request stream: the
  // key must not silently swallow the second account's mutation.
  const asOther = await keyedGroupPost(server, other, key, otherName);
  assert.equal(asOther.status, 201, "the other account's request is applied, not replayed");
  assert.equal(asOther.headers.get("idempotency-replayed"), null);

  assert.equal(await groupCount(owner.id), 1);
  assert.equal(await groupCount(other.id), 1);
  assert.equal((await keyRows(owner.id, key)).length, 1);
  assert.equal((await keyRows(other.id, key)).length, 1, "each account has its own record");
});

test("requests without an idempotency key keep the plain non-deduplicated behaviour", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const name = `group-${RUN_ID}-plain`;

  const first = await authedFetch(server, owner, "/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(first.status, 201);
  const second = await authedFetch(server, owner, "/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  // Without a key there is nothing to deduplicate against, so the identical
  // request executes a second time — exactly the double-application the
  // keyed retry above is protected from.
  assert.equal(second.status, 201, "without a key the duplicate executes again");
  assert.equal(second.headers.get("idempotency-replayed"), null);
  assert.equal(await groupCount(owner.id), 2, "both executions applied");
});

test("a malformed idempotency key is rejected without touching the store", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);

  const tooShort = await keyedGroupPost(server, owner, "short", `group-${RUN_ID}-s`);
  assert.equal(tooShort.status, 400, "a too-short key is rejected");
  assert.equal(await keyRows(owner.id, "short").then((rows) => rows.length), 0);

  const tooLong = await keyedGroupPost(
    server,
    owner,
    "x".repeat(201),
    `group-${RUN_ID}-l`,
  );
  assert.equal(tooLong.status, 400, "a too-long key is rejected");
});

test("unauthenticated or invalid sessions with a key are not recorded", async (t) => {
  const { server } = await setupOwnerAppTest(t);
  const key = uniqueKey("unauth");

  const anonymous = await fetch(server.url("/api/groups"), {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ name: "nope" }),
  });
  assert.equal(anonymous.status, 401, "the route still enforces authentication");

  const forged = await fetch(server.url("/api/groups"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      authorization: "Bearer not-a-real-token",
    },
    body: JSON.stringify({ name: "nope" }),
  });
  assert.equal(forged.status, 401, "an invalid session is still refused by the route");

  const rows = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pm_idempotency_keys WHERE idempotency_key = $1",
    [key],
  );
  assert.equal((rows.rows[0] as { n: number }).n, 0, "nothing was recorded");
});

test("a safe request carrying a key passes through untouched", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("safe");

  const read = await authedFetch(server, owner, "/api/groups", {
    headers: { "idempotency-key": key },
  });
  assert.equal(read.status, 200, "the read is served normally");
  assert.equal(
    (await keyRows(owner.id, key)).length,
    0,
    "safe methods are never recorded against a key",
  );
});

test("parallel requests from several accounts apply each account's mutation exactly once", async (t) => {
  const { server } = await setupOwnerAppTest(t);
  await ensureSchema();
  const accounts = [await seedUser(), await seedUser(), await seedUser(), await seedUser()];

  // Every account fires the same keyed mutation five times, concurrently.
  const responses = await Promise.all(
    accounts.flatMap((account, accountIndex) =>
      Array.from({ length: 5 }, () =>
        keyedGroupPost(
          server,
          account,
          `key-concurrent-${RUN_ID}-${accountIndex}`,
          `group-${RUN_ID}-c${accountIndex}`,
        ),
      ),
    ),
  );

  for (const [accountIndex, account] of accounts.entries()) {
    const own = responses.slice(accountIndex * 5, accountIndex * 5 + 5);
    for (const response of own) {
      assert.equal(response.status, 201, "every concurrent duplicate succeeds");
    }
    const bodies = await Promise.all(own.map((response) => response.json()));
    for (const body of bodies.slice(1)) {
      assert.deepEqual(body, bodies[0], "every duplicate replays the same stored response");
    }
    assert.equal(
      own.filter((response) => response.headers.get("idempotency-replayed") === "true").length,
      4,
      "exactly one execution and four replays per account",
    );
    assert.equal(await groupCount(account.id), 1, "each account's mutation was applied exactly once");
  }
});

test("a committed mutation with a stale pending key returns outcome unknown without re-execution", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("takeover");
  const name = `group-${RUN_ID}-takeover`;
  // A previous execution inserted its intent and died before responding.
  await seedPendingKey({
    userId: owner.id,
    key,
    fingerprint: groupsFingerprint(name),
    ageMs: 10 * 60 * 1000,
  });

  await pool.query("INSERT INTO pm_groups (name, owner_id) VALUES ($1, $2)", [name, owner.id]);
  const response = await keyedGroupPost(server, owner, key, name);
  assert.equal(response.status, 409);
  assert.match(JSON.stringify(await response.json()), /outcome unknown/i);
  assert.equal(response.headers.get("idempotency-replayed"), "true", "stale ambiguity becomes a stored terminal outcome");
  assert.equal(await groupCount(owner.id), 1);
});

test("a duplicate of an in-flight request waits and replays the stored outcome", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("inflight");
  const name = `group-${RUN_ID}-inflight`;
  // Another execution holds the key right now (pending, fresh).
  await seedPendingKey({ userId: owner.id, key, fingerprint: groupsFingerprint(name) });

  const pending = keyedGroupPost(server, owner, key, name);
  // The holder finishes while the duplicate is waiting.
  await sleep(200);
  await pool.query(
    `UPDATE pm_idempotency_keys
     SET status_code = 201, response_body = $3, updated_at = NOW()
     WHERE user_id = $1 AND idempotency_key = $2`,
    [owner.id, key, JSON.stringify({ group: { id: "stored", name } })],
  );
  const response = await pending;

  assert.equal(response.status, 201);
  assert.deepEqual(
    await response.json(),
    { group: { id: "stored", name } },
    "the waiting duplicate replays the holder's stored outcome",
  );
  assert.equal(response.headers.get("idempotency-replayed"), "true");
  assert.equal(await groupCount(owner.id), 0, "the waiting duplicate executed nothing");
});

test("a key recycled to a different request while a duplicate waits is rejected", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("recycled");
  const name = `group-${RUN_ID}-recycled`;
  await seedPendingKey({ userId: owner.id, key, fingerprint: groupsFingerprint(name) });

  const pending = keyedGroupPost(server, owner, key, name);
  await sleep(200);
  // The pending record is replaced by a completed record for a different
  // request: the waiting duplicate must not be answered with it.
  await pool.query(
    `DELETE FROM pm_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2`,
    [owner.id, key],
  );
  await pool.query(
    `INSERT INTO pm_idempotency_keys (user_id, idempotency_key, method, path, request_fingerprint, status_code, response_body)
     VALUES ($1, $2, 'POST', '/api/groups', $3, 201, '{}')`,
    [owner.id, key, requestFingerprint("POST", "/api/groups", { name: "someone-elses-body" })],
  );
  const response = await pending;

  assert.equal(response.status, 422, "the recycled key is not answered with a foreign outcome");
});

test("a pending execution that never settles refuses the duplicate at the deadline", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("unsettled");
  const name = `group-${RUN_ID}-unsettled`;
  await seedPendingKey({ userId: owner.id, key, fingerprint: groupsFingerprint(name) });

  const previousWait = process.env.PM_WEB_IDEMPOTENCY_WAIT_MS;
  process.env.PM_WEB_IDEMPOTENCY_WAIT_MS = "150";
  t.after(() => {
    if (previousWait === undefined) delete process.env.PM_WEB_IDEMPOTENCY_WAIT_MS;
    else process.env.PM_WEB_IDEMPOTENCY_WAIT_MS = previousWait;
  });

  const response = await keyedGroupPost(server, owner, key, name);
  assert.equal(response.status, 409, "an unsettled duplicate is refused, not executed");
  assert.equal((await response.json() as { code: string }).code, "PM_IDEMPOTENCY_IN_FLIGHT");
  assert.equal(await groupCount(owner.id), 0, "nothing was applied");
});

test("an ambiguous 5xx after a commit never permits re-execution", async (t) => {
  const { app, owner } = await keyedProbe();
  let attempts = 0;
  app.post("/flaky", async (_req, res) => {
    attempts += 1;
    await pool.query("INSERT INTO pm_groups (name, owner_id) VALUES ($1, $2)", ["ambiguous", owner.id]);
    if (attempts === 1) {
      res.status(500).json({ error: "boom" });
      return;
    }
    res.status(200).json({ attempts });
  });
  const handle = await startEphemeralServer(app);
  t.after(() => handle.close());

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${signToken({ userId: owner.id, email: owner.email })}`,
    "idempotency-key": uniqueKey("flaky"),
  };
  const failure = await fetch(handle.url("/flaky"), { method: "POST", headers, body: "{}" });
  assert.equal(failure.status, 500, "the first attempt fails");

  configureIdempotencyWait(t, 50);
  const retry = await fetch(handle.url("/flaky"), { method: "POST", headers, body: "{}" });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json() as { code: string }).code, "PM_IDEMPOTENCY_OUTCOME_UNKNOWN");
  const state = await pool.query<{ outcome_state: string; status_code: number }>(
    "SELECT outcome_state, status_code FROM pm_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2",
    [owner.id, headers["idempotency-key"]],
  );
  assert.deepEqual(state.rows[0], { outcome_state: "outcome_unknown", status_code: 409 });
  assert.equal(attempts, 1, "an ambiguous failure retains its intent");
  assert.equal(await groupCount(owner.id), 1, "the committed mutation is not repeated");
});

test("a proven pre-commit PostgreSQL rollback releases the key and retry succeeds exactly once", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("pre-commit");
  const trigger = `pre_commit_${RUN_ID}`;
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.user_id = '${owner.id}' THEN RAISE EXCEPTION 'synthetic pre-commit failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON pm_group_members FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  t.after(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON pm_group_members`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
  });
  configureIdempotencyWait(t, 100);
  assert.equal((await keyedGroupPost(server, owner, key, "rollback-safe")).status, 500);
  assert.equal(await groupCount(owner.id), 0, "the inserted group rolled back with its failed member write");
  await pool.query(`DROP TRIGGER ${trigger} ON pm_group_members`);
  const retry = await keyedGroupPost(server, owner, key, "rollback-safe");
  assert.equal(retry.status, 201, "the same key may retry after a proven rollback");
  assert.equal((await keyedGroupPost(server, owner, key, "rollback-safe")).status, 201);
  assert.equal(await groupCount(owner.id), 1, "only the successful retry committed");
});

test("a response with no body and a plain-text response are replayed with their shape", async (t) => {
  const { app, owner } = await keyedProbe();
  app.post("/no-content", (_req, res) => {
    res.status(204).end();
  });
  app.post("/text", (_req, res) => {
    res.send("plain outcome");
  });
  const handle = await startEphemeralServer(app);
  t.after(() => handle.close());

  const auth = `Bearer ${signToken({ userId: owner.id, email: owner.email })}`;
  const noContentKey = uniqueKey("nocontent");
  const first = await fetch(handle.url("/no-content"), {
    method: "POST",
    headers: { authorization: auth, "idempotency-key": noContentKey },
  });
  assert.equal(first.status, 204);
  const replayedNoContent = await fetch(handle.url("/no-content"), {
    method: "POST",
    headers: { authorization: auth, "idempotency-key": noContentKey },
  });
  assert.equal(replayedNoContent.status, 204, "the status without a body is replayed");
  assert.equal(replayedNoContent.headers.get("idempotency-replayed"), "true");

  const textKey = uniqueKey("text");
  const text = await fetch(handle.url("/text"), {
    method: "POST",
    headers: { authorization: auth, "idempotency-key": textKey },
  });
  assert.equal(await text.text(), "plain outcome");
  const replayedText = await fetch(handle.url("/text"), {
    method: "POST",
    headers: { authorization: auth, "idempotency-key": textKey },
  });
  assert.equal(await replayedText.text(), "plain outcome", "a non-JSON body is replayed");
  assert.equal(replayedText.headers.get("idempotency-replayed"), "true");
});

test("idempotency records older than the retention window are cleaned up", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const oldKey = uniqueKey("old");
  const freshKey = uniqueKey("fresh");
  const oldName = `group-${RUN_ID}-old`;

  // A completed record from long before the retention window.
  const first = await keyedGroupPost(server, owner, oldKey, oldName);
  assert.equal(first.status, 201);
  // The guard persists the outcome on the response's `finish` event, after the
  // client already holds its 201. Backdating before that write lands would be
  // overwritten by the settlement's `updated_at = NOW()`, so wait for it first.
  for (let attempt = 0; ((await keyRows(owner.id, oldKey))[0]?.status_code ?? null) === null; attempt++) {
    assert.ok(attempt < 100, "the completed request settles its idempotency record");
    await sleep(20);
  }
  const backdated = await pool.query(
    `UPDATE pm_idempotency_keys
     SET created_at = NOW() - (30::double precision * interval '1 day'), updated_at = NOW() - interval '30 days'
     WHERE user_id = $1 AND idempotency_key = $2 AND status_code IS NOT NULL`,
    [owner.id, oldKey],
  );
  assert.equal(backdated.rowCount, 1, "the settled record is backdated");

  // A second execution in the same middleware instance does not sweep again.
  const fresh = await keyedGroupPost(server, owner, freshKey, `group-${RUN_ID}-fresh`);
  assert.equal(fresh.status, 201);

  assert.equal((await keyRows(owner.id, oldKey)).length, 1, "hot-path sweeps are throttled");
  const pendingKey = uniqueKey("retained-pending");
  await seedPendingKey({ userId: owner.id, key: pendingKey, fingerprint: groupsFingerprint("pending"), ageMs: 30 * 86400000 });
  const newServer = await startEphemeralServer(createApp());
  t.after(() => newServer.close());
  await keyedGroupPost(newServer, owner, uniqueKey("sweep"), "sweep");
  assert.equal((await keyRows(owner.id, oldKey)).length, 0, "a new instance sweeps completed expired records");
  const unknown = await pool.query<{ outcome_state: string; status_code: number }>(
    "SELECT outcome_state, status_code FROM pm_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2", [owner.id, pendingKey],
  );
  assert.deepEqual(unknown.rows[0], { outcome_state: "outcome_unknown", status_code: 409 }, "stale pending rows settle before retention starts");
  assert.equal((await keyRows(owner.id, freshKey)).length, 1, "the fresh record remains");
  await pool.query("UPDATE pm_idempotency_keys SET updated_at = NOW() - interval '30 days' WHERE user_id = $1 AND idempotency_key = $2", [owner.id, pendingKey]);
  const sweepServer = await startEphemeralServer(createApp());
  t.after(() => sweepServer.close());
  await keyedGroupPost(sweepServer, owner, uniqueKey("sweep-unknown"), "sweep-unknown");
  assert.deepEqual(await keyRows(owner.id, pendingKey), [], "terminal unknown outcomes are eligible for retention sweep");
});

test("an unknown token account bypasses keying and gets the route's normal outcome", async (t) => {
  const { server } = await setupOwnerAppTest(t);
  // A verified token with no usable account bypasses keying; the normal route
  // outcome must not be replaced by an idempotency insert failure.
  const forged = await fetch(server.url("/api/groups"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": uniqueKey("broken"),
      authorization: `Bearer ${signToken({ userId: "not-a-uuid", email: "nobody@e.test" })}`,
    },
    body: JSON.stringify({ name: "nope" }),
  });
  assert.equal(forged.status, 500);
  assert.deepEqual(await forged.json(), { error: "Failed to create group" }, "the route receives the unknown account");
});

test("SQL bootstrap and runtime idempotency definitions agree and both sweep ages are indexed", async () => {
  await ensureSchema();
  const sql = readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const table = /CREATE TABLE IF NOT EXISTS pm_idempotency_keys \([\s\S]*?\);/;
  assert.equal(sql.match(table)?.[0].replace(/\s+/g, " "), runtime.match(table)?.[0].replace(/\s+/g, " "));
  const indexPattern = /CREATE INDEX IF NOT EXISTS idx_pm_idempotency_\w+ ON pm_idempotency_keys \(\w+\) WHERE status_code IS (?:NOT )?NULL/g;
  assert.deepEqual(sql.match(indexPattern)?.sort(), runtime.match(indexPattern)?.sort(), "every partial sweep index is identical in both setup paths");
  const indexes = await pool.query<{ indexname: string; indexdef: string }>("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'pm_idempotency_keys'");
  assert.match(indexes.rows.find((row) => row.indexname === "idx_pm_idempotency_pending_at")?.indexdef ?? "", /\(created_at\) WHERE \(status_code IS NULL\)/);
  assert.match(indexes.rows.find((row) => row.indexname === "idx_pm_idempotency_settled_at")?.indexdef ?? "", /\(updated_at\) WHERE \(status_code IS NOT NULL\)/);
});

test("PostgreSQL can serve each real idempotency sweep query with its partial age index", async () => {
  await ensureSchema();
  const source = readFileSync(new URL("../src/idempotency.ts", import.meta.url), "utf8");
  const sweep = source.match(/async function deleteExpiredKeys\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(sweep);
  const queries = [...sweep.matchAll(/`([\s\S]*?)`/g)].map((match) => match[1]);
  assert.equal(queries.length, 2, "check the actual pending UPDATE and settled DELETE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    for (const [index, query] of queries.entries()) {
      const result = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query}`, index === 0 ? [300_000, "{}"] : [604_800_000]);
      const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
      const expected = index === 0 ? "idx_pm_idempotency_pending_at" : "idx_pm_idempotency_settled_at";
      assert.ok(plan.includes(expected), `${expected} must serve the sweep: ${plan}`);
      assert.doesNotMatch(plan, /Seq Scan/);
      assert.match(plan, /Index Cond:.*(?:created_at|updated_at) </, "age cutoff is an index condition");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("transient 425 and 429 refusals are not stored and the identical key can retry", async (t) => {
  for (const status of [425, 429]) {
    const { app, owner } = await keyedProbe();
    let attempts = 0;
    app.post("/refusal", (_req, res) => {
      attempts += 1;
      res.status(attempts === 1 ? status : 200).json({ attempts });
    });
    const server = await startEphemeralServer(app);
    t.after(() => server.close());
    const headers = { authorization: `Bearer ${signToken({ userId: owner.id, email: owner.email })}`, "idempotency-key": uniqueKey("transient") };
    const first = await fetch(server.url("/refusal"), { method: "POST", headers });
    assert.equal(first.status, status);
    const retry = await fetch(server.url("/refusal"), { method: "POST", headers });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { attempts: 2 });
  }
});

test("production rate limiting precedes keyed replays and refusals never claim a key", async (t) => {
  const previous = process.env.PM_WEB_RATE_LIMIT_WRITE;
  process.env.PM_WEB_RATE_LIMIT_WRITE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PM_WEB_RATE_LIMIT_WRITE;
    else process.env.PM_WEB_RATE_LIMIT_WRITE = previous;
  });
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("limited");
  assert.equal((await keyedGroupPost(server, owner, key, "limited")).status, 201);
  assert.equal((await keyedGroupPost(server, owner, key, "limited")).status, 429, "replays also consume the abuse budget");
  const refusedKey = uniqueKey("not-claimed");
  assert.equal((await keyedGroupPost(server, owner, refusedKey, "refused")).status, 429);
  assert.equal((await keyRows(owner.id, refusedKey)).length, 0);
});


test("a PostgreSQL outcome-write failure is caught and leaves a pending intent", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("persist-failure");
  const trigger = `outcome_failure_${RUN_ID}`;
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.idempotency_key = '${key}' THEN RAISE EXCEPTION 'synthetic outcome storage outage'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON pm_idempotency_keys FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  t.after(async () => {
    await pool.query(`DROP TRIGGER ${trigger} ON pm_idempotency_keys`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
  });
  const previousWait = process.env.PM_WEB_IDEMPOTENCY_WAIT_MS;
  process.env.PM_WEB_IDEMPOTENCY_WAIT_MS = "100";
  t.after(() => {
    if (previousWait === undefined) delete process.env.PM_WEB_IDEMPOTENCY_WAIT_MS;
    else process.env.PM_WEB_IDEMPOTENCY_WAIT_MS = previousWait;
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  t.after(() => { console.error = originalError; });
  assert.equal((await keyedGroupPost(server, owner, key, "outage")).status, 201);
  assert.equal((await keyedGroupPost(server, owner, key, "outage")).status, 409);
  assert.equal(await groupCount(owner.id), 1);
  assert.ok(errors.some((entry) => String(entry[0]).includes("persist idempotency outcome")), "persistence failure is recorded");
});

test("expected account mismatches are refused before execution or key claims, even without a key", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const other = await seedUser();
  const key = uniqueKey("expected-account");
  for (const keyed of [true, false]) {
    const response = await authedFetch(server, other, "/api/groups", {
      method: "POST", headers: { "content-type": "application/json", "x-pm-expected-account": owner.id,
        ...(keyed ? { "idempotency-key": key } : {}) }, body: JSON.stringify({ name: "refused" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "PM_EXPECTED_ACCOUNT_MISMATCH");
  }
  const approval = await authedFetch(server, other, "/api/auth/me", { headers: { "x-pm-expected-account": owner.id } });
  assert.equal(approval.status, 409, "server refuses recovery approval for a different session");
  assert.equal(await groupCount(other.id), 0);
  assert.deepEqual(await keyRows(other.id, key), []);
  assert.deepEqual(await keyRows(owner.id, key), []);
});

test("keyed login and repeated logout always deliver live cookie changes", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const other = await seedPasswordUser();
  const key = uniqueKey("auth-cookie");
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertLiveSessionChanges(server, owner, other, key);
  }
  assert.deepEqual(await keyRows(owner.id, key), []);
  assert.deepEqual(await keyRows(other.id, key), []);
});

test("deleted-user tokens bypass keying while login and logout remain usable", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const other = await seedPasswordUser();
  await pool.query("DELETE FROM pm_users WHERE id = $1", [owner.id]);
  const key = uniqueKey("deleted-token");
  const plain = await authedFetch(server, owner, `/api/groups/${other.id}`, { method: "DELETE" });
  const keyed = await authedFetch(server, owner, `/api/groups/${other.id}`, { method: "DELETE", headers: { "idempotency-key": key } });
  assert.equal(keyed.status, plain.status);
  assert.deepEqual(await keyed.json(), await plain.json());
  await assertLiveSessionChanges(server, owner, other, key);
  assert.deepEqual(await keyRows(owner.id, key), []);
});

test("a real retention cleanup failure leaves no pending claim and the same key can retry", async (t) => {
  const { server, owner } = await setupOwnerAppTest(t);
  const key = uniqueKey("cleanup-retry");
  const backend = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const trigger = `cleanup_failure_${RUN_ID}`;
  // A statement trigger fails this pool connection's sweep even when another
  // test swept all expired rows first; other test processes are unaffected.
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF pg_backend_pid() = ${backend.rows[0]!.pid} THEN RAISE EXCEPTION 'synthetic retention outage'; END IF; RETURN NULL; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON pm_idempotency_keys FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}()`);
  t.after(async () => {
    await pool.query(`DROP TRIGGER ${trigger} ON pm_idempotency_keys`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
  });
  const first = await keyedGroupPost(server, owner, key, "cleanup-safe");
  assert.equal(first.status, 500);
  assert.deepEqual(await keyRows(owner.id, key), [], "cleanup failed before any intent was claimed");
  assert.equal(await groupCount(owner.id), 0);
  const retry = await keyedGroupPost(server, owner, key, "cleanup-safe");
  assert.equal(retry.status, 201);
  assert.equal((await keyedGroupPost(server, owner, key, "cleanup-safe")).status, 201);
  assert.equal(await groupCount(owner.id), 1);
});
