import type { RequestHandler } from "express";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
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
  /**
   * Timing overrides, in milliseconds.
   *
   * Production never sets these. They exist because the behaviour that matters
   * here -- what happens on the second cooldown expiry of a stall that has not
   * ended -- is otherwise only reachable by a test that waits over half a
   * minute, and a guard nothing executes is how a pool-drain protection stops
   * working without anyone noticing.
   */
  readonly timing?: {
    /** Overrides {@link PROBE_TIMEOUT_MS}. */
    readonly probeTimeoutMs?: number;
    /** Overrides {@link CACHE_TTL_MS}. */
    readonly cacheTtlMs?: number;
    /** Overrides {@link POOL_COOLDOWN_MS}. */
    readonly poolCooldownMs?: number;
  };
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

/**
 * How long to skip the PostgreSQL probe after one times out.
 *
 * A timed-out query keeps a pool client until the server answers. Re-probing
 * every cache expiry during a stall would drain the pool; this bounds it.
 */
const POOL_COOLDOWN_MS = 30_000;

/** How old a stray `.healthz-*.tmp` file must be before a sweep removes it. */
const STRAY_PROBE_MAX_AGE_MS = 60_000;

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
function probePostgres(
  pool: Queryable,
  timeoutMs: number,
): { query: Promise<unknown>; status: Promise<DependencyStatus> } {
  const start = Date.now();
  // The raw query is returned alongside the status because the two settle at
  // different times: the status settles when the timeout fires, the query only
  // when PostgreSQL answers, and it is the query that holds a pool client.
  // Anything deciding whether to start another probe has to wait on the query.
  const query = pool.query("SELECT 1");
  const status = withTimeout(query, timeoutMs).then(
    (): DependencyStatus => ({ ok: true, latency_ms: Date.now() - start }),
    (error: unknown): DependencyStatus =>
      ({ ok: false, latency_ms: Date.now() - start, error: errorMessage(error) }),
  );
  return { query, status };
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

  // Held so cleanup can be attached to the attempt's own settlement rather than
  // racing it. A timeout does not cancel the underlying write: unlinking
  // immediately can therefore run BEFORE a slow write lands, leaving the file
  // behind permanently - the opposite of what the cleanup is for.
  const attempt = (async () => {
    await writeFile(probeFile, "");
    await unlink(probeFile);
  })();

  try {
    await withTimeout(attempt, PROBE_TIMEOUT_MS);
    return { ok: true, latency_ms: Date.now() - start };
  } catch (error) {
    // NOT awaited, and bounded. A stalled mount is the exact condition that
    // reaches this path, and an unbounded `await unlink` here would never
    // settle: probeProjectsRoot would never resolve, the Promise.all in
    // compute() would never resolve, `inFlight` would never clear, and every
    // subsequent /healthz request would await the same pending promise forever
    // - serving nothing at all instead of 503.
    void attempt.catch(() => undefined).finally(() => {
      void withTimeout(unlink(probeFile), PROBE_TIMEOUT_MS).catch(() => undefined);
    });
    return { ok: false, latency_ms: Date.now() - start, error: errorMessage(error) };
  }
}

/**
 * Remove `.healthz-*.tmp` files older than {@link STRAY_PROBE_MAX_AGE_MS}.
 *
 * A probe whose write lands after its own cleanup has already run leaves a
 * stray file that nothing else will remove. Sweeping on each healthy probe
 * bounds how long such a file can persist, without ever failing the probe:
 * a sweep error is not a health signal and is deliberately swallowed.
 *
 * @param root - The projects root to sweep.
 */
async function sweepStrayProbeFiles(root: string): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await readdir(root)) {
      if (!name.startsWith(".healthz-") || !name.endsWith(".tmp")) continue;
      const full = path.join(root, name);
      const info = await stat(full);
      if (now - info.mtimeMs > STRAY_PROBE_MAX_AGE_MS) await unlink(full);
    }
  } catch {
    // Sweeping is housekeeping, not a dependency check.
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
  // Epoch ms of the last PostgreSQL probe timeout, or 0 if none has timed out.
  let lastPostgresTimeoutAt = 0;
  // A timed-out probe's query is still outstanding: `withTimeout` rejects its
  // wrapper, it cannot cancel `pool.query`. Elapsed time alone is therefore the
  // wrong condition to start another one -- during a prolonged stall the
  // cooldown expires on schedule while the previous client is still checked
  // out, and the pool drains one client per cooldown. This holds the query
  // itself, so at most one probe is ever outstanding however long the database
  // takes to answer.
  let outstandingPostgresProbe: Promise<unknown> | undefined;
  const probeTimeoutMs = deps.timing?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const cacheTtlMs = deps.timing?.cacheTtlMs ?? CACHE_TTL_MS;
  const poolCooldownMs = deps.timing?.poolCooldownMs ?? POOL_COOLDOWN_MS;

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
      // `withTimeout` rejects its wrapper but cannot cancel `pool.query`, so a
      // timed-out probe leaves a client checked out until PostgreSQL answers.
      // Without a cooldown, every cache expiry starts another one and a stalled
      // database drains the shared pool out from under the ordinary API. After
      // a timeout the probe is not retried for POOL_COOLDOWN_MS; the endpoint
      // keeps answering 503 from the reported status in the meantime.
      /**
       * Start one PostgreSQL probe and hold its query until PostgreSQL answers.
       *
       * @returns The probe's status.
       */
      const startPostgresProbe = (): Promise<DependencyStatus> => {
        const { query, status } = probePostgres(deps.pool, probeTimeoutMs);
        // Cleared when the QUERY settles, not when the status does. A timed-out
        // probe reports in milliseconds while its client stays checked out
        // until PostgreSQL answers, so clearing on the status would let the
        // next cooldown expiry check out another one on top of it.
        outstandingPostgresProbe = query;
        const release = (): void => {
          if (outstandingPostgresProbe === query) outstandingPostgresProbe = undefined;
        };
        void query.then(release, release);
        return status;
      };

      const cooling = Date.now() - lastPostgresTimeoutAt < poolCooldownMs;
      const outstanding = outstandingPostgresProbe !== undefined;
      const postgresProbe = cooling || outstanding
        ? Promise.resolve<DependencyStatus>({
            ok: false,
            latency_ms: 0,
            error: outstanding ? "previous probe still outstanding" : "probe cooling down after timeout",
          })
        : startPostgresProbe().then((status) => {
            // "timed out" is errorMessage()'s stable category, not the raw
            // message: /healthz is unauthenticated, so the raw text is
            // deliberately never surfaced. Matching the category is what makes
            // this survive a change to the underlying error string.
            if (!status.ok && status.error === "timed out") {
              lastPostgresTimeoutAt = Date.now();
            }
            return status;
          });

      const [postgres, projectsRootStatus, ...softResults] = await Promise.all([
        postgresProbe,
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

      if (projectsRootStatus.ok) void sweepStrayProbeFiles(deps.projectsRoot);

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
    if (cached && Date.now() - cached.at < cacheTtlMs) {
      res.status(cached.result.ok ? 200 : 503).json(cached.result);
      return;
    }

    inFlight ??= compute().finally(() => { inFlight = null; });
    const result = await inFlight;
    res.status(result.ok ? 200 : 503).json(result);
  };

  return handler;
}