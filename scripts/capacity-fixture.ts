/** Real database, pinned CLI and built-server lifecycle for the isolated capacity experiment. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import jwt from "jsonwebtoken";
import { getPmClient, evictPmClient } from "../src/services/pm-runner.ts";
import type { FanoutMeasurement } from "./capacity-fanout-probe.ts";
import type { RealtimeCounters } from "../src/services/realtime-observability.ts";

const execute = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");

/** Bound asynchronous lifecycle waits without polling outside the experiment. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      const codes: Record<string, string> = { "SSE connected frame": "SSE_CONNECTED_TIMEOUT", "complete project presence snapshot": "SSE_PRESENCE_TIMEOUT",
        "production server startup": "SERVER_STARTUP_TIMEOUT", "database sample completion": "DATABASE_SAMPLE_TIMEOUT", "database cleanup": "DATABASE_CLEANUP_TIMEOUT" };
      throw Object.assign(new Error(`Capacity timeout: ${label}`), { code: codes[label] ?? "CAPACITY_WAIT_TIMEOUT" });
    }
    await delay(20);
  }
}

/** Remove inherited routing, provider credentials and measurement instrumentation from experiment children. */
export function capacityEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "ComSpec", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"]) env[key] = process.env[key];
  env.HOME = root;
  env.USERPROFILE = root;
  env.XDG_CONFIG_HOME = path.join(root, ".config");
  env.PM_AUTHOR = "capacity-synthetic";
  env.PM_TELEMETRY_DISABLED = "1";
  return env;
}

/** Execute the repo-pinned pm in a separate OS process, exclusively inside a temporary project. */
export async function capacityPm(dir: string, args: string[], traceDirectory?: string): Promise<void> {
  const target = args[0] === "workspace" ? [] : ["--pm-path", path.join(dir, ".agents", "pm")];
  const preload = traceDirectory ? ["--import", path.join(repo, "scripts/capacity-trace-preload.ts")] : [];
  const env = capacityEnvironment(dir);
  if (traceDirectory) {
    env.PM_WEB_CAPACITY_TRACE_DIR = traceDirectory;
    if (args[0] === "update") env.PM_WEB_CAPACITY_TRACE_WRITER_ITEM = args[1];
  }
  await execute(process.execPath, [...preload, path.join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js"),
    ...target, "--no-extensions", ...args], { cwd: dir, env, timeout: 20_000, maxBuffer: 1024 * 1024 });
}

/** Signed sessions use the same cookie and double-submit CSRF contract as the real-Postgres tests. */
function session(userId: string, secret: string): Record<string, string> {
  const token = jwt.sign({ userId, email: `${userId}@capacity.test` }, secret, { expiresIn: "1h" });
  return { cookie: `pm_token=${token}; csrf_token=capacity-csrf`, "x-csrf-token": "capacity-csrf" };
}

/** Seed only uniquely owned rows in the existing disposable test database and a fresh temporary root. */
export async function capacityFixture(identities: number) {
  if (!process.env.DATABASE_URL) throw new Error("Use scripts/with-test-db.ts to select the disposable test database");
  const database = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: "capacity-observer", connectionTimeoutMillis: 5000, query_timeout: 5000 });
  await database.connect();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-capacity-projects-"));
  const owner = randomUUID();
  const users = Array.from({ length: identities }, () => randomUUID());
  const projectId = randomUUID();
  const secret = randomUUID() + randomUUID();
  const dir = path.join(root, owner, "capacity");
  /** Delete only the fixture-owned identities, cascading its projects and shares. */
  const close = async (): Promise<void> => {
    evictPmClient(path.join(dir, ".agents", "pm"));
    await database.end();
    // Large FK cascades need a cleanup budget independent of five-second resource probes.
    const cleanup = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: "capacity-cleanup",
      connectionTimeoutMillis: 5000, statement_timeout: 60_000, query_timeout: 65_000 });
    try {
      await cleanup.connect();
      await cleanup.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner, ...users]]);
    } catch (cause) {
      throw Object.assign(new Error("Synthetic fixture row cleanup failed", { cause }), { code: "FIXTURE_ROWS_CLEANUP_FAILED" });
    } finally { await cleanup.end(); }
    // Failed row cleanup deliberately retains the ownership receipt and tracker.
    await rm(root, { recursive: true, force: true });
  };
  try {
    // Preserve exact synthetic ownership for recovery if cleanup cannot complete.
    await writeFile(path.join(root, "capacity-ownership.json"), JSON.stringify({ projectId, users: [owner, ...users] }), { mode: 0o600 });
    await database.query("INSERT INTO pm_users (id, email, password_hash) SELECT id, id::text || '@capacity.test', 'x' FROM unnest($1::uuid[]) AS id", [[owner, ...users]]);
    await database.query("INSERT INTO pm_projects (id, user_id, name, slug, prefix) VALUES ($1, $2, 'Capacity', 'capacity', 'capacity')", [projectId, owner]);
    await database.query("INSERT INTO pm_project_shares (project_id, shared_with_user_id, permission) SELECT $1, id, 'edit' FROM unnest($2::uuid[]) AS id", [projectId, users]);
    await mkdir(dir, { recursive: true });
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "capacity", "--defaults", "--agent-guidance", "skip"]);
    return { root, dir, projectId, secret, database, sessions: users.map((id) => session(id, secret)),
      client: getPmClient(path.join(dir, ".agents", "pm")), close };
  } catch (error) { await close(); throw error; }
}

/** A process sample read from the preload, with CPU expressed as percent of one core. */
export interface CapacityProbe {
  fanout: FanoutMeasurement;
  cpu_since_reset_us: number;
  cpu_window_ms: number;
  rss_bytes: number;
  cpu_core_percent: number;
  event_loop_p99_ms: number;
}

/** Stop the owned child with a bounded grace period, including failed startup. */
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

/** Start dist/server.js with production defaults; the preload adds no public endpoint or route seam. */
export async function capacityServer(root: string, secret: string, traceDirectory?: string) {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  const applicationName = `capacity-server-${randomUUID()}`;
  databaseUrl.searchParams.set("application_name", applicationName);
  const env = { ...capacityEnvironment(root), DATABASE_URL: databaseUrl.href, JWT_SECRET: secret,
    NODE_ENV: "production", PORT: "0", PROJECTS_ROOT: root, LOG_LEVEL: "info",
    // All sockets originate at loopback; match the integration wrapper's tiers rather than
    // measuring the single-IP abuse limit as if it were thousands of independent clients.
    PM_WEB_RATE_LIMIT_READ: "100000", PM_WEB_RATE_LIMIT_WRITE: "100000" };
  const preload = traceDirectory ? ["--import", path.join(repo, "scripts/capacity-trace-preload.ts")] : [];
  const child = spawn(process.execPath, ["--import", path.join(repo, "scripts/capacity-probe.ts"), ...preload, "dist/server.js"], {
    cwd: repo, env: { ...env, ...(process.env.PM_WEB_CAPACITY_BASELINE_DIR ? { PM_WEB_CAPACITY_BASELINE_DIR: process.env.PM_WEB_CAPACITY_BASELINE_DIR } : {}), ...(traceDirectory ? { PM_WEB_CAPACITY_TRACE_DIR: traceDirectory } : {}) }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let port = 0;
  let pending = "";
  let reset = false;
  let failed = false;
  let traceFlushed = false;
  let lockSnapshot: { count: number; at: number } | undefined;
  const samples: CapacityProbe[] = [];
  const errors: Record<string, number> = {};
  child.on("error", () => { failed = true; });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    pending += chunk;
    let end = pending.indexOf("\n");
    while (end >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.event === "server_started" && typeof record.port === "number") port = record.port;
        if (typeof record.event === "string" && ["mutation_watcher_error", "watcher_error", "realtime_listener_disconnected", "unhandled_error"].includes(record.event)) errors[record.event] = (errors[record.event] ?? 0) + 1;
      } catch { /* Non-JSON dependency diagnostics are drained, never retained in a public report. */ }
      end = pending.indexOf("\n");
    }
    if (pending.length > 65536) pending = "";
  });
  child.stderr!.resume();
  child.on("message", (message: unknown) => {
    const record = message as Partial<CapacityProbe> & { capacity_probe?: boolean; capacity_reset?: boolean; capacity_trace_flushed?: boolean; capacity_lock_count?: number; at?: number };
    if (typeof record.capacity_lock_count === "number" && typeof record.at === "number") lockSnapshot = { count: record.capacity_lock_count, at: record.at };
    if (record.capacity_trace_flushed) traceFlushed = true;
    if (record.capacity_reset) { reset = true; samples.length = 0; }
    if (record.capacity_probe && typeof record.rss_bytes === "number" && typeof record.cpu_core_percent === "number" && typeof record.event_loop_p99_ms === "number") samples.push(record as CapacityProbe);
  });
  /** Read fresh aggregate health counters from the running production endpoint. */
  const health = async (): Promise<{ ok: boolean; realtime: RealtimeCounters }> => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
    return await response.json() as { ok: boolean; realtime: RealtimeCounters };
  };
  try {
    await waitUntil(() => port > 0 || failed || child.exitCode !== null || child.signalCode !== null, 20_000, "production server startup");
    if (!port || failed) throw new Error("Production server failed to start");
    return { url: `http://127.0.0.1:${port}`, applicationName, samples, errors, health,
      /** Snapshot successful server index-lock acquisitions through private test IPC. */
      lockCount: async () => { lockSnapshot = undefined; child.send("capacity-lock-count"); await waitUntil(() => lockSnapshot !== undefined, 5000, "lock snapshot"); return lockSnapshot!; },
      /** Reset the server histogram at the start of the measured write phase. */
      begin: async () => { reset = false; child.send("capacity-reset"); await waitUntil(() => reset, 2000, "probe reset"); },
      /** Flush stage probes only after measured writes and receipts finish. */
      flushTrace: async () => { if (traceDirectory) { child.send("capacity-trace-flush"); await waitUntil(() => traceFlushed, 5000, "trace flush"); } },
      /** Obtain a final sample through acknowledged IPC rather than a periodic-sample race. */
      sample: async () => { const count = samples.length; child.send("capacity-sample"); await waitUntil(() => samples.length > count, 5000, "final process sample"); },
      /** Expose only this owned child's exit state for public-safe setup diagnostics. */
      exitState: () => ({ code: child.exitCode, signal: child.signalCode }),
      close: () => stopServer(child) };
  } catch (error) { await stopServer(child); throw error; }
}
