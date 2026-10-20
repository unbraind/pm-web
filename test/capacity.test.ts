/** Loss accounting and host safety guards for the capacity experiment. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
import express from "express";
import { setTimeout as delay } from "node:timers/promises";
import { RungFailure, capacityOptions, capacitySubscriber, describeRungFailure, rungPassed, type CapacityObservation } from "../scripts/capacity.ts";
import { waitUntil } from "../scripts/capacity-fixture.ts";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";
import { createCapacityClients } from "../scripts/capacity-clients.ts";
import { deliverySummary } from "../scripts/capacity-metrics.ts";

test("capacity accounting detects a missing subscriber receipt, a duplicate, and a late delivery before acknowledgement", () => {
  const summary = deliverySummary([
    { sequence: 0, itemId: "one", transport: "http", committedAt: 1000, error: false },
    { sequence: 1, itemId: "two", transport: "cli", committedAt: 2000, error: false },
  ], [
    { receivedAt: new Float64Array([1010, 4500]), counts: new Uint32Array([2, 1]), disconnected: false },
    { receivedAt: new Float64Array([1015, 0]), counts: new Uint32Array([1, 0]), disconnected: false },
  ]);
  assert.equal(summary.lost, 1);
  assert.equal(summary.duplicates, 1);
  assert.deepEqual(summary.per_subscriber[1].missing_sequences, [1]);
  assert.equal(summary.latency_ms.max, 2500);
  assert.equal(summary.to_every_subscriber_ms.max, 15);
});

test("capacity refuses a ladder beyond the host safety cap", () => {
  assert.throws(() => capacityOptions(["--rungs", "100,3001"]), /3000/);
});

test("comparison warm-up is explicit and bounded while release defaults stay unchanged", () => {
  assert.equal(capacityOptions([]).warmupMs, undefined);
  assert.equal(capacityOptions([]).setupConcurrency, undefined);
  assert.equal(capacityOptions(["--setup-concurrency", "10"]).setupConcurrency, 10);
  for (const value of ["0", "51", "NaN"]) assert.throws(() => capacityOptions(["--setup-concurrency", value]), /Setup concurrency/);
  assert.equal(capacityOptions(["--warmup-ms", "120000"]).warmupMs, 120_000);
  for (const value of ["0", "14999", "120001", "NaN"]) {
    assert.throws(() => capacityOptions(["--warmup-ms", value]), /Warm-up/);
  }
});

test("shared presence parsing keeps independent complete-frame receipts and bounded retained snapshots", async (t) => {
  const responses = new Map<string, ServerResponse>();
  const subscribers: Awaited<ReturnType<typeof capacitySubscriber>>[] = [];
  const app = express();
  app.use((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    responses.set(req.url!, res);
    res.write('event: connected\ndata: {"clientId":"synthetic"}\n\n');
  });
  const server = await startEphemeralServer(app);
  t.after(async () => {
    await Promise.all(subscribers.map((subscriber) => subscriber.close()));
    await server.close();
  });
  const observation: CapacityObservation = { open: true, presenceCounts: new Map() };
  const unicodeItem = "synthetic-é 🐘";
  for (const name of ["first", "second"]) subscribers.push(await capacitySubscriber(
    server.url(`/${name}`), {}, new Map([[unicodeItem, 0]]), 1, observation));
  const roster = 'event: presence\ndata: {"users":[{"userId":"one"},{"userId":"two"}]}\n\n';
  responses.get("/first")!.write(roster);
  responses.get("/second")!.write(roster.slice(0, -1));
  await waitUntil(() => subscribers[0].state.presenceUsers === 2, 5000, "first complete roster");
  assert.equal(observation.presenceCounts!.size, 1, "identical rosters have shared parsing work");
  assert.equal(subscribers[1].state.presenceUsers, undefined, "a cached roster cannot acknowledge another socket's partial frame");
  responses.get("/second")!.write(roster.slice(-1));
  await waitUntil(() => subscribers[1].state.presenceUsers === 2, 5000, "second complete roster");
  assert.equal(observation.presenceCounts!.size, 1);
  let last = "";
  for (let i = 0; i < 130; i++) {
    last = `event: presence\ndata: {"users":[{"userId":"synthetic-${i}"}]}`;
    responses.get("/first")!.write(last + "\n\n");
  }
  await waitUntil(() => observation.presenceCounts!.has(last), 5000, "last complete roster");
  assert.equal(observation.presenceCounts!.size, 128);
  assert.equal(subscribers[0].state.presenceUsers, 1);
  assert.equal(subscribers[1].state.presenceUsers, 2);
  const mutation = Buffer.from(`event: item-updated\ndata: ${JSON.stringify({ itemId: unicodeItem })}\n\n`);
  const split = mutation.indexOf(Buffer.from("🐘")) + 2;
  responses.get("/first")!.write(mutation.subarray(0, split));
  await delay(20);
  assert.equal(subscribers[0].state.counts[0], 0);
  responses.get("/first")!.write(mutation.subarray(split));
  await waitUntil(() => subscribers[0].state.counts[0] === 1, 5000, "complete UTF-8 mutation");
  assert.equal(subscribers[1].state.counts[0], 0);
});

test("a buffered connected frame never validates a transport whose startup deadline already expired", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('event: connected\ndata: {"clientId":"synthetic"}\n\n'));
          controller.close();
        } }), { headers: { "content-type": "text/event-stream" } }));
      }, { once: true });
    });
  });
  await assert.rejects(capacitySubscriber("http://127.0.0.1/synthetic", {}, new Map(), 1, { open: false }, 30), { code: "SSE_STARTUP_TIMEOUT" });
});

test("client workers retain independent real socket receipts, timestamps and parser state", async (t) => {
  const responses: ServerResponse[] = [];
  const app = express();
  app.use((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); responses.push(res); res.write('event: connected\ndata: {"clientId":"synthetic"}\n\n'); });
  const server = await startEphemeralServer(app);
  const clients = createCapacityClients({ url: server.url("/cohort"), sessions: [{}, {}], indices: [["one", 0]], writes: 1,
    population: 2, concurrency: 2, startupMs: 5000, presenceMs: 5000, perWorker: 1 });
  t.after(async () => { await clients.close(); await server.close(); });
  await clients.ready;
  assert.equal(clients.workers, 2);
  for (const response of responses) response.write('event: presence\ndata: {"users":[{"userId":"one"},{"userId":"two"}]}\n\n');
  await clients.presence();
  await clients.begin();
  const mutation = 'event: item-updated\ndata: {"itemId":"one"}\n\n';
  responses[0].write(mutation);
  responses[1].write(mutation.slice(0, -1));
  const partial = [];
  const partialDeadline = performance.now() + 5000;
  while (performance.now() < partialDeadline) {
    const states = await clients.snapshot();
    const received = states.reduce((sum, state) => sum + state.counts[0], 0);
    assert.ok(received <= 1, "the unfinished second frame cannot become a receipt");
    if (received === 1) { partial.push(...states); break; }
    await delay(20);
  }
  assert.equal(partial.length, 2);
  responses[1].write(mutation.slice(-1));
  const complete = [];
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const states = await clients.snapshot();
    if (states.every((state) => state.counts[0] === 1)) { complete.push(...states); break; }
    await delay(20);
  }
  assert.equal(complete.length, 2);
  assert.ok(complete.every((state) => state.receivedAt[0] > 0 && !state.disconnected));
  assert.deepEqual((await clients.end()).map((state) => state.counts[0]), [1, 1]);
  assert.equal(clients.loopDelays().length, 2);
});

test("a rung with a duplicate delivery does not pass even when nothing was lost", () => {
  const healthy = { lost: 0, duplicates: 0, failedWrites: 0, disconnected: 0, p99: 100, sloMs: 2000, healthy: true, serverErrorKinds: 0 };
  assert.equal(rungPassed(healthy), true);
  assert.equal(rungPassed({ ...healthy, duplicates: 1 }), false);
  assert.equal(rungPassed({ ...healthy, lost: 1 }), false);
  assert.equal(rungPassed({ ...healthy, p99: null }), false);
  assert.equal(rungPassed({ ...healthy, p99: 2001 }), false);
  assert.equal(rungPassed({ ...healthy, healthy: false }), false);
});

test("a rung failure keeps its phase, error name and string code, never the message, and the first failure wins over cleanup", () => {
  const dbError = Object.assign(new Error("password=secret host=db"), { code: "ECONNREFUSED" });
  const described = describeRungFailure(dbError, "measurement");
  assert.ok(described instanceof RungFailure);
  assert.equal(described.phase, "measurement");
  assert.equal(described.causeName, "Error");
  assert.equal(described.causeCode, "ECONNREFUSED");
  assert.doesNotMatch(described.message, /secret/);
  assert.equal(describeRungFailure(Object.assign(new Error("x"), { code: 42 }), "setup").causeCode, null);
  assert.equal(describeRungFailure("boom", "cleanup").causeName, "string");
  assert.equal(describeRungFailure(described, "cleanup"), described);
});
