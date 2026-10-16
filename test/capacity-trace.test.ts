/** Stage populations must remain complete, causal and explicitly transport-specific. */
import assert from "node:assert/strict";
import test from "node:test";
import { instrumentCapacityModule, stageSummary, traceCriticalPaths, type CapacityTrace } from "../scripts/capacity-trace.ts";
import { capacityOptions } from "../scripts/capacity.ts";

test("stage attribution separates overlapping CLI detection from direct HTTP delivery and keeps every subscriber", () => {
  const writes = ["http", "cli"].map((transport, sequence) => ({ sequence, transport: transport as "http" | "cli", itemId: `capacity-write-${sequence}`, committedAt: 1000, error: false }));
  const subscribers = ["a", "b"].map((clientId, offset) => ({ clientId, receivedAt: new Float64Array([1100 + offset, 1100 + offset]), counts: new Uint32Array([1, 1]), disconnected: false }));
  const traces: CapacityTrace[] = writes.flatMap(({ itemId }) => [
    { stage: "index-lock", itemId, start: 1001, at: 1020 },
    { stage: "history-written", itemId, at: 1030 },
    { stage: "classified", itemId, start: 1025, at: 1040 },
    { stage: "broadcast", itemId, at: 1050 },
    { stage: "serialized", itemId, at: 1060 },
    ...subscribers.map(({ clientId }, offset) => ({ stage: "write", itemId, clientId, start: 1070 + offset, at: 1080 + offset })),
  ]);
  const result = stageSummary(writes, subscribers, traces);
  assert.equal(result.http.timestamp_to_history_append.p99, 30);
  assert.equal(result.cli.index_lock_wait_nested_in_append.p99, 19);
  assert.equal(result.cli.append_to_detecting_poll.p99, 0);
  assert.equal(result.cli.detecting_read_and_classification.p99, 10);
  assert.equal(result.http.append_to_route_broadcast.p99, 20);
  assert.equal(result.http.detecting_read_and_classification, undefined);
  assert.equal(result.cli.fanout_queue_to_client_write.samples, 2);
  assert.equal(result.cli.client_write_call.p99, 10);
  assert.equal(result.cli.write_return_to_client_receive.p99, 20);
  const paths = traceCriticalPaths(writes, subscribers, traces);
  assert.equal(paths[0].to_all_ms, 101);
  assert.equal(paths[0].timestamp_to_append_ms, 30);
  assert.equal(paths[0].append_to_broadcast_ms + paths[0].broadcast_to_write_return_ms + paths[0].write_return_to_receive_ms, 71);
  const missing = subscribers.map((row) => ({ ...row, counts: new Uint32Array([0, 1]) }));
  assert.equal(traceCriticalPaths(writes, missing, traces).length, 1);
  assert.throws(() => stageSummary(writes, subscribers, traces.filter((row) => row.clientId !== "b")), /Missing subscriber/);
  assert.throws(() => stageSummary(writes, subscribers, traces.filter((row) => row.stage !== "history-written")), /Missing capacity stage/);
  const reversed = traces.map((row) => row.stage === "serialized" ? { ...row, at: 1045 } : row);
  assert.throws(() => stageSummary(writes, subscribers, reversed), /Invalid capacity stage clock/);
});

/** Two committed CLI writes ensure one complete write cannot conceal another missing lock. */
function cliLockFixture() {
  const writes = [0, 1].map((sequence) => ({ sequence, transport: "cli" as const, itemId: `capacity-write-${sequence}`, committedAt: 1000, error: false }));
  const traces: CapacityTrace[] = writes.flatMap(({ itemId }) => [
    { stage: "index-lock", itemId, start: 1000, at: 1000 },
    { stage: "index-lock", itemId, start: 1010, at: 1030 },
    { stage: "history-written", itemId, at: 1030 },
    { stage: "classified", itemId, start: 1030, at: 1040 },
    { stage: "broadcast", itemId, at: 1050 },
    { stage: "serialized", itemId, at: 1060 },
  ]);
  return { writes, traces };
}

test("stage attribution retains every matching CLI lock including append-window boundaries", () => {
  const { writes, traces } = cliLockFixture();
  const result = stageSummary(writes, [], traces);
  assert.equal(result.cli.index_lock_wait_nested_in_append.samples, 4);
  assert.equal(result.cli.index_lock_wait_nested_in_append.p99, 20);
  assert.equal(result.cli.timestamp_to_history_append.samples, 2);
  const http = writes.map((write) => ({ ...write, transport: "http" as const }));
  assert.equal(stageSummary(http, [], traces.filter((row) => row.stage !== "index-lock")).http.timestamp_to_history_append.samples, 2);
});

test("stage attribution rejects each committed CLI write without its own in-window index-lock", () => {
  const { writes, traces } = cliLockFixture();
  const incomplete = traces.filter((row) => row.itemId !== writes[1].itemId || row.stage !== "index-lock");
  const unrelated: CapacityTrace[] = [
    { stage: "index-lock", itemId: "capacity-write-other", start: 1000, at: 1020 },
    { stage: "index-lock", itemId: writes[1].itemId, start: 990, at: 999 },
    { stage: "index-lock", itemId: writes[1].itemId, start: 1030, at: 1031 },
  ];
  for (const records of [incomplete, [...incomplete, ...unrelated]]) {
    assert.throws(() => stageSummary(writes, [], records), {
      name: "Error", code: "TRACE_MISSING_index-lock",
      message: "Missing capacity stage: index-lock for write 1 (capacity-write-1)",
    });
  }
  const uncommitted = writes.map((write) => write.sequence === 1 ? { ...write, committedAt: null } : write);
  assert.equal(stageSummary(uncommitted, [], incomplete).cli.timestamp_to_history_append.samples, 1);
});

test("trace source drift and malformed opt-in fail closed while unselected modules stay unchanged", () => {
  assert.throws(() => instrumentCapacityModule("file:///dist/services/sse.js", "changed implementation"), /anchor changed/);
  assert.equal(instrumentCapacityModule("file:///unselected.js", "original"), "original");
  assert.equal(capacityOptions(["--trace", "true"]).trace, true);
  assert.equal(capacityOptions([]).trace, false);
  assert.throws(() => capacityOptions(["--trace", "maybe"]), /Trace must/);
});
