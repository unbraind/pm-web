/** Lightweight independent SSE readers shared by direct tests and load-generator workers. */
import type { CapacitySubscriber } from "./capacity-metrics.ts";
import { waitUntil } from "./capacity-wait.ts";

/** Reader observations share only parsing work; receipt state remains independent per socket. */
export interface CapacityObservation {
  open: boolean;
  presenceCounts?: Map<string, number>;
  presenceBytes?: number;
  presenceCacheHits?: number;
  presenceCacheMisses?: number;
}

/** Parse identical roster content once, retaining at most 128 complete snapshots within a 64 MiB text budget. */
function presencePopulation(frame: string, observation: CapacityObservation): number {
  const counts = observation.presenceCounts ?? new Map<string, number>();
  observation.presenceCounts = counts;
  let count = counts.get(frame);
  if (count === undefined) {
    observation.presenceCacheMisses = (observation.presenceCacheMisses ?? 0) + 1;
    count = frame.match(/"userId":/g)?.length ?? 0;
    const bytes = frame.length * 2;
    let retained = observation.presenceBytes ?? 0;
    while (counts.size && (counts.size >= 128 || retained + bytes > 64 * 1024 * 1024)) {
      const first = counts.keys().next().value!;
      retained -= first.length * 2;
      counts.delete(first);
    }
    observation.presenceBytes = retained;
    if (bytes <= 64 * 1024 * 1024) { counts.set(frame, count); observation.presenceBytes = retained + bytes; }
  } else observation.presenceCacheHits = (observation.presenceCacheHits ?? 0) + 1;
  return count;
}

/** Open an independent authenticated HTTP SSE socket and record only the experiment's item mutations. */
export async function capacitySubscriber(url: string, headers: Record<string, string>, indices: ReadonlyMap<string, number>, writes: number, observation: CapacityObservation, startupMs = 15_000) {
  const state: CapacitySubscriber = { receivedAt: new Float64Array(writes), counts: new Uint32Array(writes), disconnected: false };
  const controller = new AbortController();
  let connected = false;
  let startupExpired = false;
  const startup = setTimeout(() => { startupExpired = true; controller.abort(); }, startupMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status !== 200 || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const failure = response.status === 500 ? await response.text() : "";
      const phase = failure.includes("Failed to verify project for real-time sync") ? "_VERIFY"
        : failure.includes("Failed to initialize real-time presence") ? "_PRESENCE" : "";
      throw Object.assign(new Error("SSE subscription was rejected"), { code: `SSE_HTTP_${response.status}${phase}` });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const reading = (async () => {
      let pending = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          const frames = pending.split("\n\n");
          pending = frames.pop()!;
          for (const frame of frames) {
            const dataAt = frame.indexOf("\ndata:");
            const header = dataAt < 0 ? frame : frame.slice(0, dataAt);
            const cursor = /^id: (.+)$/m.exec(header)?.[1];
            if (cursor) state.lastEventId = cursor;
            const type = /^event: (.+)$/m.exec(header)?.[1];
            if (type === "presence") state.presenceUsers = presencePopulation(frame, observation);
            if (type === "connected") {
              connected = true;
              state.clientId = (JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "{}") as { clientId: string }).clientId;
            }
            if (type === "item-updated" || type === "workspace-changed") {
              const data = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "{}") as { itemId?: string };
              const index = data.itemId === undefined ? undefined : indices.get(data.itemId);
              if (index !== undefined && observation.open) {
                if (state.counts[index] === 0) state.receivedAt[index] = performance.timeOrigin + performance.now();
                state.counts[index] += 1;
              }
            }
          }
          if (pending.length > 1024 * 1024) throw new Error("Oversized SSE frame");
        }
        if (!controller.signal.aborted) state.disconnected = true;
      } catch { if (!controller.signal.aborted) state.disconnected = true; }
    })();
    await waitUntil(() => connected || state.disconnected, startupMs, "SSE connected frame");
    if (startupExpired) throw Object.assign(new Error("SSE startup deadline exceeded"), { code: "SSE_STARTUP_TIMEOUT" });
    if (!connected || state.disconnected) throw Object.assign(new Error("SSE disconnected during startup"), { code: "SSE_STARTUP_DISCONNECTED" });
    clearTimeout(startup);
    return { state, close: async () => { controller.abort(); await reader.cancel().catch(() => {}); await reading; } };
  } catch (error) {
    clearTimeout(startup); controller.abort();
    if (startupExpired) throw Object.assign(new Error("SSE startup deadline exceeded"), { code: "SSE_STARTUP_TIMEOUT" });
    throw error;
  }
}

