#!/usr/bin/env node
/** Reproducible loopback-only capacity ladder using the package's disposable real-Postgres harness. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, totalmem, tmpdir, loadavg, freemem } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { capacityFixture, capacityPm, capacityServer, waitUntil, type CapacityProbe } from "./capacity-fixture.ts";
import { deliverySummary, distribution, type CapacitySubscriber, type CapacityWrite } from "./capacity-metrics.ts";
import { isMainInvocation } from "./main-invocation.ts";
import { stageSummary, traceCriticalPaths, traceDeliveries, type CapacityTrace } from "./capacity-trace.ts";

/** Bounded workload configuration; the CLI always builds before running it. */
export interface CapacityOptions {
  idleMs?: number;
  warmupMs?: number;
  setupConcurrency?: number;
  trace?: boolean;
  rungs: number[];
  writers: number;
  writesPerWriter: number;
  sloMs: number;
  drainMs: number;
}

/** Reject accidental overload and invalid configurations before allocating a fixture. */
export function capacityOptions(args: string[]): CapacityOptions & { output?: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!["--rungs", "--writers", "--writes-per-writer", "--slo-ms", "--drain-ms", "--output", "--trace", "--idle-ms", "--warmup-ms", "--setup-concurrency"].includes(key) || !value || values.has(key)) throw new Error("Unknown, repeated or incomplete capacity option");
    values.set(key, value);
  }
  const options = {
    rungs: (values.get("--rungs") ?? "100,1000,3000").split(",").map(Number),
    writers: Number(values.get("--writers") ?? 10), writesPerWriter: Number(values.get("--writes-per-writer") ?? 5),
    sloMs: Number(values.get("--slo-ms") ?? 2000), drainMs: Number(values.get("--drain-ms") ?? 4000),
    output: values.get("--output"),
    trace: values.get("--trace") === "true",
    idleMs: Number(values.get("--idle-ms") ?? 0),
    setupConcurrency: values.has("--setup-concurrency") ? Number(values.get("--setup-concurrency")) : undefined,
    warmupMs: values.has("--warmup-ms") ? Number(values.get("--warmup-ms")) : undefined,
  };
  if (values.has("--trace") && !["true", "false"].includes(values.get("--trace")!)) throw new Error("Trace must be true or false");
  validateOptions(options);
  return options;
}

/** Keep measured populations and memory bounded even when invoked through the exported runner. */
function validateOptions(options: CapacityOptions): void {
  if (options.setupConcurrency !== undefined && (!Number.isInteger(options.setupConcurrency) || options.setupConcurrency < 1 || options.setupConcurrency > 50)) throw new Error("Setup concurrency must be between 1 and 50");
  if (options.warmupMs !== undefined && (!Number.isInteger(options.warmupMs) || options.warmupMs < 15_000 || options.warmupMs > 120_000)) throw new Error("Warm-up must be between 15 and 120 seconds");
  if (!Number.isInteger(options.idleMs ?? 0) || (options.idleMs ?? 0) < 0 || (options.idleMs ?? 0) > 120_000) throw new Error("Idle observation must be between zero and 120 seconds");
  if (options.rungs.length === 0 || options.rungs.some((n, i) => !Number.isInteger(n) || n < 1 || n > 3000 || (i > 0 && n <= options.rungs[i - 1]))) throw new Error("Rungs must increase from 1 through 3000");
  if (!Number.isInteger(options.writers) || options.writers < 2 || options.writers > 32) throw new Error("Writers must be between 2 and 32");
  if (!Number.isInteger(options.writesPerWriter) || options.writesPerWriter < 1 || options.writesPerWriter > 100) throw new Error("Writes per writer must be between 1 and 100");
  if (!Number.isInteger(options.sloMs) || options.sloMs < 1 || options.sloMs > 60_000 || !Number.isInteger(options.drainMs) || options.drainMs < options.sloMs || options.drainMs > 120_000) throw new Error("Drain must cover the positive SLO, with a maximum of 120 seconds");
}

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
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const reading = (async () => {
      let pending = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += chunk.value;
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
    if (!connected) throw Object.assign(new Error("SSE disconnected during startup"), { code: "SSE_STARTUP_DISCONNECTED" });
    clearTimeout(startup);
    return { state, close: async () => { controller.abort(); await reading; } };
  } catch (error) {
    clearTimeout(startup); controller.abort();
    if (startupExpired) throw Object.assign(new Error("SSE startup deadline exceeded"), { code: "SSE_STARTUP_TIMEOUT" });
    throw error;
  }
}

/** Read the authoritative committed update, rather than using response/exit time as a commit proxy. */
async function committedTime(dir: string, itemId: string): Promise<number> {
  const text = await readFile(path.join(dir, ".agents/pm/history", `${itemId}.jsonl`), "utf8");
  const entries = text.trim().split("\n").map((line) => JSON.parse(line) as { ts: string; op: string });
  const updates = entries.filter((entry) => entry.op === "update");
  if (updates.length !== 1 || !Number.isFinite(Date.parse(updates[0].ts))) throw new Error("Expected one committed update per measured item");
  return Date.parse(updates[0].ts);
}

/** Exercise one independent rung with unique items, identities and server, always joining cleanup. */
type RungPhase = "setup" | "measurement" | "cleanup";

/** Safe aggregate startup evidence; no request data or fixture identities are retained. */
interface CapacitySetupDiagnostics {
  streams_opened: number;
  streams_disconnected: number;
  presence_populations: Record<string, number>;
  sse_clients: number | null;
  server_probe: CapacityProbe | null;
  host_load: number[];
}

/** A rung failure that remembers the phase it came from. It carries only string-valued identifiers, never messages or request data. */
export class RungFailure extends Error {
  /** The rung phase that was running when the error surfaced. */
  readonly phase: RungPhase;
  /** The error's constructor name (or primitive type), never its message. */
  readonly causeName: string;
  /** The error's string `code` when it had one, such as a system error code. */
  readonly causeCode: string | null;
  /** Aggregate warm-up diagnostics on setup failure only. */
  diagnostics?: CapacitySetupDiagnostics;
  constructor(phase: RungPhase, causeName: string, causeCode: string | null) {
    super(`rung ${phase} failed`);
    this.name = "RungFailure";
    this.phase = phase;
    this.causeName = causeName;
    this.causeCode = causeCode;
  }
}

/** Describe an unknown error by phase, error name and string code only; an already described failure is returned unchanged so the first error wins. */
export function describeRungFailure(error: unknown, phase: RungPhase): RungFailure {
  if (error instanceof RungFailure) return error;
  const causeName = error instanceof Error ? error.name : typeof error;
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
  return new RungFailure(phase, causeName, typeof code === "string" ? code : null);
}

/** A rung passes only with zero loss, zero duplicates, no failed writes or disconnects, p99 within the SLO, a healthy server and no server errors. */
export function rungPassed(input: { lost: number; duplicates: number; failedWrites: number; disconnected: number; p99: number | null; sloMs: number; healthy: boolean; serverErrorKinds: number }): boolean {
  return input.lost === 0 && input.duplicates === 0 && input.failedWrites === 0 && input.disconnected === 0
    && input.p99 !== null && input.p99 <= input.sloMs && input.healthy && input.serverErrorKinds === 0;
}

/**
 * Run one independent ladder rung: seed items, start a server, connect subscribers, drive the
 * mixed writers, and measure delivery. Failures carry their phase; cleanup always runs and a
 * cleanup error never hides the setup or measurement error that preceded it.
 */
async function runRung(subscribers: number, options: CapacityOptions) {
  const setupStarted = performance.now();
  const setupConcurrency = Math.min(options.setupConcurrency ?? 50, subscribers);
  const fixture = await capacityFixture(Math.max(subscribers, options.writers));
  const traceDirectory = options.trace ? path.join(fixture.root, "traces") : undefined;
  let server: Awaited<ReturnType<typeof capacityServer>> | undefined;
  const streams: Awaited<ReturnType<typeof capacitySubscriber>>[] = [];
  const observation: CapacityObservation = { open: false };
  const writes: CapacityWrite[] = Array.from({ length: options.writers * options.writesPerWriter }, (_, sequence) => ({
    sequence, itemId: `capacity-write-${sequence}`, transport: Math.floor(sequence / options.writesPerWriter) < Math.floor(options.writers / 2) ? "http" : "cli", committedAt: null, error: false,
  }));
  const generatorDelay = monitorEventLoopDelay({ resolution: 10 });
  const postgres: { server: number; database: number; max: number }[] = [];
  const sampleState = { inFlight: false, error: false };
  /** Complete a sample synchronously so the guard stays closed across its awaited query. */
  const finishSample = (): void => { sampleState.inFlight = false; };
  /** Preserve a failed telemetry read even if a later sample succeeds. */
  const failSample = (): void => { sampleState.error = true; };
  /** Observe only counts in the selected test database; do not read other sessions' SQL or identity. */
  const sampleDatabase = async (): Promise<void> => {
    if (!server || sampleState.inFlight) return;
    sampleState.inFlight = true;
    try {
      const result = await fixture.database.query<{ server: number; database: number; max: number }>(
        "SELECT count(*) FILTER (WHERE application_name = $1)::int AS server, count(*)::int AS database, current_setting('max_connections')::int AS max FROM pg_stat_activity WHERE datname = current_database()", [server.applicationName]);
      postgres.push(result.rows[0]);
    } catch { failSample(); } finally { finishSample(); }
  };
  let timer: NodeJS.Timeout | undefined;
  let phase: RungPhase = "setup";
  let firstError: RungFailure | null = null;
  let cleanupFailure: RungFailure | null = null;
  const outcome = await (async () => {
    try {
      if (traceDirectory) await mkdir(traceDirectory);
      for (const write of writes) await fixture.client.run("create", { options: { id: write.itemId, title: `Synthetic ${write.sequence}`, type: "Task", description: "Capacity fixture" } });
      server = await capacityServer(fixture.root, fixture.secret, traceDirectory);
      const indices = new Map(writes.map((write) => [write.itemId, write.sequence]));
      let nextConnection = 0;
      const rampAbort = new AbortController();
      /** Refill each accepted slot immediately, keeping the configured number in flight without artificial cohort pauses. */
      const openConnections = async (): Promise<void> => {
        while (!rampAbort.signal.aborted) {
          if (streams.some((stream) => stream.state.disconnected)) {
            rampAbort.abort();
            throw new RungFailure("setup", "DisconnectedStream", "SSE_SETUP_DISCONNECTED");
          }
          const index = nextConnection++;
          if (index >= subscribers) return;
          try {
            streams.push(await capacitySubscriber(`${server!.url}/api/projects/${fixture.projectId}/pm/events?view=items`,
              fixture.sessions[index], indices, writes.length, observation, options.warmupMs));
            if (streams.length % 500 === 0) process.stderr.write(`capacity setup: ${streams.length}/${subscribers} SSE streams connected\n`);
          } catch (error) { rampAbort.abort(); throw error; }
        }
      };
      const ramp = await Promise.allSettled(Array.from({ length: setupConcurrency }, openConnections));
      const rejected = ramp.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        const exit = server.exitState();
        if (exit.signal || exit.code !== null) throw new RungFailure("setup", "ServerExit", `SERVER_EXIT_${exit.signal ?? exit.code}`);
        throw describeRungFailure(rejected.reason, "setup");
      }
      // Drain the final full presence snapshot before resetting CPU/encoding counters.
      await waitUntil(() => streams.every((stream) => stream.state.presenceUsers === subscribers) || streams.some((stream) => stream.state.disconnected), options.warmupMs ?? 45_000, "complete project presence snapshot");
      if (streams.some((stream) => stream.state.disconnected)) throw new RungFailure("setup", "DisconnectedStream", "SSE_SETUP_DISCONNECTED");
      phase = "measurement";
      // Keep the production 15s sweep and 2s subscription reconciliation cadence. Establish the
      // filesystem baseline before writes, avoiding both startup-tail loss and a shortened test cadence.
      let before = await server.health();
      const readyDeadline = performance.now() + 20_000;
      while (before.realtime.watcher_last_sweep_at === null) {
        if (performance.now() > readyDeadline) throw new Error("Production watcher did not baseline");
        await delay(100);
        before = await server.health();
      }
      if (!before.ok || before.realtime.sse_clients !== subscribers) throw new Error("Server was not healthy at the start of writes");
      let idleLocks = null;
      if (options.idleMs) {
        const first = await server.lockCount();
        await delay(options.idleMs);
        const last = await server.lockCount();
        idleLocks = { acquisitions: last.count - first.count, elapsed_ms: last.at - first.at,
          acquisitions_per_second: (last.count - first.count) * 1000 / (last.at - first.at) };
      }
      const setupElapsed = performance.now() - setupStarted;
      const setupReaderCache = { hits: observation.presenceCacheHits ?? 0, misses: observation.presenceCacheMisses ?? 0,
        retained_frames: observation.presenceCounts?.size ?? 0, retained_text_bytes: observation.presenceBytes ?? 0 };
      await server.begin();
      const hostLoadBefore = loadavg();
      generatorDelay.enable();
      const startCpu = process.cpuUsage();
      const started = performance.now();
      Object.assign(observation, { open: true });
      await sampleDatabase();
      timer = setInterval(() => { void sampleDatabase(); }, 500);
      // W concurrent lanes; each lane mutates independent items sequentially. Odd W gives CLI the extra lane.
      await Promise.all(Array.from({ length: options.writers }, async (_, writer) => {
        for (const write of writes.slice(writer * options.writesPerWriter, (writer + 1) * options.writesPerWriter)) {
          write.requestedAt = Date.now();
          try {
            if (write.transport === "cli") await capacityPm(fixture.dir, ["update", write.itemId, "--title", `Committed ${write.sequence}`], traceDirectory);
            else {
              const response = await fetch(`${server!.url}/api/projects/${fixture.projectId}/pm/update/${write.itemId}`, {
                method: "PATCH", headers: { ...fixture.sessions[writer], "content-type": "application/json" },
                body: JSON.stringify({ title: `Committed ${write.sequence}` }), signal: AbortSignal.timeout(20_000),
              });
              await response.arrayBuffer();
              if (response.status !== 200) throw new Error("HTTP write failed");
            }
          } catch { write.error = true; }
        }
      }));
      // Full grace window also catches duplicates arriving after the last expected delivery.
      await delay(options.drainMs);
      Object.assign(observation, { open: false });
      const elapsed = performance.now() - started;
      const cpu = process.cpuUsage(startCpu);
      const generatorP99 = generatorDelay.percentile(99) / 1e6;
      generatorDelay.disable();
      clearInterval(timer);
      await waitUntil(() => !sampleState.inFlight, 6000, "database sample completion");
      await sampleDatabase();
      const after = await server.health();
      // Inspect successful AND failed acknowledgements: a timeout can still have committed.
      for (const write of writes) {
        try { write.committedAt = await committedTime(fixture.dir, write.itemId); }
        catch { write.error = true; }
      }
      const indexedIds = new Set<string>();
      let indexSource = "";
      let cursor: string | undefined;
      for (;;) {
        const indexed = await listMutationEvents({ pmRoot: path.join(fixture.dir, ".agents/pm"), type: "update", item: writes.map((write) => write.itemId), limit: 1000, since: cursor });
        indexSource = indexed.source;
        for (const event of indexed.events) indexedIds.add(event.item_id);
        if (!indexed.has_more) break;
        if (!indexed.next_cursor || indexed.next_cursor === cursor) throw new Error("Event audit pagination made no progress");
        cursor = indexed.next_cursor;
      }
      const delivery = deliverySummary(writes, streams.map((stream) => stream.state));
      let stages = null;
      let criticalPaths = null;
      let tracedDeliveries = null;
      if (traceDirectory) {
        await server.flushTrace();
        const traces: CapacityTrace[] = [];
        for (const file of await readdir(traceDirectory)) {
          const batch = JSON.parse(await readFile(path.join(traceDirectory, file), "utf8")) as { overflow: boolean; records: CapacityTrace[] };
          if (batch.overflow) throw new Error("Capacity trace overflow");
          for (const record of batch.records) traces.push(record);
        }
        stages = stageSummary(writes, streams.map((stream) => stream.state), traces);
        criticalPaths = traceCriticalPaths(writes, streams.map((stream) => stream.state), traces);
        tracedDeliveries = traceDeliveries(writes, traces);
      }
      if (!server.samples.length || !postgres.length || sampleState.error) throw Object.assign(new Error("Resource measurements are incomplete"), { code: !server.samples.length ? "MISSING_SERVER_PROBE" : !postgres.length ? "MISSING_DATABASE_PROBE" : "DATABASE_PROBE_ERROR" });
      await server.sample();
      const fanout = server.samples.at(-1)!.fanout;
      const resources = {
        fanout: { ...fanout, cpu_us_per_delivery: fanout.cpu_us / fanout.delivered_events, serialized_bytes_per_event: fanout.serialized_bytes / fanout.prepared_events, cpu_us_per_delivered_mutation: fanout.cpu_us / fanout.delivered_mutations, turn_cpu_us_per_delivered_mutation: fanout.turn_cpu_us / fanout.delivered_mutations, mutation_frame_bytes_per_event: fanout.mutation_frame_bytes / fanout.mutation_events, mutation_json_bytes_per_event: fanout.mutation_json_bytes / fanout.mutation_events },
        server_cpu_us: server.samples.at(-1)!.cpu_since_reset_us,
        server_cpu_window_ms: server.samples.at(-1)!.cpu_window_ms,
        server_cpu_us_per_delivered_mutation: server.samples.at(-1)!.cpu_since_reset_us / fanout.delivered_mutations,
        server_rss_peak_bytes: Math.max(...server.samples.map((sample) => sample.rss_bytes)),
        server_cpu_core_percent: distribution(server.samples.map((sample) => sample.cpu_core_percent)),
        server_event_loop_p99_ms: server.samples.at(-1)!.event_loop_p99_ms,
        generator_cpu_core_percent: (cpu.user + cpu.system) / (elapsed * 10), generator_event_loop_p99_ms: generatorP99,
        postgres_server_connections_peak: Math.max(...postgres.map((sample) => sample.server)),
        postgres_database_connections_peak: Math.max(...postgres.map((sample) => sample.database)), postgres_max_connections: postgres[0].max,
        process_samples: server.samples.length, database_samples: postgres.length,
        host_load_average_after: loadavg(), host_free_ram_after_bytes: freemem(),
        host_load_average_before: hostLoadBefore,
      };
      const failedWrites = writes.filter((write) => write.error).length;
      const disconnected = streams.filter((stream) => stream.state.disconnected).length;
      const p99 = delivery.to_every_subscriber_ms.p99;
      const passed = rungPassed({ lost: delivery.lost, duplicates: delivery.duplicates, failedWrites, disconnected, p99, sloMs: options.sloMs, healthy: after.ok, serverErrorKinds: Object.keys(server.errors).length });
      // Attribution is evidence-based and deliberately allows unknown bottlenecks.
      let firstLimit = "none observed";
      if (!passed) {
        if (resources.postgres_database_connections_peak >= resources.postgres_max_connections * 0.9) firstLimit = "Postgres connections (>=90% of configured maximum)";
        else if (resources.server_event_loop_p99_ms > options.sloMs / 2) firstLimit = "server event loop scheduling";
        else if ((resources.server_cpu_core_percent.p95 ?? 0) >= 90) firstLimit = "server CPU (>=90% of one core at p95)";
        else if (generatorP99 > options.sloMs / 2) firstLimit = "load-generator event loop scheduling; server capacity inconclusive";
        else if (freemem() < totalmem() * 0.1) firstLimit = "host available memory (<10% free); attribution inconclusive";
        else if (resources.host_load_average_after[0] > cpus().length * 1.5) firstLimit = "host scheduling or I/O pressure (load average above logical CPU count); cause unproven";
        else firstLimit = "unidentified: observed loss, latency, write failure or unhealthy server without a saturated resource signal";
      }
      return { subscribers, setup_ms: setupElapsed, setup_concurrency: setupConcurrency, setup_reader_cache: setupReaderCache, writers: options.writers, http_writers: Math.floor(options.writers / 2), cli_writers: Math.ceil(options.writers / 2),
        writes: writes.length, committed_writes: writes.filter((write) => write.committedAt !== null).length,
        failed_writes: failedWrites, disconnected_subscribers: disconnected, measured_ms: elapsed,
        ...delivery, idle_index_locks: idleLocks, stages, trace_critical_paths: criticalPaths, trace_deliveries: tracedDeliveries, resources, server_error_counts: { ...server.errors }, health_before: before, health_after: after, passed, first_observed_limit: firstLimit,
        event_index_audit: { source: indexSource, missing_sequences: writes.filter((write) => write.committedAt !== null && !indexedIds.has(write.itemId)).map((write) => write.sequence) },
        write_receipts: writes.map((write) => ({ sequence: write.sequence, transport: write.transport, committed_at: write.committedAt, write_error: write.error })) };
    } catch (error) {
      firstError = describeRungFailure(error, phase);
      if (phase === "setup") {
        const populations: Record<string, number> = {};
        for (const stream of streams) { const count = String(stream.state.presenceUsers ?? "none"); populations[count] = (populations[count] ?? 0) + 1; }
        const health = await server?.health().catch(() => null);
        firstError.diagnostics = { streams_opened: streams.length, streams_disconnected: streams.filter((stream) => stream.state.disconnected).length,
          presence_populations: populations, sse_clients: health?.realtime.sse_clients ?? null, server_probe: server?.samples.at(-1) ?? null, host_load: loadavg() };
      }
      return null;
    } finally {
      try {
        clearInterval(timer);
        generatorDelay.disable();
        await Promise.all(streams.map((stream) => stream.close()));
        await server?.close();
        await waitUntil(() => !sampleState.inFlight, 6000, "database cleanup");
        await fixture.close();
      } catch (cleanupError) {
        // A cleanup failure never hides the measurement or setup failure that preceded it.
        cleanupFailure = describeRungFailure(cleanupError, "cleanup");
      }
    }
  })();
  // The first failure wins; a cleanup failure is reported only when the rung itself succeeded.
  if (firstError !== null) throw firstError;
  if (cleanupFailure !== null) throw cleanupFailure;
  if (outcome === null) throw new RungFailure("measurement", "MissingOutcome", null);
  return outcome;
}

/** Run increasing independent rungs, stopping after the first loss, SLO breach or invalid workload. */
export async function runCapacity(options: CapacityOptions) {
  validateOptions(options);
  const runs: Awaited<ReturnType<typeof runRung>>[] = [];
  const hardware = { logical_cpus: cpus().length, cpu_model: cpus()[0]?.model ?? "unknown", ram_bytes: totalmem(),
    free_ram_before_bytes: freemem(), load_average_before: loadavg(), platform: process.platform, arch: process.arch, node: process.version };
  let failure: { subscribers: number; reason: string; phase: RungPhase; error_name: string; error_code: string | null; diagnostics?: CapacitySetupDiagnostics } | null = null;
  for (const rung of options.rungs) {
    try {
      const run = await runRung(rung, options);
      runs.push(run);
      if (!run.passed) break;
    } catch (error) {
      const described = describeRungFailure(error, "setup");
      failure = { subscribers: rung, reason: `Rung ${described.phase} failed; no capacity claim for this rung`, phase: described.phase, error_name: described.causeName, error_code: described.causeCode, diagnostics: described.diagnostics };
      break;
    }
  }
  return { schema_version: 1, date: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    hardware, options, runs, failure, stopped_early: runs.length < options.rungs.length,
    command: `node scripts/with-test-db.ts node scripts/capacity.ts --rungs ${options.rungs.join(",")} --writers ${options.writers} --writes-per-writer ${options.writesPerWriter} --slo-ms ${options.sloMs} --drain-ms ${options.drainMs}${options.trace ? " --trace true" : ""}${options.idleMs ? ` --idle-ms ${options.idleMs}` : ""}${options.warmupMs ? ` --warmup-ms ${options.warmupMs}` : ""}${options.setupConcurrency ? ` --setup-concurrency ${options.setupConcurrency}` : ""} --output "$CAPACITY_OUTPUT"` };
}

/** Render a public-safe summary; paths, credentials, fixture identities and process logs are omitted. */
export function capacityMarkdown(report: Awaited<ReturnType<typeof runCapacity>>): string {
  const number = (value: number | null): string => value === null ? "missing" : value.toFixed(1);
  return `# Local collaboration capacity: ${report.date.slice(0, 10)}\n\n` +
    `Measured revision: \`${report.revision}\`. Node ${report.hardware.node}; ${report.hardware.logical_cpus} logical CPUs (${report.hardware.cpu_model}); ${(report.hardware.ram_bytes / 2 ** 30).toFixed(1)} GiB RAM. Platform/architecture: ${report.hardware.platform}/${report.hardware.arch}. Initial load average: ${report.hardware.load_average_before.map((n) => n.toFixed(2)).join(", ")}.\n\n` +
    `One production server, real test Postgres, one temporary project per rung, distinct authenticated subscriber identities. ${report.options.writers} concurrent writer lanes (${Math.floor(report.options.writers / 2)} HTTP, ${Math.ceil(report.options.writers / 2)} separate pinned pm processes), ${report.options.writesPerWriter} writes per lane. SLO: ${report.options.sloMs} ms; final duplicate/loss observation window: ${report.options.drainMs} ms.\n\n` +
    "| Subscribers | Committed writes | To all p50 ms | p95 ms | p99 ms | Max ms | Lost | Duplicates | RSS MiB | CPU p95 % core | Loop p99 ms | PG server/DB | Result |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|\n" +
    report.runs.map((run) => `| ${run.subscribers} | ${run.committed_writes}/${run.writes} | ${number(run.to_every_subscriber_ms.p50)} | ${number(run.to_every_subscriber_ms.p95)} | ${number(run.to_every_subscriber_ms.p99)} | ${number(run.to_every_subscriber_ms.max)} | ${run.lost} | ${run.duplicates} | ${(run.resources.server_rss_peak_bytes / 2 ** 20).toFixed(1)} | ${number(run.resources.server_cpu_core_percent.p95)} | ${number(run.resources.server_event_loop_p99_ms)} | ${run.resources.postgres_server_connections_peak}/${run.resources.postgres_database_connections_peak} | ${run.passed ? "PASS" : "STOP"} |`).join("\n") +
    "\n\nIdle successful server index-lock acquisitions (zero writers, after baseline):\n\n| Subscribers | Acquisitions | Seconds | Locks/sec |\n|---:|---:|---:|---:|\n" +
    report.runs.filter((run) => run.idle_index_locks !== null).map((run) => `| ${run.subscribers} | ${run.idle_index_locks!.acquisitions} | ${(run.idle_index_locks!.elapsed_ms / 1000).toFixed(2)} | ${run.idle_index_locks!.acquisitions_per_second.toFixed(3)} |`).join("\n") +
    "\n\nHealth counter snapshots (before → after writes):\n\n| Subscribers | Connections | Disconnections | Broadcasts | Watcher changes/errors | Last sweep ms |\n|---:|:---|:---|:---|:---|---:|\n" +
    report.runs.map((run) => `| ${run.subscribers} | ${run.health_before.realtime.sse_connections_total} → ${run.health_after.realtime.sse_connections_total} | ${run.health_before.realtime.sse_disconnections_total} → ${run.health_after.realtime.sse_disconnections_total} | ${run.health_before.realtime.broadcasts_total} → ${run.health_after.realtime.broadcasts_total} | ${run.health_before.realtime.watcher_changes_total}/${run.health_before.realtime.watcher_errors_total} → ${run.health_after.realtime.watcher_changes_total}/${run.health_after.realtime.watcher_errors_total} | ${run.health_after.realtime.watcher_last_sweep_ms ?? "missing"} |`).join("\n") +
    report.runs.filter((run) => run.stages).map((run) => "\n\nStage attribution (test-only probes, milliseconds):\n\n| Subscribers | Origin | Stage | Samples | p50 ms | p99 ms |\n|---:|:---|:---|---:|---:|---:|\n" +
      Object.entries(run.stages!).flatMap(([transport, stages]) => Object.entries(stages).map(([stage, values]) => `| ${run.subscribers} | ${transport} | ${stage} | ${values.samples} | ${number(values.p50)} | ${number(values.p99)} |`)).join("\n")).join("") +
    `\n\nFirst observed limit: ${report.failure ? `inconclusive at ${report.failure.subscribers} subscribers (${report.failure.reason}; ${report.failure.error_name}${report.failure.error_code ? ` ${report.failure.error_code}` : ""})` : report.runs.find((run) => !run.passed)?.first_observed_limit ?? "none at the tested rungs"}. ${report.stopped_early ? "Ladder stopped early." : "All requested rungs completed."}\n\n` +
    "Exact command (set CAPACITY_OUTPUT to an external report prefix and DATABASE_URL to the disposable test database):\n\n```sh\n" + report.command + "\n```\n\n" +
    "The CLI builds with npm run build before starting dist/server.js. Production watcher and LISTEN/NOTIFY defaults remain enabled. Read/write rate limits are 100000/minute, as in the integration harness, because all clients share loopback. Child environments exclude ambient provider credentials/configuration. Latency begins at the authoritative committed history entry's millisecond mutation timestamp (includes persistence after timestamp assignment), never at HTTP acknowledgement or CLI exit. The table measures each write's last first-delivery across all subscribers; incomplete writes are excluded from latency quantiles and counted as loss. JSON also contains all subscriber/write-pair and per-transport quantiles, per-subscriber missing sequences/duplicates, and before/after health counters. Generic workspace invalidations do not count as item delivery.\n\n" +
    "This is a finite local experiment with co-located server, writers and readers, fresh small trackers and continuously draining clients. It does not establish sustained throughput, slow-reader buffer bounds, proxy/browser behavior, multiple server instances, reconnect replay, large-project costs, actual pm-gpt/MCP execution, or hosted-stack capacity. The bus is enabled; cross-instance fanout is not exercised. CPU percentages refer to one core. RSS is sampled, not a memory bound. An unobserved bottleneck remains unidentified.\n";
}

/** Build the production artifact, then write reports outside the repository unless explicitly selected. */
async function main(): Promise<void> {
  const options = capacityOptions(process.argv.slice(2));
  const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) throw new Error("Production build failed");
  const report = await runCapacity({ rungs: options.rungs, writers: options.writers, writesPerWriter: options.writesPerWriter, sloMs: options.sloMs, drainMs: options.drainMs, trace: options.trace, idleMs: options.idleMs });
  const prefix = options.output ?? path.join(await mkdtemp(path.join(tmpdir(), "pm-web-capacity-report-")), "capacity");
  await mkdir(path.dirname(prefix), { recursive: true });
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(`${prefix}.md`, capacityMarkdown(report), { flag: "wx" });
  process.stdout.write(`Capacity reports: ${prefix}.json and ${prefix}.md\n`);
  if (report.failure || report.runs.some((run) => !run.passed)) process.exitCode = 1;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  main().catch(() => { console.error("Capacity run failed; check the disposable test database, production build and local resource availability."); process.exitCode = 1; });
}
