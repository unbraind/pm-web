/** Real HTTP requests exercise queue overload, cancellation and readiness alongside held joins. */
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createSSEAdmission } from "../src/services/sse-admission.ts";
import { waitUntil } from "../scripts/capacity-wait.ts";

test("join admission bounds active work and backlog, cancels queued sockets, and leaves readiness responsive", { timeout: 30_000 }, async () => {
  for (const bounds of [[0, 1], [1, 0], [1.5, 1], [1, 1.5]]) assert.throws(() => createSSEAdmission(bounds[0], bounds[1]), /positive integers/);
  const admit = createSSEAdmission(2, 2);
  const app = express();
  let active = 0, peak = 0, received = 0, canceled = false;
  let finish: () => void = () => {};
  const held = new Promise<void>((resolve) => { finish = resolve; });
  app.get("/events", async (req, res) => {
    received++;
    if (req.query.slot === "3") res.once("close", () => { canceled = true; });
    const release = await admit(res);
    if (!release) return;
    active++; peak = Math.max(peak, active);
    try { await held; res.end("initialized"); }
    finally { active--; release(); release(); }
  });
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => { server.once("listening", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const canceledRequest = new AbortController();
  const requests: Promise<number>[] = [];
  /** Drain every response and handle aborted clients immediately, including failed assertions. */
  const request = (slot: number, signal?: AbortSignal): Promise<number> => fetch(`${url}/events?slot=${slot}`, { signal }).then(async (response) => { await response.arrayBuffer(); return response.status; }).catch(() => 0);
  try {
    requests.push(request(1), request(2));
    await waitUntil(() => active === 2, 15_000, "two admitted joins");
    requests.push(request(3, canceledRequest.signal), request(4));
    await waitUntil(() => received === 4, 15_000, "two queued joins");
    assert.equal(active, 2, "waiting joins cannot enter the protected initialization work");
    const excess = await fetch(`${url}/events?slot=5`);
    assert.equal(excess.status, 503);
    assert.equal(excess.headers.get("retry-after"), "1");
    await excess.arrayBuffer();
    const health = await fetch(`${url}/healthz`);
    assert.equal(health.status, 200);
    await health.arrayBuffer();
    canceledRequest.abort();
    await waitUntil(() => canceled, 15_000, "queued socket cancellation");
    requests.push(request(6));
    await waitUntil(() => received === 6, 15_000, "reclaimed queue slot");
    assert.equal(active, 2);
    finish();
    assert.deepEqual(await Promise.all(requests), [200, 200, 0, 200, 200]);
    assert.equal(peak, 2);
    assert.equal(active, 0);
  } finally {
    finish(); canceledRequest.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await Promise.allSettled(requests);
  }
});
