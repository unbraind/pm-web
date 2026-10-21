/** Independent client event loops prevent the generator from starving its own sockets. */
import { Worker } from "node:worker_threads";
import type { CapacitySubscriber } from "./capacity-metrics.ts";

/** Synthetic connection inputs for one bounded group of real network clients. */
export interface CapacityClientConfig {
  url: string;
  sessions: Record<string, string>[];
  indices: [string, number][];
  writes: number;
  population: number;
  concurrency: number;
  startupMs?: number;
  presenceMs?: number;
  perWorker?: number;
  manualJoin?: boolean;
}

/** Only receipt state and aggregate parser resources cross the worker boundary. */
export interface CapacityClientSnapshot {
  states: CapacitySubscriber[];
  loop_p99_ms: number;
  cache: { hits: number; misses: number; retained_frames: number; retained_text_bytes: number };
}

/** Commands cannot modify the server, tracker, identities or measured item mapping. */
export interface CapacityClientCommand { id: number; action: "join" | "presence" | "begin" | "end" | "snapshot" | "close" }
interface Reply { id?: number; ready?: boolean; opened?: number; snapshot?: CapacityClientSnapshot; error?: { name: string; code: string | null } }

/** One group exposes the same receipt window to the unchanged mixed-writer harness. */
export interface CapacityClientGroup {
  ready: Promise<void>;
  workers: number;
  opened: () => number;
  join: () => Promise<void>;
  presence: () => Promise<void>;
  begin: () => Promise<void>;
  end: () => Promise<CapacitySubscriber[]>;
  snapshot: () => Promise<CapacitySubscriber[]>;
  cache: () => CapacityClientSnapshot["cache"];
  loopDelays: () => number[];
  close: () => Promise<void>;
}

/** Start at most six event loops, each normally owning no more than 500 sockets. */
export function createCapacityClients(config: CapacityClientConfig, progress?: (opened: number) => void): CapacityClientGroup {
  if (!config.sessions.length || config.concurrency < 1) throw new Error("Capacity clients need sessions and startup slots");
  const count = Math.min(6, config.sessions.length, config.concurrency, Math.ceil(config.sessions.length / (config.perWorker ?? 500)));
  const size = Math.ceil(config.sessions.length / count);
  const opened = Array.from({ length: count }, () => 0);
  const closing = new AbortController();
  let latest: CapacityClientSnapshot[] = [];
  const channels = Array.from({ length: count }, (_, index) => {
    const sessions = config.sessions.slice(index * size, (index + 1) * size);
    const concurrency = Math.min(sessions.length, Math.floor(config.concurrency / count) + (index < config.concurrency % count ? 1 : 0));
    const worker = new Worker(new URL("./capacity-client-worker.ts", import.meta.url), { execArgv: [], workerData: { ...config, sessions, concurrency } });
    let resolveReady: () => void = () => {}, rejectReady: (reason: Error) => void = () => {}, sequence = 0;
    const ended = new AbortController();
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const pending = new Map<number, { resolve: (value: CapacityClientSnapshot) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
    /** Reject every outstanding command before a failed worker can look like an empty success. */
    const fail = (error: Error): void => {
      rejectReady(error);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    };
    worker.on("message", (message: Reply) => {
      if (typeof message.opened === "number") { opened[index] = message.opened; progress?.(opened.reduce((sum, value) => sum + value, 0)); }
      if (message.ready) resolveReady();
      const error = message.error ? Object.assign(new Error("Capacity client worker failed"), { name: message.error.name, code: message.error.code }) : undefined;
      if (error && message.id === undefined) { fail(error); return; }
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (error) entry.reject(error);
      else if (message.snapshot) entry.resolve(message.snapshot);
      else entry.reject(new Error("Capacity client reply omitted receipts"));
    });
    worker.on("error", (error: unknown) => { ended.abort(); fail(error instanceof Error ? error : new Error("Capacity client worker failed")); });
    worker.on("exit", () => { ended.abort(); if (!closing.signal.aborted) fail(Object.assign(new Error("Capacity client worker exited"), { code: "SSE_WORKER_EXIT" })); });
    /** Acknowledged commands bound readiness and never infer receipts from elapsed time. */
    const request = (action: CapacityClientCommand["action"]): Promise<CapacityClientSnapshot> => new Promise((resolve, reject) => {
      if (ended.signal.aborted) { reject(Object.assign(new Error("Capacity client worker exited"), { code: "SSE_WORKER_EXIT" })); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Capacity client reply deadline exceeded"), { code: "SSE_WORKER_REPLY_TIMEOUT" })); }, Math.max(config.startupMs ?? 15_000, config.presenceMs ?? 45_000) + 5000);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, action }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    return { worker, ready, request, fail };
  });
  /** Keep per-thread event-loop p99 values separate rather than inventing a pooled percentile. */
  const collect = async (action: CapacityClientCommand["action"]): Promise<CapacitySubscriber[]> => {
    latest = await Promise.all(channels.map((channel) => channel.request(action)));
    return latest.flatMap((snapshot) => snapshot.states);
  };
  return {
    ready: Promise.all(channels.map((channel) => channel.ready)).then(() => {}), workers: count,
    opened: () => opened.reduce((sum, value) => sum + value, 0),
    join: async () => { await collect("join"); },
    presence: async () => { await collect("presence"); },
    begin: async () => { await collect("begin"); },
    end: () => collect("end"), snapshot: () => collect("snapshot"),
    cache: () => latest.reduce((sum, snapshot) => ({ hits: sum.hits + snapshot.cache.hits, misses: sum.misses + snapshot.cache.misses,
      retained_frames: sum.retained_frames + snapshot.cache.retained_frames, retained_text_bytes: sum.retained_text_bytes + snapshot.cache.retained_text_bytes }), { hits: 0, misses: 0, retained_frames: 0, retained_text_bytes: 0 }),
    loopDelays: () => latest.map((snapshot) => snapshot.loop_p99_ms),
    /** Terminate only owned client threads after bounded graceful cancellation of their sockets. */
    close: async () => {
      closing.abort();
      const grace = Promise.allSettled(channels.map((channel) => channel.request("close")));
      let deadline: NodeJS.Timeout | undefined;
      try { await Promise.race([grace, new Promise<void>((resolve) => { deadline = setTimeout(resolve, 3000); })]); }
      finally {
        clearTimeout(deadline);
        await Promise.all(channels.map(async (channel) => { channel.fail(new Error("Capacity client group closed")); await channel.worker.terminate(); }));
      }
    },
  };
}
