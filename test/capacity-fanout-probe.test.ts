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
import type { attachFanout, clearFanout, prepareFanout } from "../src/services/sse-fanout.ts";

test("fanout probes count non-journaled snapshot encoding and actual snapshot writes", async (t) => {
  const compiled = readFileSync(new URL("../dist/services/sse-fanout.js", import.meta.url), "utf8");
  const observed = instrumentFanoutCpu(compiled, false);
  const module = { exports: {} as { attachFanout: typeof attachFanout; clearFanout: typeof clearFanout; prepareFanout: typeof prepareFanout } };
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
});
