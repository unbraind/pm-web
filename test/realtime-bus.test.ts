import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvelope,
  handleIncomingEnvelope,
  parseEnvelope,
} from "../dist/services/realtime-bus.js";
import type { SSEEvent } from "../dist/services/sse.js";

const projectId = "11111111-1111-4111-8111-111111111111";

interface DeliverRecord {
  projectId: string;
  event: SSEEvent;
}

function deliverSpy(): { records: DeliverRecord[]; fn: (projectId: string, event: SSEEvent) => void } {
  const records: DeliverRecord[] = [];
  return {
    records,
    fn: (projectId, event) => { records.push({ projectId, event }); },
  };
}

test("buildEnvelope + handleIncomingEnvelope delivers to a different replica", () => {
  const env = buildEnvelope(projectId, { type: "item-updated", data: { itemId: "x" } }, "instance-A");
  assert.equal(typeof env, "string");
  assert.ok(env !== null);

  const spy = deliverSpy();
  handleIncomingEnvelope(env!, "instance-B", spy.fn);

  assert.equal(spy.records.length, 1);
  assert.equal(spy.records[0].projectId, projectId);
  assert.equal(spy.records[0].event.type, "item-updated");
  assert.deepEqual(spy.records[0].event.data, { itemId: "x" });
});

test("handleIncomingEnvelope self-skips when instanceId matches sourceId", () => {
  const env = buildEnvelope(projectId, { type: "item-updated", data: { itemId: "x" } }, "instance-A");
  assert.ok(env !== null);

  const spy = deliverSpy();
  handleIncomingEnvelope(env!, "instance-A", spy.fn);
  assert.equal(spy.records.length, 0);
});

test("handleIncomingEnvelope delivers nothing for malformed payloads", () => {
  const spy = deliverSpy();

  handleIncomingEnvelope("not-json", "instance-B", spy.fn);
  assert.equal(spy.records.length, 0);

  handleIncomingEnvelope(undefined, "instance-B", spy.fn);
  assert.equal(spy.records.length, 0);

  // Oversized string (>7500 bytes)
  const big = "x".repeat(8_000);
  handleIncomingEnvelope(big, "instance-B", spy.fn);
  assert.equal(spy.records.length, 0);
});

test("buildEnvelope returns null for invalid projectId or event type", () => {
  assert.equal(
    buildEnvelope("not-a-uuid", { type: "item-updated", data: { itemId: "x" } }, "instance-A"),
    null,
  );
  assert.equal(
    buildEnvelope(projectId, { type: "BAD TYPE!", data: { itemId: "x" } }, "instance-A"),
    null,
  );
});

test("parseEnvelope is exported and round-trips a built envelope", () => {
  const env = buildEnvelope(projectId, { type: "item-created", data: { itemId: "y" } }, "instance-C");
  assert.ok(env !== null);
  const parsed = parseEnvelope(env!);
  assert.ok(parsed !== null);
  assert.equal(parsed!.projectId, projectId);
  assert.equal(parsed!.type, "item-created");
  assert.equal(parsed!.sourceId, "instance-C");
  assert.deepEqual(parsed!.data, { itemId: "y" });
});