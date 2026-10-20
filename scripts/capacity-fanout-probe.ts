/** Test-only CPU/serialization probes, installed through the private capacity child preload. */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { parse } from "@babel/parser";

/** Synchronous service CPU excludes scheduler wait, database await time, and network transit. */
export interface FanoutMeasurement {
  cpu_us: number;
  turn_cpu_us: number;
  serialized_bytes: number;
  json_bytes: number;
  mutation_events: number;
  mutation_frame_bytes: number;
  mutation_json_bytes: number;
  delivered_mutations: number;
  prepared_events: number;
  response_writes: number;
  delivered_events: number;
}
const totals: FanoutMeasurement = { cpu_us: 0, turn_cpu_us: 0, serialized_bytes: 0, json_bytes: 0, mutation_events: 0, mutation_frame_bytes: 0, mutation_json_bytes: 0, delivered_mutations: 0, prepared_events: 0, response_writes: 0, delivered_events: 0 };
const frameCounts = new Map<string | Buffer, { frames: number; mutations: number }>();
let depth = 0;
let completion: NodeJS.Immediate | undefined;
const observer = {
  /** Nested drain calls belong to the enclosing batch, never counted twice. */
  enter: () => {
    if (!completion) {
      const start = process.cpuUsage();
      completion = setImmediate(() => {
        const used = process.cpuUsage(start);
        totals.turn_cpu_us += used.user + used.system;
        completion = undefined;
      });
      completion.unref();
    }
    return depth++ === 0 ? process.cpuUsage() : undefined;
  },
  /** Charge only synchronous CPU used inside service code. */
  leave: (start?: NodeJS.CpuUsage) => { depth -= 1; if (start) { const used = process.cpuUsage(start); totals.cpu_us += used.user + used.system; } },
  /** Count actual UTF-8 frame bytes once, independently of recipient count. */
  serialized: (payload: string | Buffer) => {
    const text = String(payload);
    const bytes = Buffer.byteLength(payload);
    const jsonBytes = Buffer.byteLength(/^data: (.+)$/m.exec(text)?.[1] ?? "");
    totals.prepared_events += 1;
    totals.serialized_bytes += bytes;
    totals.json_bytes += jsonBytes;
    if (/"itemId":"capacity-write-\d+"/.test(text)) {
      totals.mutation_events += 1;
      totals.mutation_frame_bytes += bytes;
      totals.mutation_json_bytes += jsonBytes;
    }
  },
  /** Count response calls rather than pretending each callback means a network receipt. */
  write: (payload: string | Buffer) => {
    if (typeof payload === "string" ? !payload.startsWith("event: ") : payload[0] !== 101) return;
    totals.response_writes += 1;
    let count = frameCounts.get(payload);
    if (count === undefined) {
      const text = String(payload);
      count = { frames: text.match(/^event: /gm)?.length ?? 0, mutations: text.match(/"itemId":"capacity-write-\d+"/g)?.length ?? 0 };
      frameCounts.set(payload, count);
    }
    totals.delivered_events += count.frames;
    totals.delivered_mutations += count.mutations;
  },
};
const probe = 'globalThis[Symbol.for("pm-web.capacity.fanout")]';
Reflect.set(globalThis, Symbol.for("pm-web.capacity.fanout"), observer);

/** Add checked CPU boundaries and encoding counters to baseline or candidate compiled service code. */
export function instrumentFanoutCpu(source: string, baseline: boolean): string {
  const parsed = parse(source, { sourceType: "module" });
  const names = new Set(baseline ? ["deliverProjectEvent", "broadcastPresence"] : ["prepareFanout", "writeFanoutBatch"]);
  const edits: { at: number; text: string }[] = [];
  for (const node of parsed.program.body) {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (declaration?.type !== "FunctionDeclaration" || !declaration.id || !names.delete(declaration.id.name)) continue;
    edits.push({ at: declaration.body.start! + 1, text: `\nconst capacityCpu = ${probe}.enter(); try {\n` });
    edits.push({ at: declaration.body.end! - 1, text: `\n} finally { ${probe}.leave(capacityCpu); }\n` });
  }
  if (names.size) throw new Error("Fanout CPU probe source drift");
  for (const edit of edits.sort((a, b) => b.at - a.at)) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  if (baseline && source.includes("prepareFanout(projectId, event)")) return source;
  const anchor = baseline ? '  for (const client of set) {' : '    state.frames.push({ sequence, payload, at: Date.now() });';
  // TypeScript's emitted indentation is four spaces; the baseline loop also appears in presence.
  const actual = baseline ? '    for (const client of set) {' : anchor;
  const index = source.indexOf(actual, source.indexOf(baseline ? "export function deliverProjectEvent" : "export function prepareFanout"));
  if (index < 0) throw new Error("Fanout encoding probe source drift");
  source = source.slice(0, index) + `${probe}.serialized(payload);\n` + source.slice(index);
  if (baseline) {
    const presence = source.indexOf("export function broadcastPresence");
    const loop = source.indexOf("    for (const client of set) {", presence);
    if (loop < 0) throw new Error("Fanout presence probe source drift");
    source = source.slice(0, loop) + `${probe}.serialized(payload);\n` + source.slice(loop);
  }
  return source.replaceAll(baseline ? "client.res.write(payload);" : "viewer.bytes -= payload.length;", baseline ? `${probe}.write(payload); client.res.write(payload);` : `viewer.bytes -= payload.length; ${probe}.write(payload);`);
}

registerHooks({
  load(url, options, nextLoad) {
    let loaded = nextLoad(url, options);
    const baselineRoot = process.env.PM_WEB_CAPACITY_BASELINE_DIR;
    const baselineModule = url.endsWith("/dist/services/sse.js") || url.endsWith("/dist/routes/pm.js");
    if (baselineRoot && baselineModule) loaded = { ...loaded, source: readFileSync(path.join(baselineRoot, url.endsWith("/sse.js") ? "sse.js" : "pm.js"), "utf8") };
    if (!loaded.source) return loaded;
    const baseline = !!baselineRoot;
    const service = url.endsWith("/dist/services/sse.js");
    const selected = service || (!baseline && url.endsWith("/dist/services/sse-fanout.js"));
    if (!selected) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    return { ...loaded, source: instrumentFanoutCpu(source, service) };
  },
});

/** Return a copy so IPC cannot observe later mutations. */
export function fanoutMeasurement(): FanoutMeasurement { return { ...totals }; }
/** Reset immediately before the experiment's writers start. */
export function resetFanoutMeasurement(): void { clearImmediate(completion); completion = undefined; frameCounts.clear(); for (const key of Object.keys(totals) as (keyof FanoutMeasurement)[]) totals[key] = 0; }
