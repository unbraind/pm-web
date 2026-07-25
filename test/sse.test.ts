import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  addSSEClient,
  broadcastProjectEvent,
  configureProjectEventPublisher,
  consumeSignaledItemMutation,
  getProjectPresence,
  getSSEClientCount,
  updateClientView,
} from "../dist/services/sse.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "33333333-3333-4333-8333-333333333333";

test("persistent PostgreSQL realtime listener handles errors and reconnects", () => {
  const source = readFileSync(new URL("../src/services/realtime-bus.ts", import.meta.url), "utf8");
  assert.match(source, /client\.on\("error", error\)/);
  assert.match(source, /scheduleReconnect\(cause\)/);
  assert.match(source, /reconnectDelayMs = Math\.min/);
  assert.match(source, /client\.release\(destroy\)/);
  assert.equal(source.match(/client\.query\(`UNLISTEN \$\{CHANNEL\}`\)/g)?.length, 2);
});

function fakeResponse() {
  const writes: string[] = [];
  return {
    writes,
    response: { write: (value: string) => { writes.push(value); return true; } } as any,
  };
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
