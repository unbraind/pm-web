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
