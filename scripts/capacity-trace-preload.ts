/** Explicit test-child preload: memory-only probes, flushed after measurement into owned temporary files. */
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { instrumentCapacityModule, type CapacityTrace } from "./capacity-trace.ts";

const records: CapacityTrace[] = [];
let overflow = false;
const directory = process.env.PM_WEB_CAPACITY_TRACE_DIR;
if (!directory) throw new Error("Capacity trace requires an owned output directory");

/** Only synthetic measured item ids enter the trace, never paths or event payloads. */
function trace(stage: string, itemId?: string, extra: Partial<CapacityTrace> = {}): void {
  if (!itemId || !/^capacity-write-\d+$/.test(itemId)) return;
  if (records.length >= 400_000) { overflow = true; return; }
  records.push({ ...extra, stage, itemId, at: performance.timeOrigin + performance.now() });
}

const observer = Object.assign(trace, {
  /** Record only an item's identity from SSE data. */
  event(stage: string, event: { type: string; data: unknown }, extra?: Partial<CapacityTrace>): void {
    if (event.data && typeof event.data === "object" && "itemId" in event.data && typeof event.data.itemId === "string") {
      const source = "source" in event.data && typeof event.data.source === "string" ? event.data.source : "route";
      trace(stage, event.data.itemId, { ...extra, eventType: event.type, source });
    }
  },
});
Reflect.set(globalThis, Symbol.for("pm-web.capacity.trace"), observer);
trace("writer-start", process.env.PM_WEB_CAPACITY_TRACE_WRITER_ITEM);
const originalOpen = fs.open;
const lockAttempts = new Map<string, number>();
// The CLI uses a focused bundle while the SDK can use core modules. Observe the
// actual file boundary in both without depending on minified dependency symbols.
fs.open = async (...args: Parameters<typeof originalOpen>) => {
  const file = String(args[0]);
  const name = path.basename(file);
  const itemId = process.env.PM_WEB_CAPACITY_TRACE_WRITER_ITEM;
  const lock = itemId && name === "history-event-index.lock";
  if (lock && !lockAttempts.has(file)) lockAttempts.set(file, performance.timeOrigin + performance.now());
  const handle = await originalOpen(...args);
  const originalWrite = handle.writeFile.bind(handle);
  handle.writeFile = async (...parameters: Parameters<typeof originalWrite>) => {
    await originalWrite(...parameters);
    if (file.includes(`${path.sep}history${path.sep}`) && name.endsWith(".jsonl")) trace("history-written", name.slice(0, -6));
    if (lock) {
      trace("index-lock", itemId, { start: lockAttempts.get(file) });
      lockAttempts.delete(file);
    }
  };
  return handle;
};
syncBuiltinESMExports();
registerHooks({
  load(url, options, nextLoad) {
    const loaded = nextLoad(url, options);
    if (loaded.format !== "module" || !loaded.source) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    return { ...loaded, source: instrumentCapacityModule(url, source) };
  },
});

/** Synchronous flush runs outside the write window, including explicit CLI exit. */
function flush(): void {
  writeFileSync(path.join(directory!, `${process.pid}.json`), JSON.stringify({ overflow, records }));
}
process.on("exit", flush);
process.on("message", (message: unknown) => {
  if (message === "capacity-trace-flush") { flush(); process.send?.({ capacity_trace_flushed: true }); }
});
