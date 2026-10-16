/** Invalidations use the existing HTTP and validated NOTIFY paths without touching subscriber policy. */
import assert from "node:assert/strict";
import test from "node:test";
import { onMutationReadSignal, signalMutationRead } from "../src/services/mutation-read-signals.ts";
import { broadcastProjectEvent } from "../src/services/sse.ts";
import { buildEnvelope, handleIncomingEnvelope } from "../src/services/realtime-bus.ts";

test("HTTP and peer NOTIFY force project reads; self, invalid and unrelated signals do not", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let first = 0;
  let second = 0;
  const stopFirst = onMutationReadSignal(projectId, () => { first += 1; });
  const stopSecond = onMutationReadSignal(projectId, () => { second += 1; });
  try {
    broadcastProjectEvent(projectId, { type: "item-updated", data: { itemId: "synthetic" } });
    assert.equal(first, 1);
    assert.equal(second, 1);
    const envelope = buildEnvelope(projectId, { type: "workspace-changed", data: {} }, "peer")!;
    handleIncomingEnvelope(envelope, "local", () => undefined);
    assert.equal(first, 2);
    handleIncomingEnvelope(envelope, "peer", () => undefined);
    handleIncomingEnvelope("invalid", "local", () => undefined);
    signalMutationRead("unwatched");
    assert.equal(first, 2);
    stopFirst();
    signalMutationRead(projectId);
    assert.equal(first, 2);
    assert.equal(second, 3);
  } finally { stopFirst(); stopSecond(); }
  signalMutationRead(projectId);
  assert.equal(second, 3);
});
