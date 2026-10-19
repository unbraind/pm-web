/** Production-process acceptance kept separate because the live watcher baseline makes runs exceed 30 seconds under load. */
import assert from "node:assert/strict";
import test from "node:test";
import { runCapacity } from "../scripts/capacity.ts";

test("capacity smoke: 20 distinct authenticated SSE subscribers and 5 mixed writer lanes lose no committed mutation", { timeout: 60_000 }, async () => {
  const report = await runCapacity({ rungs: [20], writers: 5, writesPerWriter: 1, sloMs: 2000, drainMs: 2000 });
  assert.equal(report.failure, null, JSON.stringify(report.failure));
  const run = report.runs[0];
  assert.equal(run.committed_writes, 5);
  assert.equal(run.failed_writes, 0);
  assert.equal(run.lost, 0, JSON.stringify({ receipts: run.write_receipts, subscriber: run.per_subscriber[0], server_errors: run.server_error_counts }));
  assert.equal(run.disconnected_subscribers, 0);
  assert.equal(run.duplicates, 0);
  assert.equal(run.to_every_subscriber_ms.samples, 5);
  assert.ok(run.to_every_subscriber_ms.max !== null && run.to_every_subscriber_ms.max <= 2000, "every delivery must meet the SLO");
  assert.equal(run.health_after.realtime.sse_clients, 20);
  assert.ok(run.resources.postgres_server_connections_peak >= 1);
  assert.equal(run.passed, true);
});

test("opt-in tracing accounts for every real HTTP and CLI delivery without changing delivery correctness", { timeout: 60_000 }, async () => {
  const report = await runCapacity({ rungs: [2], writers: 2, writesPerWriter: 1, sloMs: 2000, drainMs: 2000, trace: true });
  assert.equal(report.failure, null, JSON.stringify(report.failure));
  const run = report.runs[0];
  assert.equal(run.passed, true);
  assert.equal(run.lost, 0);
  assert.equal(run.duplicates, 0);
  assert.ok(run.stages);
  for (const transport of ["http", "cli"]) {
    assert.equal(run.stages[transport].timestamp_to_history_append.samples, 1);
    assert.equal(run.stages[transport].client_write_call.samples, 2);
    assert.equal(run.stages[transport].write_return_to_client_receive.samples, 2);
  }
  assert.equal(run.stages.cli.append_to_detecting_poll.samples, 1);
  assert.equal(run.stages.cli.request_to_process_entry.samples, 1);
  assert.equal(run.stages.http.append_to_route_broadcast.samples, 1);
});
