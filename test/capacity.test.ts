/** Loss accounting and host safety guards for the capacity experiment. */
import assert from "node:assert/strict";
import test from "node:test";
import { RungFailure, capacityOptions, describeRungFailure, rungPassed } from "../scripts/capacity.ts";
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
