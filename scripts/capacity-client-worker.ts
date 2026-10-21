/** Each worker drains independent real HTTP sockets and records its own receipt timestamps. */
import { parentPort, workerData } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { capacitySubscriber, type CapacityObservation } from "./capacity-subscriber.ts";
import { waitUntil } from "./capacity-wait.ts";
import type { CapacityClientCommand, CapacityClientConfig, CapacityClientSnapshot } from "./capacity-clients.ts";

const port = parentPort!;
if (!port) throw new Error("Capacity client workers require an owned parent channel");
const config = workerData as CapacityClientConfig;
const streams: Awaited<ReturnType<typeof capacitySubscriber>>[] = [];
const observation: CapacityObservation = { open: false };
const stop = new AbortController();
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let nextSession = 0;

/** Snapshot exact per-socket receipts; parser cache contents and credentials never leave the worker. */
function snapshot(): CapacityClientSnapshot {
  return { states: streams.map((stream) => stream.state), loop_p99_ms: histogram.percentile(99) / 1e6,
    cache: { hits: observation.presenceCacheHits ?? 0, misses: observation.presenceCacheMisses ?? 0,
      retained_frames: observation.presenceCounts?.size ?? 0, retained_text_bytes: observation.presenceBytes ?? 0 } };
}

/** Transport errors cross the boundary as public-safe codes, never messages or URLs. */
function failure(error: unknown): { name: string; code: string | null } {
  return { name: error instanceof Error ? error.name : typeof error,
    code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null };
}

/** Refill the assigned share of global startup slots while keeping every accepted socket open. */
async function connect(): Promise<void> {
  const end = config.manualJoin ? Math.min(nextSession + config.concurrency, config.sessions.length) : config.sessions.length;
  const indices = new Map(config.indices);
  /** One startup lane performs no parallel database or HTTP request of its own. */
  const lane = async (): Promise<void> => {
    while (!stop.signal.aborted) {
      if (streams.some((stream) => stream.state.disconnected)) throw Object.assign(new Error("A setup stream disconnected"), { code: "SSE_SETUP_DISCONNECTED" });
      if (nextSession >= end) return;
      const index = nextSession++;
      streams.push(await capacitySubscriber(config.url, config.sessions[index], indices, config.writes, observation, config.startupMs));
      if (streams.length % 50 === 0 || streams.length === config.sessions.length) port.postMessage({ opened: streams.length });
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, lane));
  if (!stop.signal.aborted) port.postMessage({ ready: !config.manualJoin, opened: streams.length });
}

/** Start receipt recording only after the parent has observed the full project population. */
async function command(message: CapacityClientCommand): Promise<void> {
  if (message.action === "join") {
    await connect();
  } else if (message.action === "presence") {
    await waitUntil(() => stop.signal.aborted || streams.some((stream) => stream.state.disconnected) || streams.every((stream) => stream.state.presenceUsers === config.population), config.presenceMs ?? 45_000, "complete project presence snapshot");
    if (stop.signal.aborted || streams.some((stream) => stream.state.disconnected)) throw Object.assign(new Error("A setup stream disconnected"), { code: "SSE_SETUP_DISCONNECTED" });
  } else if (message.action === "begin") {
    histogram.reset(); histogram.enable(); Object.assign(observation, { open: true });
  } else if (message.action === "end") { Object.assign(observation, { open: false }); histogram.disable(); }
  else if (message.action === "close") {
    stop.abort(); Object.assign(observation, { open: false });
    await Promise.allSettled(streams.map((stream) => stream.close()));
    histogram.disable();
  }
  port.postMessage({ id: message.id, snapshot: snapshot() });
  if (message.action === "close") port.close();
}

port.on("message", (message: CapacityClientCommand) => { void command(message).catch((error: unknown) => { port.postMessage({ id: message.id, error: failure(error) }); }); });
if (config.manualJoin) port.postMessage({ ready: true, opened: 0 });
else void connect().catch((error: unknown) => { stop.abort(); port.postMessage({ error: failure(error), opened: streams.length }); });
