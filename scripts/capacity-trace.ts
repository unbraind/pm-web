/** Test-only source probes and stage accounting; never imported by the production server. */
import { distribution, type CapacitySubscriber, type CapacityWrite } from "./capacity-metrics.ts";

/** One bounded synthetic timing observation, using the same host clock as receipts. */
export interface CapacityTrace {
  stage: string;
  itemId: string;
  at: number;
  start?: number;
  clientId?: string;
}

const probe = 'globalThis[Symbol.for("pm-web.capacity.trace")]';

/** Fail closed when a source probe no longer matches the pinned implementation. */
function replaceProbe(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw new Error("Capacity trace source anchor changed");
  return source.replace(anchor, replacement);
}

/**
 * Add probes only to modules loaded by an explicitly traced test child. Source anchors
 * are checked exactly once, making a source/pin drift an inconclusive run, never a
 * silent attribution gap. Neither tracked dist files nor dependencies are modified.
 */
export function instrumentCapacityModule(url: string, source: string): string {
  if (url.endsWith("/dist/services/mutation-replay.js")) {
    source = replaceProbe(source, "const page = await listMutationEvents", "const capacityReadStarted = performance.timeOrigin + performance.now();\n            const page = await listMutationEvents");
    source = replaceProbe(source, "yield { ...event, cursor: boundary };", `${probe}("classified", event.item_id, { start: capacityReadStarted });\n                yield { ...event, cursor: boundary };`);
  } else if (url.endsWith("/dist/services/sse.js")) {
    source = replaceProbe(source, "export function deliverProjectEvent(projectId, event) {", `export function deliverProjectEvent(projectId, event) {\n    ${probe}.event("broadcast", event);`);
    const payload = 'const payload = `event: ${event.type}\\ndata: ${JSON.stringify(event.data)}\\n\\n`;';
    source = replaceProbe(source, payload, `${payload}\n    ${probe}.event("serialized", event);`);
    // Only the delivery function has an event parameter; presence has its own loop.
    const begin = source.indexOf("export function deliverProjectEvent(");
    const end = source.indexOf("export function broadcastPresence(", begin);
    const delivery = replaceProbe(source.slice(begin, end), "client.res.write(payload);", `const capacityWriteStarted = performance.timeOrigin + performance.now();\n            client.res.write(payload);\n            ${probe}.event("write", event, { clientId: client.id, start: capacityWriteStarted });`);
    source = source.slice(0, begin) + delivery + source.slice(end);
  }
  return source;
}

/**
 * Decompose each first delivery. A read already in flight at append visibility has
 * zero polling wait; its overlapping read/classification interval starts at append.
 * HTTP routes announce directly and therefore have no watcher read stage. Missing
 * probes and negative clocks fail the experiment rather than shrinking populations.
 */
export function stageSummary(writes: readonly CapacityWrite[], subscribers: readonly CapacitySubscriber[], traces: readonly CapacityTrace[]) {
  const output: Record<string, Record<string, ReturnType<typeof distribution>>> = {};
  for (const transport of ["http", "cli"] as const) {
    const samples = new Map<string, number[]>();
    /** Preserve even small negative clock discrepancies instead of clamping latency. */
    const add = (stage: string, start: number, end: number): void => {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw Object.assign(new Error("Invalid capacity stage clock"), { code: `TRACE_CLOCK_${stage}` });
      const values = samples.get(stage) ?? [];
      values.push(end - start);
      samples.set(stage, values);
    };
    for (const write of writes.filter((entry) => entry.transport === transport && entry.committedAt !== null)) {
      const events = traces.filter((entry) => entry.itemId === write.itemId).sort((a, b) => a.at - b.at);
      /** Select one mandatory event without silently dropping incomplete probes. */
      const first = (stage: string): CapacityTrace => {
        const found = events.find((entry) => entry.stage === stage && entry.at >= write.committedAt!);
        if (!found) throw Object.assign(new Error(`Missing capacity stage: ${stage}`), { code: `TRACE_MISSING_${stage}` });
        return found;
      };
      const history = first("history-written");
      const broadcast = first("broadcast");
      const serialized = first("serialized");
      add("timestamp_to_history_append", write.committedAt!, history.at);
      for (const lock of events.filter((entry) => entry.stage === "index-lock" && entry.at >= write.committedAt! && entry.at <= history.at)) add("index_lock_wait_nested_in_append", lock.start!, lock.at);
      if (transport === "cli") {
        const classified = first("classified");
        const readStart = Math.max(history.at, classified.start!);
        add("append_to_detecting_poll", history.at, readStart);
        add("detecting_read_and_classification", readStart, classified.at);
        add("classification_to_broadcast", classified.at, broadcast.at);
      } else add("append_to_route_broadcast", history.at, broadcast.at);
      add("broadcast_serialization", broadcast.at, serialized.at);
      for (const subscriber of subscribers) {
        if (!subscriber.counts[write.sequence]) continue;
        const sent = events.find((entry) => entry.stage === "write" && entry.clientId === subscriber.clientId);
        if (!sent) throw Object.assign(new Error("Missing subscriber write probe"), { code: "TRACE_MISSING_CLIENT_WRITE" });
        add("fanout_queue_to_client_write", serialized.at, sent.start!);
        add("client_write_call", sent.start!, sent.at);
        add("write_return_to_client_receive", sent.at, subscriber.receivedAt[write.sequence]);
      }
    }
    output[transport] = Object.fromEntries([...samples].map(([stage, values]) => [stage, distribution(values)]));
  }
  return output;
}

/** Correlate each write's slowest first receipt with its own append, rather than adding unrelated stage quantiles. */
export function traceCriticalPaths(writes: readonly CapacityWrite[], subscribers: readonly CapacitySubscriber[], traces: readonly CapacityTrace[]) {
  return writes.filter((write) => write.committedAt !== null && subscribers.every((subscriber) => subscriber.counts[write.sequence] > 0)).map((write) => {
    const events = traces.filter((event) => event.itemId === write.itemId && event.at >= write.committedAt!);
    const append = events.find((event) => event.stage === "history-written")!;
    const broadcast = events.find((event) => event.stage === "broadcast")!;
    const slowest = subscribers.reduce((left, right) => left.receivedAt[write.sequence] >= right.receivedAt[write.sequence] ? left : right);
    const sent = events.find((event) => event.stage === "write" && event.clientId === slowest.clientId)!;
    return { sequence: write.sequence, transport: write.transport, to_all_ms: slowest.receivedAt[write.sequence] - write.committedAt!,
      timestamp_to_append_ms: append.at - write.committedAt!, append_to_broadcast_ms: broadcast.at - append.at,
      broadcast_to_write_return_ms: sent.at - broadcast.at, write_return_to_receive_ms: slowest.receivedAt[write.sequence] - sent.at };
  }).sort((a, b) => b.to_all_ms - a.to_all_ms);
}
