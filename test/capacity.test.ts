/** Loss accounting and host safety guards for the capacity experiment. */
import assert from "node:assert/strict";
import test from "node:test";
import { capacityOptions } from "../scripts/capacity.ts";
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
