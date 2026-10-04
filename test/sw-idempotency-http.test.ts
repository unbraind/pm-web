/** Real HTTP response loss after a PostgreSQL commit exercises worker queue replay. */
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { swQueue, swQueueInternals } from "./helpers/sw-queue-preload.ts";
import "../public/src/sw.ts";
import { setupOwnerAppTest } from "./helpers/pg-harness.ts";
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
      headers: { authorization: auth, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
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
