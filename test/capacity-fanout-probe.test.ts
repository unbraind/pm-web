/** Functional probe accounting with one synthetic sink, without a capacity measurement. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import type { Response } from "express";
import { transformSync } from "esbuild";
import { fanoutMeasurement, instrumentFanoutCpu, resetFanoutMeasurement } from "../scripts/capacity-fanout-probe.ts";
import { FANOUT_LIMITS, type attachFanout, type clearFanout, type prepareFanout } from "../src/services/sse-fanout.ts";

/** Inspect strong cache ownership in the actual probe without installing another loader hook. */
function isolatedProbe() {
  const maps: Map<unknown, unknown>[] = [];
  class ObservedMap extends Map<unknown, unknown> {
    constructor() { super(); maps.push(this); }
  }
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { fanoutMeasurement: typeof fanoutMeasurement; resetFanoutMeasurement: typeof resetFanoutMeasurement; observer: { write: (payload: string | Buffer) => void } } };
  const realm = { module, exports: module.exports, Buffer, Map: ObservedMap, setImmediate, clearImmediate, process,
    // This fixture exercises counting only; source-loading instrumentation has its own tests.
    require: (specifier: string) => specifier === "node:module" ? { registerHooks: () => {} } : require(specifier) };
  const source = readFileSync(new URL("../scripts/capacity-fanout-probe.ts", import.meta.url), "utf8");
  runInNewContext(transformSync(source + "\nexport { observer };", { loader: "ts", format: "cjs", target: "es2022" }).code, realm);
  return { ...module.exports, retained: () => maps.flatMap((map) => [...map.keys()]) };
}

test("probe counting never strongly retains written Buffer payloads and reuses shared frame counts", () => {
  const probe = isolatedProbe();
  const payload = Buffer.from('event: item-updated\ndata: {"itemId":"capacity-write-0"}\n\n');
  let decodes = 0;
  payload.toString = () => { decodes++; return Buffer.prototype.toString.call(payload); };
  probe.observer.write(payload);
  probe.observer.write(payload);
  assert.equal(probe.fanoutMeasurement().delivered_mutations, 2);
  assert.equal(decodes, 1, "shared buffers should be parsed once");
  assert.equal(probe.retained().includes(payload), false, "probe caches must not own written buffers");
});

test("probe string caches bound both entry count and retained bytes without losing accounting", () => {
  const probe = isolatedProbe();
  for (let i = 0; i < 1100; i++) probe.observer.write(`event: presence\ndata: {"index":${i}}\n\n`);
  assert.equal(probe.fanoutMeasurement().delivered_events, 1100);
  assert.ok(probe.retained().length <= 1024, "distinct strings must not accumulate without an entry bound");
  for (let i = 0; i < 4; i++) probe.observer.write(`event: presence\ndata: ${i}${"x".repeat(200_000)}\n\n`);
  const retainedBytes = probe.retained().reduce<number>((sum, key) => sum + String(key).length * 2, 0);
  assert.ok(retainedBytes <= 1024 * 1024, "large rosters must obey the byte budget too");
  probe.observer.write(`event: presence\ndata: ${"x".repeat(600_000)}\n\n`);
  assert.equal(probe.fanoutMeasurement().delivered_events, 1105, "oversized uncached strings still count");
  assert.ok(probe.retained().every((key) => String(key).length * 2 <= 1024 * 1024));
});

test("probe reset discards cached buffer counts and all strong string payloads", () => {
  const probe = isolatedProbe();
  const payload = Buffer.from('event: item-updated\ndata: {"itemId":"capacity-write-0"}\n\n');
  probe.observer.write(payload);
  probe.observer.write("event: presence\ndata: {}\n\n");
  probe.resetFanoutMeasurement();
  assert.deepEqual(probe.retained(), []);
  assert.equal(probe.fanoutMeasurement().response_writes, 0);
  // Reusing a changed buffer after reset must parse fresh rather than reuse the prior run's count.
  payload.fill(32);
  payload.write("event: presence\ndata: {}\n\n");
  probe.observer.write(payload);
  assert.equal(probe.fanoutMeasurement().delivered_mutations, 0);
  assert.equal(probe.fanoutMeasurement().delivered_events, 1);
});

test("fanout probes count non-journaled snapshot encoding and actual snapshot writes", async (t) => {
  const compiled = readFileSync(new URL("../dist/services/sse-fanout.js", import.meta.url), "utf8");
  // Inspect retained buffers in the actual module without adding a production diagnostics API.
  const inspection = "\nexport function retainedPresenceBytes() { return [...projects.values()].reduce((sum, state) => sum + (state.presence?.length ?? 0), 0); }";
  const observed = instrumentFanoutCpu(compiled + inspection, false);
  const module = { exports: {} as { attachFanout: typeof attachFanout; clearFanout: typeof clearFanout; prepareFanout: typeof prepareFanout; retainedPresenceBytes: () => number } };
  const realm = { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, setTimeout, clearTimeout, setImmediate, process };
  Reflect.set(realm, Symbol.for("pm-web.capacity.fanout"), Reflect.get(globalThis, Symbol.for("pm-web.capacity.fanout")));
  runInNewContext(transformSync(observed, { format: "cjs", target: "es2022" }).code, realm);
  const service = module.exports;
  t.after(service.clearFanout);
  const writes: Buffer[] = [];
  const res = { write: (payload: Buffer) => { writes.push(payload); return true; } } as unknown as Response;
  service.attachFanout("probe-project", { id: "probe-client", userId: "probe-user", res }, () => {});
  writes.length = 0;
  resetFanoutMeasurement();
  service.prepareFanout("probe-project", { type: "presence", data: { users: ["old"] } });
  service.prepareFanout("probe-project", { type: "presence", data: { users: ["current"] } });
  service.prepareFanout("probe-project", { type: "item-updated", data: { itemId: "capacity-write-0" } });
  await delay(20);
  const measured = fanoutMeasurement();
  assert.equal(measured.prepared_events, 3, "every snapshot is encoded once even when replaced before delivery");
  assert.equal(measured.delivered_events, 2, "only the current snapshot and mutation were written");
  assert.equal(measured.delivered_mutations, 1);
  assert.equal(measured.response_writes, writes.length);
  assert.ok(measured.serialized_bytes > writes.reduce((sum, payload) => sum + payload.length, 0));
  service.prepareFanout("probe-project", { type: "presence", data: "x".repeat(FANOUT_LIMITS.queueBytes) });
  assert.equal(service.retainedPresenceBytes(), 0, "rejected oversized snapshots must not remain cached after all viewers detach");
});
