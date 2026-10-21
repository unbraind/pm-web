/** Ordinary authenticated join bursts using the existing disposable capacity fixtures and readers. */
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { capacityFixture, capacityServer } from "./capacity-fixture.ts";
import { createCapacityClients, type CapacityClientGroup } from "./capacity-clients.ts";
import { distribution } from "./capacity-metrics.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Join workload limits; no setup interception or production resource overrides are available. */
export interface JoinStormOptions { subscribers: number; burst: number; readinessMs: number }

/** Exercise readiness throughout connection admission and full-roster convergence, including failed attempts. */
export async function runJoinStorm(options: JoinStormOptions) {
  const { subscribers, burst, readinessMs } = options;
  if (!Number.isInteger(subscribers) || subscribers < 1 || subscribers > 3000 || !Number.isInteger(burst) || burst < 1 || burst > 1000 || !Number.isInteger(readinessMs) || readinessMs < 1 || readinessMs > 5000) throw new Error("Invalid join storm bounds");
  const fixture = await capacityFixture(subscribers);
  let server: Awaited<ReturnType<typeof capacityServer>> | undefined;
  const groups: CapacityClientGroup[] = [];
  const readiness: { ms: number; status: number; ok: boolean }[] = [];
  const populations: number[] = [];
  const dependencyFailures: Record<string, number> = {};
  let polling: Promise<void> | undefined;
  const pollingStop = new AbortController();
  let failure: string | null = null;
  let report: { passed: boolean; cleanup_failure: string | null } | undefined;
  const started = performance.now();
  const initialLoad = loadavg();
  try {
    server = await capacityServer(fixture.root, fixture.secret);
    polling = (async () => {
      while (!pollingStop.signal.aborted) {
        const at = performance.now();
        try {
          const response = await fetch(`${server!.url}/healthz`, { signal: AbortSignal.timeout(readinessMs) });
          const body = await response.json() as { ok?: boolean; dependencies?: Record<string, { ok: boolean; error?: string }> };
          for (const [name, dependency] of Object.entries(body.dependencies ?? {})) if (!dependency.ok) {
            const key = `${name}:${dependency.error ?? "unhealthy"}`;
            dependencyFailures[key] = (dependencyFailures[key] ?? 0) + 1;
          }
          readiness.push({ ms: performance.now() - at, status: response.status, ok: response.ok && body.ok === true });
        } catch { readiness.push({ ms: performance.now() - at, status: 0, ok: false }); }
        await delay(100);
      }
    })();
    const clients = createCapacityClients({ url: `${server.url}/api/projects/${fixture.projectId}/pm/events`, sessions: fixture.sessions,
      indices: [], writes: 0, population: subscribers, concurrency: burst, perWorker: 750, manualJoin: true, startupMs: 15_000, presenceMs: 45_000 });
    groups.push(clients);
    await clients.ready;
    while (clients.opened() < subscribers) {
      await clients.join();
      populations.push(clients.opened());
      // Separate bursts without waiting for a roster: ordinary joins remain active throughout setup.
      await delay(100);
    }
    await Promise.all(groups.map((group) => group.presence()));
    // Include a fresh dependency-probe cache cycle after the final roster.
    await delay(2500);
  } catch (error) {
    failure = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.name : "unknown";
  } finally {
    pollingStop.abort();
    await polling;
  }
  try {
    const captureFailures: string[] = [];
    await server?.sample().catch(() => { captureFailures.push("SERVER_SAMPLE_FAILED"); });
    const states = (await Promise.all(groups.map((group) => group.snapshot().catch(() => { captureFailures.push("READER_SNAPSHOT_FAILED"); return []; })))).flat();
    const samples = server?.samples ?? [];
    const disconnected = states.filter((state) => state.disconnected).length;
    const complete = states.filter((state) => state.presenceUsers === subscribers).length;
    const result = { options, failure, capture_failures: captureFailures, cleanup_failure: null as string | null,
      elapsed_ms: performance.now() - started, populations, opened: states.length, disconnected,
      complete_rosters: complete, readiness: { samples: readiness.length, failed: readiness.filter((sample) => !sample.ok).length,
        latency_ms: distribution(readiness.map((sample) => sample.ms)), dependency_failures: dependencyFailures,
        statuses: readiness.reduce<Record<string, number>>((counts, sample) => { counts[sample.status] = (counts[sample.status] ?? 0) + 1; return counts; }, {}) },
      resources: { rss_peak_bytes: samples.length ? Math.max(...samples.map((sample) => sample.rss_bytes)) : null,
        event_loop_p99_ms: samples.at(-1)?.event_loop_p99_ms ?? null, cpu_core_percent: distribution(samples.map((sample) => sample.cpu_core_percent)),
        fanout: samples.at(-1)?.fanout ?? null, load_before: initialLoad, load_after: loadavg(), logical_cpus: cpus().length },
      passed: failure === null && captureFailures.length === 0 && samples.length > 0 && states.length === subscribers && complete === subscribers && disconnected === 0 && readiness.length > 0 && readiness.every((sample) => sample.ok && sample.ms <= readinessMs) };
    report = result;
    return result;
  } finally {
    const readerCleanup = await Promise.allSettled(groups.map((group) => group.close()));
    const serverCleanup = await Promise.allSettled([server?.close()]);
    const fixtureCleanup = await Promise.allSettled([fixture.close()]);
    if ([...readerCleanup, ...serverCleanup, ...fixtureCleanup].some((result) => result.status === "rejected")) {
      if (report) { report.cleanup_failure = "OWNED_FIXTURE_CLEANUP_FAILED"; report.passed = false; }
      else console.error("Owned fixture cleanup failed during incomplete resource capture");
    }
  }
}

/** Write only aggregate synthetic evidence; the caller selects a fresh external output prefix. */
async function main(): Promise<void> {
  const output = process.argv[2] ?? path.join(await mkdtemp(path.join(tmpdir(), "pm-web-joinstorm-")), "report");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(`${output}.jsonl`, "", { flag: "wx" });
  const runtimeHashes = Object.fromEntries(await Promise.all(["dist/routes/pm.js", "dist/services/sse.js", "dist/services/sse-fanout.js", "dist/services/sse-admission.js"].map(async (file) => [file, await readFile(file).then((contents) => createHash("sha256").update(contents).digest("hex")).catch(() => null)])));
  const runs = [];
  for (const burst of (process.argv[3] ?? "100,500,1000").split(",").map(Number)) {
    const options = { subscribers: 3000, burst, readinessMs: 2000 };
    const run = { runtime_sha256: runtimeHashes, ...await runJoinStorm(options).catch(() => ({ options, failure: "setup or resource capture failed; inconclusive", passed: false })) };
    runs.push(run);
    await appendFile(`${output}.jsonl`, JSON.stringify(run) + "\n");
    console.log(JSON.stringify(run));
  }
  await writeFile(`${output}.json`, JSON.stringify({ date: new Date().toISOString(), runs }, null, 2) + "\n", { flag: "wx" });
  if (runs.some((run) => !run.passed)) process.exitCode = 1;
}

if (isMainInvocation(process.argv, import.meta.url)) await main();
