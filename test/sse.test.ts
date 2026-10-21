import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import type { Response } from "express";
import { transformSync } from "esbuild";
import { realtimeHealth } from "../src/services/realtime-observability.ts";
import { waitUntil } from "../scripts/capacity-wait.ts";

import {
  addSSEClient,
  broadcastProjectEvent,
  broadcastPresence,
  closeAllSSEClients,
  configureProjectEventPublisher,
  consumeSignaledItemMutation,
  getProjectPresence,
  getSSEClientCount,
  updateClientView,
} from "../src/services/sse.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "33333333-3333-4333-8333-333333333333";

test("failed initial SSE writes retain no detach handle after unsubscribe or shutdown", (t) => {
  const source = readFileSync(new URL("../src/services/sse.ts", import.meta.url), "utf8");
  const inspection = "\nexport function retainedDetachHandles() { return detachFanout.size; }";
  const module = { exports: {} as { addSSEClient: typeof addSSEClient; closeAllSSEClients: typeof closeAllSSEClients; retainedDetachHandles: () => number } };
  runInNewContext(transformSync(source + inspection, { loader: "ts", format: "cjs", target: "es2022" }).code, {
    module, exports: module.exports, require: createRequire(new URL("../src/services/sse.ts", import.meta.url)), setTimeout, clearTimeout,
  });
  const service = module.exports;
  t.after(service.closeAllSSEClients);
  const before = realtimeHealth().counters.sse_clients;
  const res = { write: () => { throw new Error("synthetic failed initial write"); }, destroy: () => {} } as unknown as Response;
  for (let i = 0; i < 3; i++) {
    const unsubscribe = service.addSSEClient({ id: `failed-attach-${i}`, projectId, userId: "user-a", displayName: "User A", currentView: "items", connectedAt: new Date(), res });
    unsubscribe();
  }
  service.closeAllSSEClients();
  assert.equal(realtimeHealth().counters.sse_clients, before);
  assert.equal(service.retainedDetachHandles(), 0, "failed sockets must not stay reachable through detach closures");
});

test("a rejected SSE resume attachment rolls back connection indexes and gauge", (t) => {
  t.after(closeAllSSEClients);
  const before = realtimeHealth().counters.sse_clients;
  const response = fakeResponse();
  assert.throws(() => addSSEClient({ id: "rejected-resume", projectId, userId: "user-a", displayName: "User A", currentView: "items", connectedAt: new Date(), res: response.response }, "expired:1"), /expired/);
  assert.equal(getSSEClientCount(), before);
  assert.equal(realtimeHealth().counters.sse_clients, before);
  assert.deepEqual(getProjectPresence(projectId), []);
});

/** Capture SSE writes for unit assertions without opening an HTTP connection. */
function fakeResponse() {
  const writes: string[] = [];
  return {
    writes,
    response: { write: (value: string) => { writes.push(String(value)); return true; } } as unknown as Response,
  };
}

for (const endFails of [false, true]) {
  test(`replacing an SSE client closes the old response and preserves the gauge (end fails: ${endFails})`, async (t) => {
    const before = realtimeHealth().counters;
    let ended = 0;
    const oldResponse = {
      write: () => true,
      end: () => { ended += 1; if (endFails) throw new Error("synthetic closed socket"); },
    } as unknown as Response;
    const client = {
      id: "replaced-client", projectId, userId: "user-a", displayName: "User A",
      currentView: "items", connectedAt: new Date(),
    };
    const unsubscribeOld = addSSEClient({ ...client, res: oldResponse });
    t.after(unsubscribeOld);
    assert.equal(realtimeHealth().counters.sse_clients, before.sse_clients + 1);
    const current = fakeResponse();
    const unsubscribeNew = addSSEClient({ ...client, projectId: otherProjectId, res: current.response });
    t.after(unsubscribeNew);
    assert.equal(ended, 1, "replacement must attempt to close the prior response");
    assert.equal(getSSEClientCount(), before.sse_clients + 1);
    assert.equal(realtimeHealth().counters.sse_clients, before.sse_clients + 1);
    assert.equal(realtimeHealth().counters.sse_connections_total, before.sse_connections_total + 2);
    assert.equal(realtimeHealth().counters.sse_disconnections_total, before.sse_disconnections_total + 1);
    assert.deepEqual(getProjectPresence(projectId), []);
    assert.equal(getProjectPresence(otherProjectId).length, 1);
    unsubscribeOld();
    assert.equal(realtimeHealth().counters.sse_clients, before.sse_clients + 1, "late old cleanup must preserve the new client");
    broadcastProjectEvent(otherProjectId, { type: "workspace-changed", data: {} });
    await delay(15);
    assert.match(current.writes.join(""), /event: workspace-changed/);
    unsubscribeNew();
    assert.equal(realtimeHealth().counters.sse_clients, before.sse_clients);
    assert.equal(getSSEClientCount(), before.sse_clients);
    assert.equal(realtimeHealth().counters.sse_disconnections_total, before.sse_disconnections_total + 2);
  });
}

test("presence view updates require the exact user and project session", async () => {
  const target = fakeResponse();
  const unsubscribe = addSSEClient({
    id: "client-a",
    projectId,
    userId: "user-a",
    displayName: "User A",
    currentView: "items",
    res: target.response,
    connectedAt: new Date(),
  });
  try {
    assert.equal(updateClientView("client-a", "user-b", projectId, "graph"), false);
    assert.equal(updateClientView("client-a", "user-a", "22222222-2222-4222-8222-222222222222", "graph"), false);
    assert.equal(updateClientView("client-a", "user-a", projectId, "graph"), true);
    await waitUntil(() => target.writes.join("").includes('"currentView":"graph"'), 3000, "coalesced view update");
    assert.match(target.writes.join(""), /"currentView":"graph"/);
  } finally {
    unsubscribe();
  }
});

test("project events deliver locally and invoke the configured cross-process publisher", async () => {
  const target = fakeResponse();
  const published: Array<{ projectId: string; type: string }> = [];
  const unsubscribe = addSSEClient({
    id: "client-b",
    projectId,
    userId: "user-b",
    displayName: "User B",
    currentView: "items",
    res: target.response,
    connectedAt: new Date(),
  });
  configureProjectEventPublisher(async (id, event) => { published.push({ projectId: id, type: event.type }); });
  try {
    broadcastProjectEvent(projectId, { type: "workspace-changed", data: { source: "test" } });
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    assert.match(target.writes.join(""), /event: workspace-changed/);
    assert.deepEqual(published, [{ projectId, type: "workspace-changed" }]);
  } finally {
    configureProjectEventPublisher(null);
    unsubscribe();
  }
});

test("project events and presence are isolated per project and clients are indexed by project", async () => {
  const a = fakeResponse();
  const b = fakeResponse();
  const unsubA = addSSEClient({
    id: "iso-a", projectId, userId: "user-a", displayName: "User A",
    currentView: "items", res: a.response, connectedAt: new Date(),
  });
  const unsubB = addSSEClient({
    id: "iso-b", projectId: otherProjectId, userId: "user-b", displayName: "User B",
    currentView: "items", res: b.response, connectedAt: new Date(),
  });
  try {
    assert.equal(getSSEClientCount(), 2);
    assert.equal(getProjectPresence(projectId).length, 1);
    assert.equal(getProjectPresence(otherProjectId).length, 1);

    // An event for `projectId` must reach only that project's clients.
    broadcastProjectEvent(projectId, { type: "workspace-changed", data: { source: "iso" } });
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    assert.match(a.writes.join(""), /event: workspace-changed/);
    assert.doesNotMatch(b.writes.join(""), /event: workspace-changed/);
  } finally {
    unsubA();
    unsubB();
  }
  // Unsubscribing removes clients from both indexes.
  assert.equal(getSSEClientCount(), 0);
  assert.equal(getProjectPresence(projectId).length, 0);
});

test("shutdown closes and removes every active SSE client", () => {
  let ended = 0;
  const response = {
    write: () => true,
    end: () => { ended += 1; },
  } as unknown as Response;
  addSSEClient({
    id: "shutdown-a", projectId, userId: "user-a", displayName: "User A",
    currentView: "items", res: response, connectedAt: new Date(),
  });
  addSSEClient({
    id: "shutdown-b", projectId: otherProjectId, userId: "user-b", displayName: "User B",
    currentView: "items", res: response, connectedAt: new Date(),
  });

  closeAllSSEClients();

  assert.equal(ended, 2);
  assert.equal(getSSEClientCount(), 0);
  assert.deepEqual(getProjectPresence(projectId), []);
  assert.deepEqual(getProjectPresence(otherProjectId), []);
});

test("broadcastProjectEvent notes per-item signal when data has a string itemId", () => {
  // A route broadcast with a granular itemId payload should register a per-item
  // signal that the mutation-event watcher can consume to skip the duplicate.
  broadcastProjectEvent(projectId, { type: "workspace-changed", data: { source: "mutation-events", itemId: "item-xyz", operation: "update" } });
  assert.equal(consumeSignaledItemMutation(projectId, "item-xyz"), true, "signal was noted by broadcast");
  // Consume is destructive — second call returns false.
  assert.equal(consumeSignaledItemMutation(projectId, "item-xyz"), false, "signal already consumed");
});

test("broadcastProjectEvent does not note per-item signal when data has no itemId", () => {
  broadcastProjectEvent(projectId, { type: "workspace-changed", data: { source: "filesystem" } });
  assert.equal(consumeSignaledItemMutation(projectId, "anything"), false, "no item signal for itemId-less event");
});

test("broadcastProjectEvent does not note per-item signal for array data", () => {
  broadcastProjectEvent(projectId, { type: "presence", data: [{ userId: "u1" }] });
  assert.equal(consumeSignaledItemMutation(projectId, "u1"), false, "array data does not produce item signal");
});

test("broadcastProjectEvent does not note per-item signal for non-string itemId", () => {
  broadcastProjectEvent(projectId, { type: "workspace-changed", data: { itemId: 12345 } });
  assert.equal(consumeSignaledItemMutation(projectId, "12345"), false, "numeric itemId does not produce signal");
});

test("broadcastProjectEvent rejects over-long itemId (boundary at 256 chars)", () => {
  const longId = "x".repeat(257);
  broadcastProjectEvent(projectId, { type: "workspace-changed", data: { itemId: longId } });
  assert.equal(consumeSignaledItemMutation(projectId, longId), false, "257-char itemId is not tracked");
  // 256 chars is the boundary — should be tracked.
  const maxId = "y".repeat(256);
  broadcastProjectEvent(projectId, { type: "workspace-changed", data: { itemId: maxId } });
  assert.equal(consumeSignaledItemMutation(projectId, maxId), true, "256-char itemId is tracked");
});

test("consumeSignaledItemMutation is isolated per project", () => {
  broadcastProjectEvent(projectId, { type: "workspace-changed", data: { itemId: "shared-item" } });
  // Same itemId on a different project should not be consumed.
  assert.equal(consumeSignaledItemMutation(otherProjectId, "shared-item"), false, "different project has no signal");
  assert.equal(consumeSignaledItemMutation(projectId, "shared-item"), true, "original project has the signal");
});

test("shutdown keeps closing the remaining SSE clients when one response fails to end", () => {
  let ended = 0;
  const failing = {
    write: () => true,
    end: () => { throw new Error("socket already destroyed"); },
  } as unknown as Response;
  const healthy = {
    write: () => true,
    end: () => { ended += 1; },
  } as unknown as Response;
  addSSEClient({
    id: "shutdown-failing", projectId, userId: "user-a", displayName: "User A",
    currentView: "items", res: failing, connectedAt: new Date(),
  });
  addSSEClient({
    id: "shutdown-healthy", projectId: otherProjectId, userId: "user-b", displayName: "User B",
    currentView: "items", res: healthy, connectedAt: new Date(),
  });

  assert.doesNotThrow(() => closeAllSSEClients());

  assert.equal(ended, 1);
  assert.equal(getSSEClientCount(), 0);
  assert.deepEqual(getProjectPresence(projectId), []);
  assert.deepEqual(getProjectPresence(otherProjectId), []);
});


test("connect and resume send a fresh current roster separately from mutation replay", async (t) => {
  t.after(closeAllSSEClients);
  const first = fakeResponse();
  const client = { id: "presence-resume", projectId, userId: "roster-user", displayName: "Roster User", currentView: "items", connectedAt: new Date() };
  const stop = addSSEClient({ ...client, res: first.response });
  broadcastPresence(projectId);
  broadcastProjectEvent(projectId, { type: "mutation", data: { itemId: "roster-mutation" } });
  await delay(20);
  assert.match(first.writes.join(""), /event: presence/);
  const cursor = /^id: (.+)$/m.exec(first.writes[0])![1];
  stop();
  const resumed = fakeResponse();
  addSSEClient({ ...client, currentView: "graph", res: resumed.response }, cursor);
  await waitUntil(() => resumed.writes.join("").includes("event: presence"), 3000, "fresh resumed roster");
  const events = resumed.writes.join("").split("\n\n").filter(Boolean);
  const rosters = events.filter((event) => event.startsWith("event: presence"));
  assert.equal(rosters.length, 1, "resume must send one current snapshot, never historical rosters");
  assert.match(rosters[0], /"currentView":"graph"/);
  assert.doesNotMatch(rosters[0], /^id:/m);
  assert.equal(events.filter((event) => event.startsWith("event: mutation")).length, 1);
});
