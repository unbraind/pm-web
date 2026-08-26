import type { RequestHandler } from "express";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Minimum structural type a PostgreSQL pool must satisfy for the health probe.
 *
 * The real `pg.Pool` satisfies this, and tests can substitute any object whose
 * `query` accepts a SQL string and returns a promise — so the probe runs
 * through the same pool the service uses in production without forcing tests
 * to construct a real database connection.
 */
export interface Queryable {
  /** Execute a SQL string and return rows. */
  query(text: string): Promise<{ rows: unknown[] }>;
}

/** Status reported for one dependency in the health response. */
export interface DependencyStatus {
  /** Whether the dependency responded successfully. */
  readonly ok: boolean;
  /** Round-trip latency in milliseconds. */
  readonly latency_ms: number;
  /** Human-readable failure reason; omitted on success. */
  readonly error?: string;
  /**
   * Whether the dependency was configured (env var present). Only meaningful
   * for soft dependencies that may legitimately be absent; hard dependencies
   * are always treated as configured.
   */
  readonly configured?: boolean;
}

/** A named soft-dependency probe whose result does not affect the status code. */
export interface SoftProbe {
  /** Key under `dependencies` in the response. */
  readonly name: string;
  /** Async function returning the dependency status. */
  readonly probe: () => Promise<DependencyStatus>;
}

/** Dependencies the health handler needs to probe. */
export interface HealthProbeDeps {
  /** PostgreSQL pool — probed with `SELECT 1` (hard dependency). */
  readonly pool: Queryable;
  /** Host-mounted projects root — probed for writability (hard dependency). */
  readonly projectsRoot: string;
  /** Package version, resolved once at boot from `package.json`. */
  readonly version: string;
  /** Soft-dependency probes; their results are reported but never cause 503. */
  readonly softProbes?: ReadonlyArray<SoftProbe>;
}

/** Shape of the `/healthz` response body (backward compatible: `ok`, `version`). */
export interface HealthResult {
  /** `true` only when every hard dependency is reachable. */
  readonly ok: boolean;
  /** Package version from `package.json`. */
  readonly version: string;
  /** Per-dependency breakdown. */
  readonly dependencies: Readonly<Record<string, DependencyStatus>>;
}

/** Maximum time a single probe may run before it is considered failed. */
const PROBE_TIMEOUT_MS = 2000;
/** How long a computed health result is reused before re-probing. */
const CACHE_TTL_MS = 5000;

/** Extract a string message from an unknown rejection value. */
function errorMessage(error: unknown): string {
  // `/healthz` is unauthenticated, so the response must never carry a raw
  // message: a pg failure names the host, port, database and user, and a
  // filesystem failure names the projects-root path. Both are reconnaissance
  // for an anonymous caller. Map to a stable category and keep the detail in
  // the server log, where an operator can still read it.
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);

  console.error("[healthz] probe failed", { code, message });

  if (message === "probe timed out") return "timed out";
  if (code === "ENOENT") return "not found";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permission denied";
  if (code === "ENOSPC") return "no space left on device";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
    return "unreachable";
  }
  return "unavailable";
}

/**
 * Race a promise against a timeout, rejecting with `"probe timed out"` if the
 * timeout fires first.
 *
 * The timer is cleared in both branches so a resolved/rejected probe does not
 * leak a dangling timer, and a timed-out probe does not keep the event loop
 * alive for the remaining lifetime of the underlying promise.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Probe PostgreSQL by running `SELECT 1` through the provided queryable.
 *
 * Uses the service's real pool (not a fresh connection) so pool exhaustion is
 * itself a failure mode the probe catches. The probe is bounded by
 * {@link PROBE_TIMEOUT_MS}.
 */
async function probePostgres(pool: Queryable): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    await withTimeout(pool.query("SELECT 1"), PROBE_TIMEOUT_MS);
    return { ok: true, latency_ms: Date.now() - start };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - start, error: errorMessage(error) };
  }
}

/**
 * Probe the projects root by writing and immediately removing a temp file
 * inside it.
 *
 * A missing directory, a read-only host mount, or a full disk all surface as
 * a write or unlink failure. The temp file is cleaned up in every path: on
 * success it is unlinked by the probe itself, and on failure a best-effort
 * cleanup removes it if the write succeeded but the unlink (or timeout) did
 * not.
 */
async function probeProjectsRoot(root: string): Promise<DependencyStatus> {
  const start = Date.now();
  // A pid-and-millisecond name collides when two uncached probes start in the
  // same millisecond: whichever unlinks first makes the other report ENOENT and
  // return a spurious 503 for a perfectly healthy volume.
  const probeFile = path.join(root, `.healthz-${randomUUID()}.tmp`);
  try {
    await withTimeout(
      (async () => {
        await writeFile(probeFile, "");
        await unlink(probeFile);
      })(),
      PROBE_TIMEOUT_MS,
    );
    return { ok: true, latency_ms: Date.now() - start };
  } catch (error) {
    // Best-effort cleanup: if the write succeeded but the unlink or the
    // timeout fired first, try to remove the probe file so none is left behind.
    try { await unlink(probeFile); } catch { /* already gone or never created */ }
    return { ok: false, latency_ms: Date.now() - start, error: errorMessage(error) };
  }
}

/**
 * Run a soft-dependency probe, catching any synchronous throw, rejection, or
 * timeout so a broken soft probe can never throw into the health handler.
 */
async function runSoftProbe(probe: SoftProbe): Promise<[string, DependencyStatus]> {
  try {
    const status = await withTimeout(probe.probe(), PROBE_TIMEOUT_MS);
    return [probe.name, status];
  } catch (error) {
    return [probe.name, { ok: false, latency_ms: 0, error: errorMessage(error) }];
  }
}

/**
 * Build the Express `/healthz` request handler.
 *
 * The handler probes every hard dependency in parallel, adds soft-dependency
 * results, caches the outcome for {@link CACHE_TTL_MS} milliseconds, and
 * responds with HTTP 200 (`ok: true`) or 503 (`ok: false`). It never throws:
 * each probe catches its own errors, and the outer `try`/`catch` is a
 * defensive last resort.
 */
export function createHealthHandler(deps: HealthProbeDeps): RequestHandler {
  let cached: { result: HealthResult; at: number } | null = null;
  // Concurrent cache misses must share ONE computation. `withTimeout` rejects
  // its wrapper but cannot cancel the underlying `pool.query`, so without this
  // every request during a hung database starts another query that keeps
  // running after the endpoint has already answered 503 - consuming pool
  // capacity and starving the ordinary API. Single-flight bounds the damage to
  // one in-flight probe no matter how often the endpoint is polled.
  let inFlight: Promise<HealthResult> | null = null;

  /**
   * Probe every dependency once and cache the outcome.
   *
   * Separated from the handler so concurrent cache misses can await a single
   * shared promise rather than each starting their own probe round.
   *
   * @returns The freshly computed health result, already written to the cache.
   */
  async function compute(): Promise<HealthResult> {
    let result: HealthResult;
    try {
      const [postgres, projectsRootStatus, ...softResults] = await Promise.all([
        probePostgres(deps.pool),
        probeProjectsRoot(deps.projectsRoot),
        ...(deps.softProbes?.map(runSoftProbe) ?? []),
      ]);

      const dependencies: Record<string, DependencyStatus> = {
        postgres,
        projects_root: projectsRootStatus,
      };

      for (const [name, status] of softResults) {
        dependencies[name] = status;
      }

      result = {
        ok: postgres.ok && projectsRootStatus.ok,
        version: deps.version,
        dependencies,
      };
    } catch {
      // Every probe catches its own errors; this is a defensive last resort
      // so the handler can never throw an unhandled error into Express.
      result = {
        ok: false,
        version: deps.version,
        dependencies: {
          postgres: { ok: false, latency_ms: 0, error: "unexpected handler error" },
          projects_root: { ok: false, latency_ms: 0, error: "unexpected handler error" },
        },
      };
    }

    cached = { result, at: Date.now() };
    return result;
  }

  const handler: RequestHandler = async (_req, res) => {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      res.status(cached.result.ok ? 200 : 503).json(cached.result);
      return;
    }

    inFlight ??= compute().finally(() => { inFlight = null; });
    const result = await inFlight;
    res.status(result.ok ? 200 : 503).json(result);
  };

  return handler;
}